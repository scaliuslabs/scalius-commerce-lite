// Product import: normalized items (from a Shopify or WooCommerce file, our
// own export, or an agent's JSON) written through the product editor's own
// services, so every rule the editor keeps (SKU identity, the option matrix,
// ledger-v2 stock edges at the default location, gift-card rules, catalog
// projections, cache dependencies) holds for imported products too.
//
// Matching, in order: the source store's handle (Shopify), the SKUs (global
// identity), then a WooCommerce product's derived handle with the same name.
// Modes:
// - create: new products only; a matched product is skipped, which is what
//   makes running the same file again a no-op.
// - upsert: creates new products and updates matched ones. An update changes
//   only what the file states: product fields, prices, costs per item,
//   barcodes, weights, new SKUs and option values. Nothing missing from the
//   file is removed (a blank cost keeps the SKU's cost),
//   stock of existing SKUs is left to inventory import, and an update that
//   changes nothing writes nothing (no revision bump).
// - price: only prices of SKUs found by SKU.
// A dry run reports the action and the aggregate revision it saw; the write
// can send that revision back and is refused if the product changed since.
//
// Each item is applied on its own (one failure never stops the batch). The
// batch stops early when its time budget runs out or the Worker reaches its
// query limit, and says how many items it processed so the caller sends the
// rest again.

import type { Database } from "@scalius/database/client";
import { products, productVariants } from "@scalius/database/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { detectBarcodeType } from "@scalius/shared/barcode-identity";
import { normalizeProductOptionIdentity } from "@scalius/shared/product-options";
import {
  compareAtDiscount,
  standardMappingsForOptions,
  type ProductImportBatch,
  type ProductImportItem,
  type ProductImportMode,
  type ProductImportVariant,
} from "@scalius/shared/store-transfer/products";
import { AppError } from "@scalius/core/errors";
import {
  createProduct,
  createProductSchema,
  getProductDetails,
  saveProductOptionMatrix,
  updateProduct,
  updateProductSchema,
  updateVariant,
} from "../product-admin";
import type { ProductWithDetails } from "../products";
import { type StoreCurrency } from "../settings";
import { readStoreCurrency } from "../markets";
import { ImportReferenceResolver, type ReferenceCreationRights, type ReferencePlan } from "./references";
import { ImportBudget, isWorkerLimitError } from "./budget";
import { effectivePrice, type StoredPricing } from "./pricing";
import { setSkuCosts, SKU_COST_BATCH_LIMIT, unitCostFromMinor, unitCostToMinor } from "../inventory";

export type ProductImportStatus =
  | "created"
  | "updated"
  | "unchanged"
  | "skipped"
  | "failed"
  | "would_create"
  | "would_update"
  | "would_skip";

export interface ProductImportIssue {
  code: string;
  message: string;
  /** The variant the issue is about (index into the item's variants). */
  variantIndex?: number;
  field?: string;
}

export interface ProductImportResult {
  ref: string;
  status: ProductImportStatus;
  productId: string | null;
  slug: string | null;
  /** The revision after the write, or the one a dry run saw. */
  aggregateRevision: number | null;
  issues: ProductImportIssue[];
}

export interface ProductImportResponse {
  results: ProductImportResult[];
  /** Items handled; send `items.slice(processed)` again when it is short. */
  processed: number;
  stoppedEarly: boolean;
  /** Dry run: brands, categories and attributes the write would create. */
  references: ReferencePlan;
  /** Facts that apply to the whole batch. */
  notes: string[];
}

export interface ProductImportContext {
  actorId?: string | null;
  budget?: ImportBudget;
  /** Brands, categories and attributes the importer may create (default: all). */
  rights?: ReferenceCreationRights;
}

type ProductMatch = {
  productId: string;
  slug: string;
  name: string;
  aggregateRevision: number;
  trashed: boolean;
  via: "handle" | "sku" | "name";
};

type SkuOwner = { sku: string; productId: string; slug: string; retired: boolean; productTrashed: boolean };

const skuKey = (sku: string) => sku.trim().toLocaleLowerCase("en-US");

class ItemError extends Error {
  constructor(readonly issue: ProductImportIssue) {
    super(issue.message);
  }
}

function issueFromError(error: unknown): ProductImportIssue {
  if (error instanceof ItemError) return error.issue;
  if (error instanceof AppError) {
    const details = error.details as { field?: unknown; reason?: unknown } | undefined;
    return {
      // A rule's own reason when it names one (e.g. digital_stock_is_keys).
      code: typeof details?.reason === "string" && details.reason ? details.reason : error.code.toLowerCase(),
      message: error.message,
      ...(typeof details?.field === "string" ? { field: details.field } : {}),
    };
  }
  return { code: "write_failed", message: error instanceof Error ? error.message : "The product could not be saved." };
}

// ── Matching ───────────────────────────────────────────────────────────────

async function readMatches(db: Database, items: readonly ProductImportItem[]): Promise<{
  bySlug: Map<string, ProductMatch>;
  byName: Map<string, ProductMatch[]>;
  skuOwners: Map<string, SkuOwner>;
}> {
  const handles = [...new Set(items.flatMap((item) => item.handle ? [item.handle] : []))];
  const names = [...new Set(items.filter((item) => !item.handleIsIdentity).map((item) => item.title.trim().toLowerCase()))];
  const skus = [...new Set(items.flatMap((item) => item.variants.flatMap((variant) => variant.sku ? [skuKey(variant.sku)] : [])))];
  const productColumns = {
    id: products.id,
    slug: products.slug,
    name: products.name,
    aggregateRevision: products.aggregateRevision,
    deletedAt: products.deletedAt,
  };
  const [slugRows, nameRows, skuRows] = await Promise.all([
    handles.length === 0 ? [] : db.select(productColumns).from(products)
      .where(sql`${products.slug} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(handles)}))`),
    names.length === 0 ? [] : db.select(productColumns).from(products)
      .where(and(
        sql`lower(trim(${products.name})) IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(names)}))`,
        isNull(products.deletedAt),
      )),
    skus.length === 0 ? [] : db.select({
      sku: productVariants.sku,
      productId: productVariants.productId,
      variantDeletedAt: productVariants.deletedAt,
      slug: products.slug,
      productDeletedAt: products.deletedAt,
    }).from(productVariants)
      .innerJoin(products, sql`${products.id} = ${productVariants.productId}`)
      .where(sql`lower(trim(${productVariants.sku})) IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(skus)}))`),
  ]);
  const toMatch = (row: (typeof slugRows)[number], via: ProductMatch["via"]): ProductMatch => ({
    productId: row.id,
    slug: row.slug,
    name: row.name,
    aggregateRevision: row.aggregateRevision,
    trashed: row.deletedAt !== null,
    via,
  });
  const byName = new Map<string, ProductMatch[]>();
  for (const row of nameRows) {
    const list = byName.get(row.name.trim().toLowerCase()) ?? [];
    list.push(toMatch(row, "name"));
    byName.set(row.name.trim().toLowerCase(), list);
  }
  return {
    bySlug: new Map(slugRows.map((row) => [row.slug, toMatch(row, "handle")])),
    byName,
    skuOwners: new Map(skuRows.map((row) => [skuKey(row.sku), {
      sku: row.sku,
      productId: row.productId,
      slug: row.slug,
      retired: row.variantDeletedAt !== null,
      productTrashed: row.productDeletedAt !== null,
    }])),
  };
}

type Resolution =
  | { kind: "new" }
  | { kind: "match"; match: ProductMatch }
  | { kind: "error"; issue: ProductImportIssue };

function resolveItem(
  item: ProductImportItem,
  mode: ProductImportMode,
  lookup: Awaited<ReturnType<typeof readMatches>>,
  revisions: Map<string, ProductMatch>,
): Resolution {
  const owners = item.variants.flatMap((variant, variantIndex) => {
    const owner = variant.sku ? lookup.skuOwners.get(skuKey(variant.sku)) : undefined;
    return owner ? [{ owner, variantIndex }] : [];
  });
  const handleMatch = item.handleIsIdentity && item.handle ? lookup.bySlug.get(item.handle) : undefined;
  const ownerIds = new Set(owners.map(({ owner }) => owner.productId));
  let match: ProductMatch | undefined = handleMatch;
  if (mode === "price") {
    // Unknown SKUs are reported as skipped by the caller.
    if (ownerIds.size === 0) return { kind: "new" };
    if (ownerIds.size > 1) return { kind: "error", issue: { code: "sku_owners_differ", message: "These SKUs belong to more than one product." } };
    const owner = owners[0]!.owner;
    return { kind: "match", match: revisions.get(owner.productId) ?? { productId: owner.productId, slug: owner.slug, name: "", aggregateRevision: 0, trashed: owner.productTrashed, via: "sku" } };
  }
  if (match) {
    const foreign = owners.find(({ owner }) => owner.productId !== match!.productId);
    if (foreign) {
      return {
        kind: "error",
        issue: {
          code: "sku_taken",
          message: `SKU ${foreign.owner.sku} belongs to another product (/products/${foreign.owner.slug}).`,
          variantIndex: foreign.variantIndex,
          field: "sku",
        },
      };
    }
  } else if (ownerIds.size > 1) {
    return { kind: "error", issue: { code: "sku_owners_differ", message: "These SKUs belong to more than one existing product." } };
  } else if (ownerIds.size === 1) {
    const owner = owners[0]!.owner;
    match = revisions.get(owner.productId) ?? { productId: owner.productId, slug: owner.slug, name: "", aggregateRevision: 0, trashed: owner.productTrashed, via: "sku" };
  } else if (!item.handleIsIdentity) {
    // A derived handle can be taken by another product: match the same name
    // on that handle or its numbered twins (name-2, name-3 …).
    const base = item.handle;
    const candidates = (lookup.byName.get(item.title.trim().toLowerCase()) ?? [])
      .filter((candidate) => !base || candidate.slug === base || candidate.slug.startsWith(`${base}-`));
    if (candidates.length === 1) match = candidates[0];
    else if (candidates.length > 1) {
      return { kind: "error", issue: { code: "name_ambiguous", message: `More than one product is named "${item.title}". Add SKUs to the file so each row matches one product.` } };
    }
  }
  if (!match) return { kind: "new" };
  if (match.trashed) {
    return { kind: "error", issue: { code: "product_in_trash", message: `A product with this ${match.via === "handle" ? "handle" : "SKU"} is in trash. Restore or delete it, then import again.` } };
  }
  const retired = owners.find(({ owner }) => owner.retired && owner.productId === match!.productId);
  if (retired && mode !== "create") {
    return { kind: "error", issue: { code: "sku_retired", message: `SKU ${retired.owner.sku} was removed from this product. Restore it in the product editor or use another SKU.`, variantIndex: retired.variantIndex, field: "sku" } };
  }
  return { kind: "match", match };
}

// ── Create ─────────────────────────────────────────────────────────────────

/**
 * Shopify's "Requires shipping: FALSE" (and WooCommerce's virtual or
 * downloadable) is how both mark a digital product, so a row that ships
 * nothing becomes a digital product (its files are added in the product's
 * Digital delivery card), unless the file says it is a service.
 */
function fulfillmentKindFor(variant: ProductImportVariant): "physical" | "digital" | "service" {
  return variant.requiresShipping ? "physical" : variant.nonShippingKind ?? "digital";
}

function barcodeFields(barcode: string | null) {
  return barcode ? { barcode, barcodeType: detectBarcodeType(barcode) } : { barcode: null, barcodeType: null };
}

async function resolveAttributes(
  references: ImportReferenceResolver,
  item: ProductImportItem,
  warnings: ProductImportIssue[],
): Promise<Array<{ attributeId: string; value: string }>> {
  const assigned: Array<{ attributeId: string; value: string }> = [];
  for (const attribute of item.attributes) {
    try {
      const attributeId = await references.attribute(attribute.name);
      if (attributeId && !assigned.some((entry) => entry.attributeId === attributeId)) {
        assigned.push({ attributeId, value: attribute.value });
      }
    } catch (error) {
      warnings.push({ code: "attribute_skipped", message: `Specification "${attribute.name}" was left out: ${issueFromError(error).message}`, field: "attributes" });
    }
  }
  return assigned;
}

function buildCreateInput(
  item: ProductImportItem,
  references: { brandId: string | null; categoryId: string | null; attributes: Array<{ attributeId: string; value: string }> },
) {
  const simple = item.options.length === 0;
  const first = item.variants[0]!;
  const pricing = compareAtDiscount(first);
  const lowest = Math.min(...item.variants.map((variant) => compareAtDiscount(variant).basePrice));
  const mappings = standardMappingsForOptions(item.options.map((option) => option.name));
  return {
    name: item.title,
    description: item.descriptionHtml,
    price: simple ? pricing.basePrice : lowest,
    categoryId: references.categoryId,
    brandId: references.brandId,
    isActive: item.status === "active",
    discountType: "flat" as const,
    discountPercentage: null,
    discountAmount: simple && pricing.discountAmount > 0 ? pricing.discountAmount : null,
    freeDelivery: false,
    metaTitle: item.seoTitle,
    metaDescription: item.seoDescription,
    canonicalPath: null,
    noIndex: false,
    excludeFromSitemap: false,
    productCondition: item.condition ?? "new",
    ...(item.handle && item.handleIsIdentity ? { slug: item.handle } : {}),
    media: [],
    attributes: references.attributes,
    additionalInfo: [],
    isGiftCard: item.isGiftCard,
    ...(simple
      ? {
        defaultSku: {
          ...(first.sku ? { sku: first.sku } : {}),
          trackInventory: !item.isGiftCard && first.trackInventory,
          stock: !item.isGiftCard && first.trackInventory ? first.stock ?? 0 : 0,
          ...barcodeFields(first.barcode),
          weight: first.weightGrams,
          fulfillmentKind: item.isGiftCard ? "digital" as const : fulfillmentKindFor(first),
          cost: first.cost,
        },
      }
      : {
        optionMatrix: {
          options: item.options.map((option, optionIndex) => ({
            id: `draft_o${optionIndex}`,
            name: option.name,
            standardMapping: mappings[optionIndex]!,
            values: option.values.map((value, valueIndex) => ({ id: `draft_v${optionIndex}_${valueIndex}`, value })),
          })),
          variants: item.variants.map((variant, variantIndex) => {
            const price = compareAtDiscount(variant);
            return {
              id: `draft_s${variantIndex}`,
              selectedOptionValueIds: variant.optionValues.map((value, optionIndex) => {
                const valueIndex = item.options[optionIndex]!.values
                  .findIndex((candidate) => normalizeProductOptionIdentity(candidate) === normalizeProductOptionIdentity(value));
                return `draft_v${optionIndex}_${valueIndex}`;
              }),
              imageId: null,
              sku: variant.sku!,
              price: price.basePrice,
              stock: !item.isGiftCard && variant.trackInventory ? variant.stock ?? 0 : 0,
              trackInventory: !item.isGiftCard && variant.trackInventory,
              weight: variant.weightGrams,
              ...barcodeFields(variant.barcode),
              discountType: "flat" as const,
              discountPercentage: null,
              discountAmount: price.discountAmount > 0 ? price.discountAmount : null,
              fulfillmentKind: item.isGiftCard ? "digital" as const : fulfillmentKindFor(variant),
              cost: variant.cost,
            };
          }),
        },
      }),
  };
}

function zodIssues(error: { issues: ReadonlyArray<{ message: string; path: ReadonlyArray<PropertyKey> }> }, item: ProductImportItem): ProductImportIssue[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String);
    const variantIndex = path[0] === "optionMatrix" && path[1] === "variants" ? Number(path[2]) : undefined;
    // A rule that names its reason (e.g. digital_stock_is_keys) keeps it as the code.
    const reason = (issue as { params?: { reason?: unknown } }).params?.reason;
    return {
      code: typeof reason === "string" && reason ? reason : "invalid",
      message: issue.message,
      field: path.join("."),
      ...(variantIndex !== undefined && Number.isInteger(variantIndex) && variantIndex < item.variants.length ? { variantIndex } : {}),
    };
  });
}

// ── Update ─────────────────────────────────────────────────────────────────

const same = (a: number | null | undefined, b: number | null | undefined) => Math.abs((a ?? 0) - (b ?? 0)) < 1e-9;

/**
 * The file's price for a SKU, or the stored pricing when the SKU already
 * sells at the file's prices (a stored percentage discount stays one).
 */
function mergedPricing(
  stored: StoredPricing,
  variant: ProductImportVariant,
  currency: StoreCurrency,
): { price: number; discountType: "percentage" | "flat"; discountPercentage: number | null; discountAmount: number | null; changed: boolean } {
  const wanted = compareAtDiscount(variant);
  const storedType = stored.discountType === "flat" ? "flat" : "percentage";
  if (same(stored.price, wanted.basePrice) && same(effectivePrice(stored, currency), variant.price)) {
    return {
      price: stored.price,
      discountType: storedType,
      discountPercentage: storedType === "percentage" ? stored.discountPercentage || null : null,
      discountAmount: storedType === "flat" ? stored.discountAmount || null : null,
      changed: false,
    };
  }
  return {
    price: wanted.basePrice,
    discountType: "flat",
    discountPercentage: null,
    discountAmount: wanted.discountAmount > 0 ? wanted.discountAmount : null,
    changed: true,
  };
}

type DetailVariant = ProductWithDetails["variants"][number] & {
  selectedOptions: Array<{ optionDefinitionId: string; optionValueId: string; name: string; value: string }>;
};

function updateInputFrom(details: ProductWithDetails) {
  return {
    id: details.id,
    expectedAggregateRevision: details.aggregateRevision,
    name: details.name,
    description: details.description,
    price: details.price,
    categoryId: details.categoryId,
    brandId: details.brandId ?? null,
    isActive: details.isActive,
    discountType: (details.discountType === "flat" ? "flat" : "percentage") as "flat" | "percentage",
    discountPercentage: details.discountPercentage,
    discountAmount: details.discountAmount,
    freeDelivery: details.freeDelivery,
    metaTitle: details.metaTitle,
    metaDescription: details.metaDescription,
    canonicalPath: details.canonicalPath,
    noIndex: details.noIndex,
    excludeFromSitemap: details.excludeFromSitemap,
    productCondition: details.productCondition,
    slug: details.slug,
    media: details.media.map((item) => ({
      id: item.id,
      mediaId: item.mediaId,
      altText: item.contextualAltText ?? null,
      isPrimary: item.isPrimary,
    })),
    attributes: details.attributes,
    additionalInfo: details.additionalInfo,
  };
}

interface UpdateOutcome {
  status: "updated" | "unchanged";
  aggregateRevision: number;
  issues: ProductImportIssue[];
}

async function applyUpdate(
  db: Database,
  details: ProductWithDetails,
  item: ProductImportItem,
  scope: "all" | "price",
  references: { brandId: string | null; categoryId: string | null; attributes: Array<{ attributeId: string; value: string }> } | null,
  actorId: string | undefined,
  currency: StoreCurrency,
): Promise<UpdateOutcome> {
  const issues: ProductImportIssue[] = [];
  let revision = details.aggregateRevision;
  let changed = false;
  const variants = details.variants as DetailVariant[];
  const storedSimple = variants.length === 1 && variants[0]!.isDefault;
  const fileSimple = item.options.length === 0;
  // A price list may name a simple product's SKU among other rows.
  const simpleSource = storedSimple
    ? fileSimple
      ? item.variants[0]!
      : item.variants.find((variant) => variant.sku && skuKey(variant.sku) === skuKey(variants[0]!.sku))
    : undefined;
  if (scope === "all" && storedSimple !== fileSimple) {
    throw new ItemError({
      code: "option_shape_changed",
      message: storedSimple
        ? "This product has no options in Scalius; add its options in the product editor."
        : "This product has options in Scalius but none in the file; edit it in the product editor.",
    });
  }

  // 1. Product fields (and a simple product's price, which lives on the product).
  const base = updateInputFrom(details);
  const next = { ...base };
  if (scope === "all" && references) {
    next.name = item.title;
    if (item.descriptionHtml) next.description = item.descriptionHtml;
    if (references.brandId) next.brandId = references.brandId;
    if (references.categoryId) next.categoryId = references.categoryId;
    next.isActive = item.status === "active";
    if (item.seoTitle) next.metaTitle = item.seoTitle;
    if (item.seoDescription) next.metaDescription = item.seoDescription;
    if (item.condition) next.productCondition = item.condition;
    const attributes = new Map(base.attributes.map((entry) => [entry.attributeId, entry.value]));
    for (const entry of references.attributes) attributes.set(entry.attributeId, entry.value);
    next.attributes = [...attributes].map(([attributeId, value]) => ({ attributeId, value }));
  }
  if (simpleSource) {
    const pricing = mergedPricing(details, simpleSource, currency);
    if (pricing.changed) {
      next.price = pricing.price;
      next.discountType = pricing.discountType;
      next.discountPercentage = pricing.discountPercentage ?? 0;
      next.discountAmount = pricing.discountAmount ?? 0;
    }
  }
  const productFieldsChanged = JSON.stringify(next) !== JSON.stringify(base);
  if (productFieldsChanged) {
    const parsed = updateProductSchema.safeParse(next);
    if (!parsed.success) {
      throw new ItemError({ code: "invalid", message: parsed.error.issues[0]?.message ?? "The product fields are invalid.", field: parsed.error.issues[0]?.path.join(".") });
    }
    const result = await updateProduct(db, details.id, parsed.data);
    changed = changed || result.aggregateRevision !== revision;
    revision = result.aggregateRevision;
  }

  // 2. A simple product's SKU facts.
  if (storedSimple && fileSimple && scope === "all") {
    const stored = variants[0]!;
    const fileVariant = item.variants[0]!;
    const sku = fileVariant.sku ?? stored.sku;
    const barcode = fileVariant.barcode ? barcodeFields(fileVariant.barcode) : { barcode: stored.barcode, barcodeType: stored.barcodeType };
    const weight = fileVariant.weightGrams ?? stored.weight;
    const trackInventory = stored.trackInventory || (fileVariant.trackInventory && !details.isGiftCard);
    const fulfillmentKind = stored.fulfillmentKind === "digital" ? "digital" : fulfillmentKindFor(fileVariant);
    if (sku !== stored.sku || barcode.barcode !== stored.barcode || !same(weight, stored.weight)
      || trackInventory !== stored.trackInventory || fulfillmentKind !== stored.fulfillmentKind) {
      const result = await updateVariant(db, details.id, stored.id, {
        selectedOptionValueIds: [],
        imageId: stored.imageId,
        weight,
        sku,
        price: stored.price,
        trackInventory,
        ...barcode,
        fulfillmentKind,
        expectedAggregateRevision: revision,
      }, actorId);
      changed = true;
      revision = result.aggregateRevision;
    }
  }

  // 3. An optioned product's SKUs: the stored matrix plus the file's changes.
  if (!storedSimple && (!fileSimple || scope === "price")) {
    const matrix = mergeMatrix(details, variants, item, scope, issues, currency);
    if (matrix.changed) {
      const result = await saveProductOptionMatrix(db, details.id, { ...matrix.input, expectedAggregateRevision: revision }, actorId);
      changed = true;
      revision = result.aggregateRevision;
    }
  }

  // 4. Costs per item the file states (SKUs it adds included); a price list leaves costs alone.
  if (scope === "all" && await applyFileCosts(db, details.id, item, storedSimple, currency)) changed = true;
  return { status: changed ? "updated" : "unchanged", aggregateRevision: revision, issues };
}

/**
 * Sets each SKU's cost per item to the file's where it differs (a blank cost
 * keeps the SKU's). Costs sit outside the product revision; each change names
 * the cost it replaces, so a purchase receipt that moved a cost meanwhile
 * refuses the write instead of being overwritten.
 */
async function applyFileCosts(
  db: Database,
  productId: string,
  item: ProductImportItem,
  storedSimple: boolean,
  currency: StoreCurrency,
): Promise<boolean> {
  const costed = item.variants.filter((variant) => variant.cost !== null);
  if (costed.length === 0) return false;
  const live = await db.select({ id: productVariants.id, sku: productVariants.sku, isDefault: productVariants.isDefault, costMinor: productVariants.costMinor })
    .from(productVariants)
    .where(and(eq(productVariants.productId, productId), isNull(productVariants.deletedAt)));
  const bySku = new Map(live.map((row) => [skuKey(row.sku), row]));
  const changes = costed.flatMap((variant) => {
    const row = storedSimple && item.options.length === 0
      ? live.find((candidate) => candidate.isDefault)
      : variant.sku ? bySku.get(skuKey(variant.sku)) : undefined;
    if (!row || unitCostToMinor(variant.cost!, currency) === row.costMinor) return [];
    return [{ variantId: row.id, cost: variant.cost, expectedCost: unitCostFromMinor(row.costMinor, currency.decimalPlaces) }];
  });
  for (let index = 0; index < changes.length; index += SKU_COST_BATCH_LIMIT) {
    await setSkuCosts(db, { items: changes.slice(index, index + SKU_COST_BATCH_LIMIT) });
  }
  return changes.length > 0;
}

/**
 * The full option matrix to save: every stored option, value and live SKU
 * (unchanged unless the file says otherwise), the file's new values and new
 * combinations, and the file's prices, barcodes and weights on matched SKUs.
 */
function mergeMatrix(
  details: ProductWithDetails,
  variants: readonly DetailVariant[],
  item: ProductImportItem,
  scope: "all" | "price",
  issues: ProductImportIssue[],
  currency: StoreCurrency,
) {
  const options = details.options.map((option) => ({
    id: option.id,
    name: option.name,
    standardMapping: option.standardMapping,
    values: option.values.map((value) => ({ id: value.id, value: value.value })),
  }));
  // File axis index → stored option index, by name.
  const axisMap = item.options.map((option) => options.findIndex((stored) => normalizeProductOptionIdentity(stored.name) === normalizeProductOptionIdentity(option.name)));
  const sameAxes = item.options.length === options.length && axisMap.every((index) => index >= 0) && new Set(axisMap).size === axisMap.length;
  if (scope === "all" && !sameAxes) {
    throw new ItemError({
      code: "option_shape_changed",
      message: `The file's options (${item.options.map((option) => option.name).join(", ")}) differ from the product's (${options.map((option) => option.name).join(", ")}). Change options in the product editor.`,
    });
  }
  const live = variants.filter((variant) => !variant.isDefault);
  const rows = live.map((variant) => ({
    id: variant.id,
    selectedOptionValueIds: options.map((option) => variant.selectedOptions.find((selected) => selected.optionDefinitionId === option.id)?.optionValueId ?? ""),
    imageId: variant.imageId ?? null,
    sku: variant.sku,
    price: variant.price,
    trackInventory: variant.trackInventory,
    weight: variant.weight ?? null,
    barcode: variant.barcode ?? null,
    barcodeType: variant.barcodeType ?? null,
    discountType: (variant.discountType === "flat" ? "flat" : "percentage") as "flat" | "percentage",
    discountPercentage: variant.discountType === "flat" ? null : variant.discountPercentage || null,
    discountAmount: variant.discountType === "flat" ? variant.discountAmount || null : null,
    fulfillmentKind: variant.fulfillmentKind,
    stock: undefined as number | undefined,
  }));
  const original = JSON.stringify(rows);
  const bySku = new Map(rows.map((row) => [skuKey(row.sku), row]));
  const combinationOf = (valueIds: readonly string[]) => valueIds.join("|");
  const byCombination = new Map(rows.map((row) => [combinationOf(row.selectedOptionValueIds), row]));
  let draftValues = 0;
  let draftRows = 0;
  let added = false;

  item.variants.forEach((variant, variantIndex) => {
    // The file's values in stored option order, as stored value ids (new values get draft ids).
    let valueIds: string[] | null = null;
    if (sameAxes) {
      valueIds = options.map((option, optionIndex) => {
        const fileValue = variant.optionValues[axisMap.indexOf(optionIndex)]!;
        const existing = option.values.find((value) => normalizeProductOptionIdentity(value.value) === normalizeProductOptionIdentity(fileValue));
        if (existing) return existing.id;
        if (scope === "price") return "";
        const id = `draft_v${draftValues++}`;
        option.values.push({ id, value: fileValue });
        return id;
      });
    }
    const row = (variant.sku ? bySku.get(skuKey(variant.sku)) : undefined)
      ?? (valueIds ? byCombination.get(combinationOf(valueIds)) : undefined);
    if (!row) {
      if (scope === "price" || !valueIds) {
        issues.push({ code: "sku_not_found", message: `SKU ${variant.sku ?? variant.optionValues.join(" / ")} is not on this product.`, variantIndex, field: "sku" });
        return;
      }
      const price = compareAtDiscount(variant);
      const newRow = {
        id: `draft_s${draftRows++}`,
        selectedOptionValueIds: valueIds,
        imageId: null,
        sku: variant.sku!,
        price: price.basePrice,
        trackInventory: !details.isGiftCard && variant.trackInventory,
        weight: variant.weightGrams,
        ...barcodeFields(variant.barcode),
        discountType: "flat" as const,
        discountPercentage: null,
        discountAmount: price.discountAmount > 0 ? price.discountAmount : null,
        fulfillmentKind: details.isGiftCard ? "digital" as const : fulfillmentKindFor(variant),
        stock: !details.isGiftCard && variant.trackInventory ? variant.stock ?? 0 : 0,
      };
      rows.push(newRow as (typeof rows)[number]);
      byCombination.set(combinationOf(valueIds), newRow as (typeof rows)[number]);
      added = true;
      return;
    }
    const stored = live.find((candidate) => candidate.id === row.id);
    const pricing = stored ? mergedPricing(stored, variant, currency) : null;
    if (pricing?.changed) {
      row.price = pricing.price;
      row.discountType = pricing.discountType;
      row.discountPercentage = pricing.discountPercentage;
      row.discountAmount = pricing.discountAmount;
    }
    if (scope === "all") {
      if (variant.sku && skuKey(variant.sku) !== skuKey(row.sku)) row.sku = variant.sku;
      if (variant.barcode && variant.barcode !== row.barcode) Object.assign(row, barcodeFields(variant.barcode));
      if (variant.weightGrams !== null) row.weight = variant.weightGrams;
      if (variant.trackInventory && !details.isGiftCard) row.trackInventory = true;
      if (row.fulfillmentKind !== "digital") row.fulfillmentKind = fulfillmentKindFor(variant);
    }
  });
  // Values nobody uses (a draft value of a skipped row) cannot be saved.
  const used = new Set(rows.flatMap((row) => row.selectedOptionValueIds));
  for (const option of options) option.values = option.values.filter((value) => used.has(value.id) || !value.id.startsWith("draft_"));
  const changed = added || JSON.stringify(rows.filter((row) => !row.id.startsWith("draft_"))) !== original;
  return {
    changed,
    input: {
      options,
      variants: rows.map(({ stock, ...row }) => (row.id.startsWith("draft_") ? { ...row, stock } : row)),
    },
  };
}

// ── Batch ──────────────────────────────────────────────────────────────────

/** Applies (or dry-runs) one batch of product items. */
export async function importProducts(
  db: Database,
  batch: ProductImportBatch,
  context: ProductImportContext = {},
): Promise<ProductImportResponse> {
  const budget = context.budget ?? new ImportBudget();
  const actorId = context.actorId ?? undefined;
  const references = new ImportReferenceResolver(db, batch.dryRun, context.rights);
  const notes: string[] = [];
  const [lookup, currency] = await Promise.all([readMatches(db, batch.items), readStoreCurrency(db)]);
  const revisions = new Map<string, ProductMatch>();
  for (const match of lookup.bySlug.values()) revisions.set(match.productId, match);
  for (const list of lookup.byName.values()) for (const match of list) revisions.set(match.productId, match);
  const results: ProductImportResult[] = [];
  let stoppedEarly = false;

  for (const item of batch.items) {
    if (budget.exhausted()) {
      stoppedEarly = true;
      break;
    }
    const resolution = resolveItem(item, batch.mode, lookup, revisions);
    const result: ProductImportResult = { ref: item.ref, status: "failed", productId: null, slug: null, aggregateRevision: null, issues: [] };
    try {
      if (resolution.kind === "error") {
        result.issues.push(resolution.issue);
      } else if (resolution.kind === "new") {
        if (batch.mode === "price") {
          result.status = batch.dryRun ? "would_skip" : "skipped";
          result.issues.push({ code: "sku_not_found", message: "None of these SKUs exist in the store." });
        } else {
          const brandId = await references.brand(item.brand);
          const categoryId = item.categoryPath.length > 0 ? await references.category(item.categoryPath) : null;
          const attributes = await resolveAttributes(references, item, result.issues);
          const input = createProductSchema.safeParse(buildCreateInput(item, { brandId, categoryId, attributes }));
          if (!input.success) {
            result.issues.push(...zodIssues(input.error, item));
          } else if (batch.dryRun) {
            result.status = "would_create";
            result.slug = item.handle;
          } else {
            const created = await createProduct(db, input.data);
            const row = await db.select({ slug: products.slug }).from(products).where(sql`${products.id} = ${created.id}`).get();
            Object.assign(result, { status: "created", productId: created.id, aggregateRevision: created.aggregateRevision, slug: row?.slug ?? null });
          }
        }
      } else {
        const { match } = resolution;
        result.productId = match.productId;
        result.slug = match.slug;
        if (batch.mode === "create") {
          result.status = batch.dryRun ? "would_skip" : "skipped";
          result.aggregateRevision = match.aggregateRevision || null;
          result.issues.push({ code: "already_exists", message: `Already in the store as /products/${match.slug}.` });
        } else if (batch.dryRun) {
          // A dry run needs only the revision the write must match (one light read).
          const current = await db.select({ slug: products.slug, aggregateRevision: products.aggregateRevision, deletedAt: products.deletedAt })
            .from(products).where(sql`${products.id} = ${match.productId}`).get();
          if (!current || current.deletedAt) throw new ItemError({ code: "product_in_trash", message: "This product is in trash. Restore or delete it, then import again." });
          result.slug = current.slug;
          result.aggregateRevision = current.aggregateRevision;
          result.status = "would_update";
          if (batch.mode === "upsert") {
            await references.brand(item.brand);
            if (item.categoryPath.length > 0) await references.category(item.categoryPath);
            await resolveAttributes(references, item, result.issues);
          }
        } else {
          const details = await getProductDetails(db, match.productId);
          if (!details || details.deletedAt) throw new ItemError({ code: "product_in_trash", message: "This product is in trash. Restore or delete it, then import again." });
          result.slug = details.slug;
          result.aggregateRevision = details.aggregateRevision;
          if (item.expected && item.expected.productId === details.id && item.expected.aggregateRevision !== details.aggregateRevision) {
            throw new ItemError({ code: "changed_since_preview", message: "This product changed after the preview. Preview the file again." });
          }
          const scope = batch.mode === "price" ? "price" : "all";
          const resolved = scope === "all"
            ? {
              brandId: await references.brand(item.brand),
              categoryId: item.categoryPath.length > 0 ? await references.category(item.categoryPath) : null,
              attributes: await resolveAttributes(references, item, result.issues),
            }
            : null;
          const outcome = await applyUpdate(db, details, item, scope, resolved, actorId, currency);
          result.status = outcome.status;
          result.aggregateRevision = outcome.aggregateRevision;
          result.issues.push(...outcome.issues);
        }
      }
    } catch (error) {
      if (isWorkerLimitError(error)) {
        stoppedEarly = true;
        break;
      }
      result.status = "failed";
      result.issues.push(issueFromError(error));
    }
    results.push(result);
  }
  return { results, processed: results.length, stoppedEarly, references: references.plan, notes };
}
