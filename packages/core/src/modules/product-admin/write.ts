// Creating, updating and duplicating products under the aggregate revision.
import {
    brands,
    products,
    productVariants,
    productMedia,
    media,
    productRichContent,
    productAttributeValues,
    productOptionDefinitions,
    productOptionValues,
    productVariantOptionValues,
    warrantyPolicies,
    taxClasses,
    customFieldDefinitions,
    customFieldValues,
} from "@scalius/database/schema";
import { and, sql, eq, isNull, or } from "drizzle-orm";
import {
    createProductSchema,
    PRODUCT_NAME_MAX_LENGTH,
    type CreateProductInput,
    type UpdateProductInput,
} from "./validation";
import { DEFAULT_PRODUCT_CONDITION } from "@scalius/shared/product-condition";
import { nanoid } from "nanoid";
import { AppError, NotFoundError, ConflictError, ValidationError } from "@scalius/core/errors";
import { buildBatchGuard, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import type { BatchItem } from "drizzle-orm/batch";
import {
  assertDigitalStockInput,
  buildGiftCardProductRulesGuard,
  buildProductBundleCopyStatements,
  buildProductBundleReplaceStatements,
  buildProductContentBlockCopyStatements,
  buildProductContentBlockReplaceStatements,
  catalogPriceColumns,
  catalogProjectionRefreshStatements,
  type CustomizationSchemaInput,
  type CustomizationView,
  defaultProductSkuValues,
  GIFT_CARD_PRODUCT_RULES_MESSAGE,
  MAX_PRODUCT_MEDIA_ASSOCIATIONS,
  normalizeOptionIdentity,
  planDigitalSkuWrites,
  PRODUCT_CONTENT_BLOCK_MEDIA_GUARD,
  PRODUCT_CONTENT_BLOCK_MEDIA_UNAVAILABLE_MESSAGE,
  PRODUCT_MEDIA_REORDER_OFFSET,
  rethrowDigitalStockRuleViolation,
  rethrowGiftCardProductRuleViolation,
  STOCK_CHANGED_MESSAGE,
  toStoredCustomizationSchema,
  productChannelChoiceStatement,
} from "../products";
import { storeCurrencyCodeSql, toStoreMinor } from "../settings";
import { readStoreCurrency, storeCurrencyFromSql, storePriceIncrementSql } from "../markets";
import { percentToBps } from "@scalius/shared/money";
import {
    buildProductAggregateRevisionBump,
    buildProductAggregateRevisionGuard,
    executeProductAggregateMutationBatch,
    isProductAggregateRevisionConflict,
    productPriceMinorSql,
    readProductAggregateRevisionResult,
    rethrowProductAggregateRevisionConflictIfStale,
    type ProductAggregateRevisionResult,
} from "./aggregate-revision";
import { optionMatrixBatchConflict, planProductOptionMatrix } from "./option-matrix";
import {
    resolveNewVariantBarcode,
    rethrowProductVariantIdentityConstraint,
    assertSkusFree,
    isVariantEditBatchConflict,
    planVariantUpdate,
    readableDefaultSku,
    reconcileVariantLowStockAlerts,
} from "./variants";
import {
  buildStockMovementClaim,
  inventoryLocationErrorFrom,
  isInventoryLevelShortfallError,
  isInventoryLocationRequiredError,
  unitCostToMinor,
} from "../inventory";
import { type PlannedProductAttributeValue, prepareProductAttributeValueRows } from "../attributes";
import { insertWithDerivedHandle } from "../../utils/derived-handle";
import { handleOrNumberedCopy } from "../../utils/text-match";
import { getProductDetails } from "./read";

export type SQLiteBatchItem = BatchItem<"sqlite">;

// Each D1 statement accepts at most 100 bound parameters. Keep multi-row
// product aggregate inserts comfortably below that boundary.
const PRODUCT_AGGREGATE_INSERT_CHUNK = 18;
const PRODUCT_MEDIA_INSERT_CHUNK = 12;

/** A brand a product may point at: it exists and is not in trash (draft is fine). */
async function assertLiveBrand(db: Database, brandId: string | null | undefined): Promise<void> {
    if (!brandId) return;
    const brand = await db
        .select({ id: brands.id })
        .from(brands)
        .where(and(eq(brands.id, brandId), isNull(brands.deletedAt)))
        .get();
    if (!brand) {
        throw new ValidationError("That brand is unavailable or in trash. Choose another brand.", { field: "brandId" });
    }
}

/**
 * A warranty policy a product may point at: it exists and is not archived.
 * Not part of the checkout authority fence: commit freezes whatever revision
 * is current, and a warranty never changes the price.
 */
async function assertLiveWarrantyPolicy(db: Database, policyId: string | null | undefined): Promise<void> {
    if (!policyId) return;
    if (!await isLiveWarrantyPolicy(db, policyId)) {
        throw new ValidationError("That warranty policy is unavailable or archived. Choose another policy.", { field: "warrantyPolicyId" });
    }
}

async function isLiveWarrantyPolicy(db: Database, policyId: string): Promise<boolean> {
    const policy = await db
        .select({ id: warrantyPolicies.id })
        .from(warrantyPolicies)
        .where(and(eq(warrantyPolicies.id, policyId), isNull(warrantyPolicies.archivedAt)))
        .get();
    return Boolean(policy);
}

export function defaultVariantValues(productId: string, priceMinor: number) {
    return defaultProductSkuValues(productId, priceMinor);
}

type ProductMediaInput = CreateProductInput["media"][number];
type ProductMediaPlanRow = ProductMediaInput & {
    productId: string;
    sortOrder: number;
    kind: "image" | "video";
    status: "ready" | "trashed" | "deleting" | "deleted";
    existing: boolean;
};

type ProductMediaPlan = {
    rows: ProductMediaPlanRow[];
    existingRows: Array<{ id: string; mediaId: string }>;
    retainedRows: ProductMediaPlanRow[];
    newRows: ProductMediaPlanRow[];
};

export class ProductMediaSkuReferenceConflictError extends AppError {
    constructor(details: {
        affectedCount: number;
        affectedAssociationIds: string[];
        affectedSkus: Array<{ id: string; sku: string; imageId: string }>;
    }) {
        super(
            409,
            "PRODUCT_MEDIA_SKU_REFERENCE_CONFLICT",
            "One or more removed images are still assigned to SKUs. Confirm that those SKUs should use the featured fallback.",
            details,
        );
        this.name = "ProductMediaSkuReferenceConflictError";
    }
}

async function validateProductMediaPlan(
    db: Database,
    productId: string,
    submitted: CreateProductInput["media"],
    existingProduct: boolean,
): Promise<ProductMediaPlan> {
    if (submitted.length > MAX_PRODUCT_MEDIA_ASSOCIATIONS) {
        throw new ValidationError(`Attach at most ${MAX_PRODUCT_MEDIA_ASSOCIATIONS} media items to a product.`);
    }
    const associationIds = submitted.map((item) => item.id);
    const mediaIds = submitted.map((item) => item.mediaId);
    if (
        new Set(associationIds).size !== associationIds.length
        || new Set(mediaIds).size !== mediaIds.length
    ) {
        throw new ValidationError("Product media association and asset IDs must be unique.");
    }
    const primaryCount = submitted.filter((item) => item.isPrimary).length;
    if (submitted.length > 0 && primaryCount !== 1) {
        throw new ValidationError("Choose exactly one featured media item.");
    }

    const existingRows = existingProduct
        ? await db
            .select({ id: productMedia.id, mediaId: productMedia.mediaId })
            .from(productMedia)
            .where(eq(productMedia.productId, productId))
        : [];
    const existingById = new Map(existingRows.map((row) => [row.id, row]));

    const collisions = associationIds.length === 0
        ? []
        : await db
            .select({ id: productMedia.id, productId: productMedia.productId, mediaId: productMedia.mediaId })
            .from(productMedia)
            .where(sql`${productMedia.id} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(associationIds)})
            )`);
    const collisionById = new Map(collisions.map((row) => [row.id, row]));

    const assetRows = mediaIds.length === 0
        ? []
        : await db
            .select({ id: media.id, kind: media.kind, status: media.status })
            .from(media)
            .where(sql`${media.id} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(mediaIds)})
            )`);
    const assetById = new Map(assetRows.map((row) => [row.id, row]));

    const rows = submitted.map((item, sortOrder): ProductMediaPlanRow => {
        const existing = existingById.get(item.id);
        const collision = collisionById.get(item.id);
        if (collision && (collision.productId !== productId || collision.mediaId !== item.mediaId)) {
            throw new ValidationError("A product media association ID is already in use or points to another asset.");
        }
        if (existing && existing.mediaId !== item.mediaId) {
            throw new ValidationError("An existing product media association cannot be changed to another asset.");
        }
        const asset = assetById.get(item.mediaId);
        if (!asset) throw new ValidationError("One or more selected media assets no longer exist.");
        if (existing) {
            if (asset.status !== "ready" && asset.status !== "trashed") {
                throw new ValidationError("An attached media asset is no longer available.");
            }
        } else if (asset.status !== "ready") {
            throw new ValidationError("Only ready media assets can be newly attached to a product.");
        }
        return {
            ...item,
            productId,
            sortOrder,
            kind: asset.kind,
            status: asset.status,
            existing: Boolean(existing),
        };
    });

    return {
        rows,
        existingRows,
        retainedRows: rows.filter((row) => row.existing),
        newRows: rows.filter((row) => !row.existing),
    };
}

function assertSubmittedSkuImage(
    imageId: string | null,
    rows: readonly ProductMediaPlanRow[],
): void {
    if (!imageId) return;
    const association = rows.find((row) => row.id === imageId);
    if (!association || association.kind !== "image" || association.status !== "ready") {
        throw new ValidationError("A selected SKU image must be a ready image attached to this product.");
    }
}

function buildProductMediaInsertStatements(
    db: Database,
    rows: readonly ProductMediaPlanRow[],
): SQLiteBatchItem[] {
    const statements: SQLiteBatchItem[] = [];
    for (let index = 0; index < rows.length; index += PRODUCT_MEDIA_INSERT_CHUNK) {
        statements.push(db.insert(productMedia).values(
            rows.slice(index, index + PRODUCT_MEDIA_INSERT_CHUNK).map((row) => ({
                id: row.id,
                productId: row.productId,
                mediaId: row.mediaId,
                altText: row.altText,
                isPrimary: row.isPrimary,
                sortOrder: row.sortOrder,
                createdAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`,
            })),
        ));
    }
    return statements;
}

async function assertRemovedSkuImagesAcknowledged(
    db: Database,
    productId: string,
    removedAssociationIds: readonly string[],
    acknowledgedAssociationIds: readonly string[],
): Promise<string[]> {
    if (removedAssociationIds.length === 0) {
        if (acknowledgedAssociationIds.length > 0) {
            throw new ValidationError("SKU image fallback acknowledgement is stale. Reload the product and try again.");
        }
        return [];
    }
    const removedJson = JSON.stringify(removedAssociationIds);
    const affected = await db
        .select({
            id: productVariants.id,
            sku: productVariants.sku,
            imageId: productVariants.imageId,
        })
        .from(productVariants)
        .where(and(
            eq(productVariants.productId, productId),
            isNull(productVariants.deletedAt),
            sql`${productVariants.imageId} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${removedJson})
            )`,
        ));
    const affectedAssociationIds = [...new Set(
        affected.flatMap((row) => row.imageId ? [row.imageId] : []),
    )];
    const affectedIdSet = new Set(affectedAssociationIds);
    const acknowledged = new Set(acknowledgedAssociationIds);
    if (acknowledgedAssociationIds.some((id) => !affectedIdSet.has(id))) {
        throw new ValidationError("SKU image fallback acknowledgement is stale. Reload the product and try again.");
    }
    if (affectedAssociationIds.some((id) => !acknowledged.has(id))) {
        throw new ProductMediaSkuReferenceConflictError({
            affectedCount: affected.length,
            affectedAssociationIds: affectedAssociationIds.slice(0, 20),
            affectedSkus: affected.slice(0, 5).map((row) => ({
                id: row.id,
                sku: row.sku,
                imageId: row.imageId!,
            })),
        });
    }
    return affectedAssociationIds;
}

function buildProductMediaUpdateStatements(
    db: Database,
    productId: string,
    plan: ProductMediaPlan,
    clearSkuImageIds: readonly string[],
): SQLiteBatchItem[] {
    const statements: SQLiteBatchItem[] = [];
    if (plan.existingRows.length > 0) {
        statements.push(db.update(productMedia).set({
            isPrimary: false,
            sortOrder: sql`${productMedia.sortOrder} + ${PRODUCT_MEDIA_REORDER_OFFSET}`,
            updatedAt: sql`unixepoch()`,
        }).where(eq(productMedia.productId, productId)));
    }
    if (clearSkuImageIds.length > 0) {
        statements.push(db.update(productVariants).set({
            imageId: null,
            updatedAt: sql`unixepoch()`,
        }).where(and(
            eq(productVariants.productId, productId),
            isNull(productVariants.deletedAt),
            sql`${productVariants.imageId} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(clearSkuImageIds)})
            )`,
        )));
    }

    const submittedIds = plan.rows.map((row) => row.id);
    statements.push(submittedIds.length > 0
        ? db.delete(productMedia).where(and(
            eq(productMedia.productId, productId),
            sql`${productMedia.id} NOT IN (
                SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(submittedIds)})
            )`,
        ))
        : db.delete(productMedia).where(eq(productMedia.productId, productId)));

    if (plan.retainedRows.length > 0) {
        const retainedJson = JSON.stringify(plan.retainedRows.map((row) => ({
            id: row.id,
            altText: row.altText,
            isPrimary: row.isPrimary ? 1 : 0,
            sortOrder: row.sortOrder,
        })));
        statements.push(db.update(productMedia).set({
            altText: sql`(
                SELECT json_extract(value, '$.altText')
                FROM json_each(${retainedJson})
                WHERE json_extract(value, '$.id') = ${productMedia.id}
            )`,
            isPrimary: sql`(
                SELECT CAST(json_extract(value, '$.isPrimary') AS INTEGER)
                FROM json_each(${retainedJson})
                WHERE json_extract(value, '$.id') = ${productMedia.id}
            )`,
            sortOrder: sql`(
                SELECT CAST(json_extract(value, '$.sortOrder') AS INTEGER)
                FROM json_each(${retainedJson})
                WHERE json_extract(value, '$.id') = ${productMedia.id}
            )`,
            updatedAt: sql`unixepoch()`,
        }).where(and(
            eq(productMedia.productId, productId),
            sql`${productMedia.id} IN (
                SELECT CAST(json_extract(value, '$.id') AS TEXT)
                FROM json_each(${retainedJson})
            )`,
        )));
    }
    statements.push(...buildProductMediaInsertStatements(db, plan.newRows));
    return statements;
}

function isSimpleDefaultSkuSet(variants: Array<{ isDefault: boolean; optionCombinationKey: string | null }>): boolean {
    return variants.length === 1 && variants[0]?.isDefault === true && variants[0].optionCombinationKey === null;
}

function hasInvalidSkuTopology(variants: Array<{ isDefault: boolean; optionCombinationKey: string | null }>): boolean {
    const defaultSkuCount = variants.filter((variant) => variant.isDefault).length;
    if (isSimpleDefaultSkuSet(variants)) return false;
    return defaultSkuCount > 0 || variants.some((variant) => !variant.optionCombinationKey?.trim());
}

// ─────────────────────────────────────────
// Write operations (Admin CRUD)
// ─────────────────────────────────────────

/**
 * Creates a new product along with ordered media, rich content, and attributes.
 * A typed slug that is already in use is refused; an omitted one is derived
 * from the name and suffixed until it is free.
 * Returns the new product ID on success.
 */
/** A new SKU's cost per item in minor units (a cost may keep paisa), or null for none. */
function costMinorOf(cost: number | null | undefined, currency: { decimalPlaces: number }): number | null {
    return cost === null || cost === undefined ? null : unitCostToMinor(cost, currency);
}

function isProductSlugConstraintError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /products(?:_slug_idx|\.slug)/i.test(message);
}

export async function createProduct(
    db: Database,
    data: CreateProductInput,
): Promise<{ id: string; aggregateRevision: number }> {
    // A digital SKU's stock is its licence keys (the schema refuses this too).
    assertDigitalStockInput(data);
    if (data.slug) {
        const existingProduct = await db
            .select({ id: products.id })
            .from(products)
            .where(eq(products.slug, data.slug))
            .get();
        if (existingProduct) throw new ConflictError("A product with this slug already exists");
    }

    const productId = "prod_" + nanoid();
    // Typed attribute value rows, validated before any other read (unknown enum values are created first).
    const attributeRows = await prepareProductAttributeValueRows(db, productId, data.attributes ?? []);
    await assertLiveBrand(db, data.brandId);
    await assertLiveWarrantyPolicy(db, data.warrantyPolicyId);

    await assertSkusFree(db, data.optionMatrix
        ? data.optionMatrix.variants.map((variant, index) => ({ sku: variant.sku, field: `optionMatrix.variants.${index}.sku` }))
        : data.defaultSku?.sku ? [{ sku: data.defaultSku.sku, field: "defaultSku.sku" }] : []);

    const currency = await readStoreCurrency(db);
    const productPrice = catalogPriceColumns(data, currency);
    // With options, the product price is its lowest variant price (productPriceMinorSql).
    const priceMinor = data.optionMatrix?.variants.length
        ? Math.min(...data.optionMatrix.variants.map((variant) => toStoreMinor(variant.price, currency)))
        : toStoreMinor(data.price, currency);
    const isGiftCard = data.isGiftCard === true;
    const baseDefaultVariant = defaultVariantValues(productId, priceMinor);
    const defaultVariant = {
        ...baseDefaultVariant,
        sku: data.optionMatrix ? baseDefaultVariant.sku : data.defaultSku?.sku ?? await readableDefaultSku(db, data.name),
        // A gift card's SKUs are digital and untracked (validation refused anything else).
        trackInventory: isGiftCard ? false : data.defaultSku?.trackInventory ?? false,
        weight: data.defaultSku?.weight ?? null,
        costMinor: costMinorOf(data.defaultSku?.cost, currency),
        fulfillmentKind: isGiftCard ? "digital" as const : data.defaultSku?.fulfillmentKind ?? data.fulfillmentKind ?? "physical",
        ...(data.defaultSku?.barcode
            ? resolveNewVariantBarcode(baseDefaultVariant.id, data.defaultSku.barcode, data.defaultSku.barcodeType)
            : {}),
    };
    const mediaPlan = await validateProductMediaPlan(db, productId, data.media, false);
    const customizationSchema = toStoredCustomizationSchema(data.customizationSchema ?? null, currency);

    const productInsert = (slug: string) => db.insert(products).values({
            id: productId,
            name: data.name,
            description: data.description || null,
            priceMinor,
            categoryId: data.categoryId,
            brandId: data.brandId ?? null,
            warrantyPolicyId: data.warrantyPolicyId ?? null,
            slug,
            metaTitle: data.metaTitle || null,
            metaDescription: data.metaDescription,
            canonicalPath: data.canonicalPath ?? null,
            noIndex: data.noIndex ?? false,
            excludeFromSitemap: data.excludeFromSitemap ?? false,
            productCondition: data.productCondition,
            isActive: data.isActive,
            discountType: data.discountType || "percentage",
            discountBps: (data.discountType || "percentage") === "percentage" ? (productPrice.discountBps ?? 0) : 0,
            discountAmountMinor: (data.discountType || "percentage") === "flat" ? (productPrice.discountAmountMinor ?? 0) : 0,
            freeDelivery: data.freeDelivery,
            isGiftCard,
            customizationSchema,
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
            deletedAt: null,
        });
    const batchOps: SQLiteBatchItem[] = [];

    if (!data.optionMatrix) {
        batchOps.push(db.insert(productVariants).values(defaultVariant));
        const initialStock = data.defaultSku?.stock ?? 0;
        if (initialStock > 0) {
            batchOps.push(buildStockMovementClaim(db, {
                movementId: crypto.randomUUID(),
                variantId: defaultVariant.id,
                pool: "regular",
                quantity: initialStock,
                before: { stock: 0, reservedStock: 0, preorderStock: 0, stockVersion: 1 },
                after: { stock: initialStock, reservedStock: 0, preorderStock: 0, stockVersion: 2 },
                notes: "Stocktake: Initial product stock",
            }));
            batchOps.push(db.update(productVariants)
                .set({ stock: initialStock, stockVersion: 2, updatedAt: sql`unixepoch()` })
                .where(and(eq(productVariants.id, defaultVariant.id), eq(productVariants.stockVersion, 1))));
        }
    }

    batchOps.push(...buildProductMediaInsertStatements(db, mediaPlan.newRows));

    if (data.optionMatrix) {
        const definitionIdMap = new Map<string, string>();
        const valueIdMap = new Map<string, string>();
        for (const [position, option] of data.optionMatrix.options.entries()) {
            const optionId = `popt_${nanoid()}`;
            definitionIdMap.set(option.id, optionId);
            batchOps.push(db.insert(productOptionDefinitions).values({
                id: optionId,
                productId,
                name: option.name,
                normalizedName: normalizeOptionIdentity(option.name),
                position,
                standardMapping: option.standardMapping,
                createdAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`,
                deletedAt: null,
            }));
            for (const [valuePosition, value] of option.values.entries()) {
                const valueId = `pval_${nanoid()}`;
                valueIdMap.set(value.id, valueId);
                batchOps.push(db.insert(productOptionValues).values({
                    id: valueId,
                    optionDefinitionId: optionId,
                    value: value.value,
                    normalizedValue: normalizeOptionIdentity(value.value),
                    position: valuePosition,
                    createdAt: sql`unixepoch()`,
                    updatedAt: sql`unixepoch()`,
                    deletedAt: null,
                }));
            }
        }

        const assignmentRows: Array<{
            variantId: string;
            optionDefinitionId: string;
            optionValueId: string;
        }> = [];
        for (const matrixVariant of data.optionMatrix.variants) {
            const variantId = `var_${nanoid()}`;
            const selectedOptionValueIds = matrixVariant.selectedOptionValueIds.map((id) => {
                const valueId = valueIdMap.get(id);
                if (!valueId) throw new ValidationError("A selected option value is not in this product matrix.");
                return valueId;
            });
            assertSubmittedSkuImage(matrixVariant.imageId, mediaPlan.rows);
            const barcode = resolveNewVariantBarcode(
                variantId,
                matrixVariant.barcode,
                matrixVariant.barcodeType,
            );
            const variantFields = {
                id: variantId,
                productId,
                optionCombinationKey: selectedOptionValueIds.join("|"),
                imageId: matrixVariant.imageId,
                weight: matrixVariant.weight,
                sku: matrixVariant.sku.trim(),
                priceMinor: toStoreMinor(matrixVariant.price, currency),
                stock: 0,
                reservedStock: 0,
                preorderStock: 0,
                isDefault: false,
                trackInventory: isGiftCard ? false : matrixVariant.trackInventory,
                fulfillmentKind: isGiftCard ? "digital" as const : matrixVariant.fulfillmentKind ?? data.fulfillmentKind ?? "physical",
                barcode: barcode.barcode,
                barcodeType: barcode.barcodeType,
                discountType: matrixVariant.discountType,
                discountBps: matrixVariant.discountType === "percentage"
                    ? percentToBps(matrixVariant.discountPercentage)
                    : 0,
                discountAmountMinor: matrixVariant.discountType === "flat"
                    ? toStoreMinor(matrixVariant.discountAmount ?? 0, currency)
                    : 0,
                costMinor: costMinorOf(matrixVariant.cost, currency),
                version: 1,
                stockVersion: 1,
                allowPreorder: false,
                allowBackorder: false,
                backorderLimit: 0,
                createdAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`,
                deletedAt: null,
            };
            batchOps.push(db.insert(productVariants).values(variantFields));
            for (const [optionIndex, option] of data.optionMatrix.options.entries()) {
                assignmentRows.push({
                    variantId,
                    optionDefinitionId: definitionIdMap.get(option.id)!,
                    optionValueId: selectedOptionValueIds[optionIndex]!,
                });
            }
            const initialStock = matrixVariant.stock ?? 0;
            if (initialStock > 0) {
                batchOps.push(buildStockMovementClaim(db, {
                    movementId: crypto.randomUUID(),
                    variantId,
                    pool: "regular",
                    quantity: initialStock,
                    before: { stock: 0, reservedStock: 0, preorderStock: 0, stockVersion: 1 },
                    after: { stock: initialStock, reservedStock: 0, preorderStock: 0, stockVersion: 2 },
                    notes: "Stocktake: Initial product option stock",
                }));
                batchOps.push(db.update(productVariants)
                    .set({ stock: initialStock, stockVersion: 2, updatedAt: sql`unixepoch()` })
                    .where(and(eq(productVariants.id, variantId), eq(productVariants.stockVersion, 1))));
            }
        }
        for (let index = 0; index < assignmentRows.length; index += 25) {
            batchOps.push(db.insert(productVariantOptionValues).values(
                assignmentRows.slice(index, index + 25),
            ));
        }
    }

    if (data.additionalInfo && data.additionalInfo.length > 0) {
        const richContentRows = data.additionalInfo.map((item) => ({
                    id: `prc_${nanoid()}`,
                    productId,
                    title: item.title,
                    content: item.content,
                    sortOrder: item.sortOrder,
                }));
        for (let index = 0; index < richContentRows.length; index += PRODUCT_AGGREGATE_INSERT_CHUNK) {
            batchOps.push(db.insert(productRichContent).values(
                richContentRows.slice(index, index + PRODUCT_AGGREGATE_INSERT_CHUNK),
            ));
        }
    }

    batchOps.push(...attributeRows.statements);

    const insertWithSlug = async (slug: string) => {
        await db.batch([
            productInsert(slug),
            // The insert published it to every channel (trigger); the form's choice narrows that.
            ...(data.salesChannelIds ? [productChannelChoiceStatement(db, productId, data.salesChannelIds)] : []),
            ...batchOps,
            buildGiftCardProductRulesGuard(db, productId),
            ...catalogProjectionRefreshStatements(db, [productId]),
        ] as never);
    };
    try {
        if (data.slug) await insertWithSlug(data.slug);
        else {
            await insertWithDerivedHandle(
                { db, table: products, column: products.slug, isHandleConflict: isProductSlugConstraintError },
                data.name,
                "product",
                insertWithSlug,
            );
        }
    } catch (error) {
        if (isProductSlugConstraintError(error)) throw new ConflictError("A product with this slug already exists");
        rethrowGiftCardProductRuleViolation(error);
        rethrowProductVariantIdentityConstraint(error);
    }
    return { id: productId, aggregateRevision: 1 };
}

type ProductSavePlan = {
    priceMinor: number;
    productPrice: ReturnType<typeof catalogPriceColumns>;
    customizationSchema: string | null | undefined;
    attributes: readonly PlannedProductAttributeValue[];
    content: ReadonlyArray<{ id: string; title: string; content: string; sortOrder: number }>;
    activeVariants: ReadonlyArray<{
        isDefault: boolean;
        optionCombinationKey: string | null;
        priceMinor: number;
        discountType: string | null;
        discountBps: number;
        discountAmountMinor: number;
        fulfillmentKind: string;
        trackInventory: boolean;
    }>;
    mediaPlan: ProductMediaPlan;
    clearSkuImageIds: readonly string[];
};

/**
 * The product's current aggregate revision when saving `data`'s details would
 * change nothing they write (product columns, the default SKU, SKU fulfilment
 * kinds, media, attribute values, rich content), else null. A stale revision
 * or a trashed product is null too, so the guarded batch reports the conflict.
 */
async function unchangedProductSaveRevision(
    db: Database,
    id: string,
    data: UpdateProductInput,
    plan: ProductSavePlan,
): Promise<number | null> {
    if (plan.clearSkuImageIds.length > 0 || plan.mediaPlan.newRows.length > 0) return null;
    if (data.isActive && plan.activeVariants.length === 0) return null;
    if (data.fulfillmentKind !== undefined
        && plan.activeVariants.some((variant) => variant.fulfillmentKind !== data.fulfillmentKind)) return null;
    // A gift card forces every live SKU digital and untracked.
    if (data.isGiftCard === true
        && plan.activeVariants.some((variant) => variant.fulfillmentKind !== "digital" || variant.trackInventory)) return null;
    if (isSimpleDefaultSkuSet([...plan.activeVariants])) {
        const sku = plan.activeVariants[0]!;
        if (sku.priceMinor !== plan.priceMinor || sku.discountType !== "percentage"
            || sku.discountBps !== 0 || sku.discountAmountMinor !== 0) return null;
    }
    const [productRows, mediaRows, attributeRows, contentRows] = await db.batch([
        db.select({
            aggregateRevision: products.aggregateRevision,
            deletedAt: products.deletedAt,
            name: products.name,
            description: products.description,
            priceMinor: products.priceMinor,
            categoryId: products.categoryId,
            brandId: products.brandId,
            warrantyPolicyId: products.warrantyPolicyId,
            isGiftCard: products.isGiftCard,
            slug: products.slug,
            metaTitle: products.metaTitle,
            metaDescription: products.metaDescription,
            canonicalPath: products.canonicalPath,
            noIndex: products.noIndex,
            excludeFromSitemap: products.excludeFromSitemap,
            productCondition: products.productCondition,
            isActive: products.isActive,
            discountType: products.discountType,
            discountBps: products.discountBps,
            discountAmountMinor: products.discountAmountMinor,
            freeDelivery: products.freeDelivery,
            customizationSchema: products.customizationSchema,
            pageTemplate: products.pageTemplate,
            emiEligible: products.emiEligible,
        }).from(products).where(eq(products.id, id)),
        db.select({
            id: productMedia.id,
            altText: productMedia.altText,
            isPrimary: productMedia.isPrimary,
            sortOrder: productMedia.sortOrder,
        }).from(productMedia).where(eq(productMedia.productId, id)),
        db.select({
            attributeId: productAttributeValues.attributeId,
            value: productAttributeValues.value,
            valueNumber: productAttributeValues.valueNumber,
            valueId: productAttributeValues.valueId,
        }).from(productAttributeValues).where(eq(productAttributeValues.productId, id)),
        db.select({
            id: productRichContent.id,
            title: productRichContent.title,
            content: productRichContent.content,
            sortOrder: productRichContent.sortOrder,
        }).from(productRichContent).where(eq(productRichContent.productId, id)),
    ]);
    const current = productRows[0];
    if (!current || current.deletedAt !== null || current.aggregateRevision !== data.expectedAggregateRevision) return null;

    // Product columns: `undefined` is a column the save leaves alone.
    const discountType = data.discountType || "percentage";
    const optionPrices = plan.activeVariants
        .filter((variant) => !variant.isDefault && (variant.optionCombinationKey ?? "").trim() !== "")
        .map((variant) => variant.priceMinor);
    const expected: Record<string, unknown> = {
        name: data.name,
        description: data.description,
        priceMinor: optionPrices.length > 0 ? Math.min(...optionPrices) : plan.priceMinor,
        categoryId: data.categoryId,
        brandId: data.brandId,
        warrantyPolicyId: data.warrantyPolicyId,
        isGiftCard: data.isGiftCard,
        slug: data.slug,
        metaTitle: data.metaTitle,
        metaDescription: data.metaDescription,
        canonicalPath: data.canonicalPath ?? null,
        noIndex: data.noIndex ?? false,
        excludeFromSitemap: data.excludeFromSitemap ?? false,
        productCondition: data.productCondition,
        isActive: data.isActive,
        discountType,
        discountBps: discountType === "percentage" ? (plan.productPrice.discountBps ?? 0) : 0,
        discountAmountMinor: discountType === "flat" ? (plan.productPrice.discountAmountMinor ?? 0) : 0,
        freeDelivery: data.freeDelivery,
        customizationSchema: plan.customizationSchema,
        pageTemplate: data.pageTemplate,
        emiEligible: data.emiEligible,
    };
    const stored = current as unknown as Record<string, unknown>;
    for (const [column, value] of Object.entries(expected)) {
        if (value !== undefined && (stored[column] ?? null) !== (value ?? null)) return null;
    }

    // Media: the same associations, each with the same alt text, flag and place.
    const submitted = plan.mediaPlan.rows;
    if (submitted.length !== mediaRows.length) return null;
    const storedMedia = new Map(mediaRows.map((row) => [row.id, row]));
    for (const row of submitted) {
        const was = storedMedia.get(row.id);
        if (!was || (was.altText ?? null) !== (row.altText ?? null)
            || Boolean(was.isPrimary) !== Boolean(row.isPrimary) || was.sortOrder !== row.sortOrder) return null;
    }

    // Attribute values: the same typed rows (a new enum value is a change).
    const valueKey = (row: { attributeId: string; value: string; valueNumber: number | null; valueId: string | null }) =>
        JSON.stringify([row.attributeId, row.value, row.valueNumber === null ? null : Number(row.valueNumber), row.valueId ?? null]);
    if (plan.attributes.some((row) => row.kind === "enum" && row.valueId === null)) return null;
    const plannedValues = plan.attributes.map(valueKey).sort();
    const storedValues = attributeRows.map(valueKey).sort();
    if (JSON.stringify(plannedValues) !== JSON.stringify(storedValues)) return null;

    // Rich content: the same items.
    const contentKey = (row: { id: string; title: string; content: string; sortOrder: number }) =>
        JSON.stringify([row.id, row.title, row.content, row.sortOrder]);
    if (JSON.stringify(plan.content.map(contentKey).sort()) !== JSON.stringify(contentRows.map(contentKey).sort())) return null;

    return current.aggregateRevision;
}

/** Clear errors for a gift-card save the batch guard would otherwise refuse. */
function assertGiftCardUpdateAllowed(
    data: UpdateProductInput,
    activeVariants: ReadonlyArray<{
        isDefault: boolean;
        trackInventory: boolean;
        reservedStock: number;
        discountBps: number;
        discountAmountMinor: number;
    }>,
): void {
    if ((data.discountPercentage ?? 0) > 0 || (data.discountAmount ?? 0) > 0) {
        throw new ValidationError("Gift cards can't be discounted. Set the discount to 0.", { field: "discountPercentage" });
    }
    if (data.fulfillmentKind !== undefined && data.fulfillmentKind !== "digital") {
        throw new ValidationError("Gift cards are delivered digitally.", { field: "fulfillmentKind" });
    }
    // This save resets the simple SKU's discount; option SKUs keep theirs.
    if (activeVariants.some((variant) => !variant.isDefault && (variant.discountBps > 0 || variant.discountAmountMinor > 0))) {
        throw new ValidationError(GIFT_CARD_PRODUCT_RULES_MESSAGE, { field: "isGiftCard" });
    }
    // Tracking turns off in this save, which open reservations forbid (as a SKU edit does).
    if (activeVariants.some((variant) => variant.trackInventory && variant.reservedStock > 0)) {
        throw new ConflictError("Release reserved stock before making this product a gift card: gift cards don't track quantity.");
    }
}

type ProductSaveComposition = {
    statements: SQLiteBatchItem[];
    changedStockVariantIds: string[];
    /** The SKUs the product sells after the save, by the id the request named them with. */
    variantIds: Map<string, string>;
};

/**
 * The options and SKUs an editor Save sends with the product (`optionMatrix`
 * for a product with options, `defaultSku` for the hidden SKU of one
 * without), checked and turned into writes for the product's own batch, or
 * null when the Save leaves them alone. Nothing is written here, so a refusal
 * leaves the whole product as it was.
 */
async function planProductSaveComposition(
    db: Database,
    id: string,
    data: UpdateProductInput,
    context: {
        priceMinor: number;
        activeVariants: ReadonlyArray<{ id: string; isDefault: boolean; optionCombinationKey: string | null; imageId: string | null }>;
        mediaPlan: ProductMediaPlan;
        adminUserId?: string;
    },
): Promise<ProductSaveComposition | null> {
    if (data.optionMatrix) {
        return planProductOptionMatrix(db, id, data.optionMatrix, {
            isActive: data.isActive,
            adminUserId: context.adminUserId,
            fieldPrefix: "optionMatrix.",
            // The SKUs may show photos this same Save attaches (or no longer those it removes).
            attachedImages: new Map(context.mediaPlan.rows
                .filter((row) => row.kind === "image")
                .map((row) => [row.id, { status: row.status }])),
        });
    }
    if (!data.defaultSku) return null;
    const defaultSku = isSimpleDefaultSkuSet([...context.activeVariants]) ? context.activeVariants[0]! : null;
    if (!defaultSku) {
        throw new ConflictError("This product has options now. Reload the latest product and try again.");
    }
    const { stock, expectedStockVersion, ...sku } = data.defaultSku;
    const plan = await planVariantUpdate(db, id, defaultSku.id, {
        ...sku,
        ...(stock !== undefined ? { stock, expectedStockVersion } : {}),
        selectedOptionValueIds: [],
        imageId: defaultSku.imageId,
        price: data.price,
    }, { adminUserId: context.adminUserId, simplePriceMinor: context.priceMinor, fieldPrefix: "defaultSku." });
    return {
        statements: plan.statements,
        changedStockVariantIds: plan.movementIndex === null ? [] : [defaultSku.id],
        variantIds: new Map([[defaultSku.id, defaultSku.id]]),
    };
}

/**
 * The page's own sections a Save changed (content blocks, quantity bundles),
 * checked and turned into writes for the product's batch.
 */
async function planProductSaveSections(
    db: Database,
    id: string,
    data: UpdateProductInput,
    isGiftCard: boolean,
): Promise<SQLiteBatchItem[]> {
    const statements: SQLiteBatchItem[] = [];
    if (data.contentBlocks) {
        statements.push(...await buildProductContentBlockReplaceStatements(db, id, data.contentBlocks) ?? []);
    }
    if (data.bundles) {
        if (isGiftCard && data.bundles.length > 0) {
            throw new ValidationError("Gift cards are sold at their value, so they can't have quantity bundles.", { field: "bundles" });
        }
        statements.push(...await buildProductBundleReplaceStatements(db, id, data.bundles) ?? []);
    }
    return statements;
}

const SKU_COST_CHANGED_GUARD = "PRODUCT_SAVE_SKU_COST_CHANGED";

/**
 * The costs per item a Save changed, as two statements for the product's
 * batch (bounded parameters whatever the SKU count): a guard that every SKU
 * still has the cost the editor showed, then the update. A new option row is
 * named by its draft id and gets its new id here. Null when none changed.
 */
function planProductSaveCosts(
    db: Database,
    id: string,
    data: UpdateProductInput,
    context: {
        currency: { decimalPlaces: number };
        /** The SKUs the product sells after the save, by the request's id; the live SKUs when the save leaves them alone. */
        variantIds: ReadonlyMap<string, string>;
    },
): SQLiteBatchItem[] {
    if (!data.skuCosts || data.skuCosts.length === 0) return [];
    const seen = new Set<string>();
    const changes = data.skuCosts.map((item, index) => {
        const variantId = context.variantIds.get(item.variantId);
        if (!variantId) {
            throw new ValidationError("A SKU in this change no longer exists. Reload and try again.", { field: `skuCosts.${index}.variantId` });
        }
        if (seen.has(variantId)) throw new ValidationError("Each SKU's cost appears once.", { field: `skuCosts.${index}.variantId` });
        seen.add(variantId);
        return {
            id: variantId,
            cost: item.cost === null ? null : unitCostToMinor(item.cost, context.currency),
            expected: item.expectedCost === null ? null : unitCostToMinor(item.expectedCost, context.currency),
        };
    });
    const payload = JSON.stringify(changes);
    return [
        buildBatchGuard(db, sql`NOT EXISTS (
            SELECT 1 FROM json_each(${payload}) AS change
            LEFT JOIN ${productVariants} ON ${productVariants.id} = json_extract(change.value, '$.id')
              AND ${productVariants.productId} = ${id}
              AND ${productVariants.deletedAt} IS NULL
            WHERE ${productVariants.id} IS NULL
               OR NOT (${productVariants.costMinor} IS json_extract(change.value, '$.expected'))
        )`, SKU_COST_CHANGED_GUARD),
        db.update(productVariants).set({
            costMinor: sql`(SELECT json_extract(change.value, '$.cost') FROM json_each(${payload}) AS change
                WHERE json_extract(change.value, '$.id') = ${productVariants.id})`,
            updatedAt: sql`unixepoch()`,
        }).where(and(
            eq(productVariants.productId, id),
            sql`${productVariants.id} IN (SELECT json_extract(value, '$.id') FROM json_each(${payload}))`,
        )),
    ];
}

/** A refusal raised inside the batch by the sections, options, SKUs or costs it saved. */
function rethrowProductSaveCompositionError(error: unknown): void {
    if (isBatchGuardError(error, PRODUCT_CONTENT_BLOCK_MEDIA_GUARD)) {
        throw new ValidationError(PRODUCT_CONTENT_BLOCK_MEDIA_UNAVAILABLE_MESSAGE, { field: "contentBlocks" });
    }
    if (isBatchGuardError(error, SKU_COST_CHANGED_GUARD)) {
        throw new ConflictError("A SKU's cost changed since you opened it. Reload and try again.");
    }
    const matrixConflict = optionMatrixBatchConflict(error);
    if (matrixConflict) throw matrixConflict;
    if (isVariantEditBatchConflict(error)) throw new ConflictError(STOCK_CHANGED_MESSAGE);
    // Editor quantities apply at the default location, which may hold fewer units than an edit removes.
    if (isInventoryLevelShortfallError(error) || isInventoryLocationRequiredError(error)) {
        throw inventoryLocationErrorFrom(error, "The default location");
    }
    if (!isProductAggregateRevisionConflict(error)) rethrowProductVariantIdentityConstraint(error);
}

/**
 * Updates an existing product, replacing ordered media, rich content, and attributes.
 * Validates that the product exists and the slug is not taken by another product.
 * Everything else an editor Save changed (options and SKUs, content blocks,
 * quantity bundles, page template, EMI, costs per item) is checked first and
 * written in the same guarded batch, so one Save is all-or-nothing. Product
 * details that did not change are not rewritten.
 */
export async function updateProduct(
    db: Database,
    id: string,
    data: UpdateProductInput,
    adminUserId?: string,
): Promise<ProductAggregateRevisionResult> {
    const existingProduct = await db
        .select({
            id: products.id,
            isGiftCard: products.isGiftCard,
            storeCurrencyCode: storeCurrencyCodeSql(),
            storePriceIncrementMinor: storePriceIncrementSql(),
        })
        .from(products)
        .where(eq(products.id, id))
        .get();

    if (!existingProduct) {
        throw new NotFoundError("Product not found");
    }

    const existingSlug = await db
        .select({ id: products.id })
        .from(products)
        .where(
            and(
                eq(products.slug, data.slug),
                sql`${products.id} != ${id}`,
                sql`${products.deletedAt} IS NULL`,
            ),
        )
        .get();

    if (existingSlug) {
        throw new ConflictError("A product with this slug already exists");
    }

    const attributeRows = await prepareProductAttributeValueRows(db, id, data.attributes ?? []);
    await assertLiveBrand(db, data.brandId);
    await assertLiveWarrantyPolicy(db, data.warrantyPolicyId);
    const currency = storeCurrencyFromSql(existingProduct.storeCurrencyCode, existingProduct.storePriceIncrementMinor);
    const productPrice = catalogPriceColumns(data, currency);
    const priceMinor = toStoreMinor(data.price, currency);
    // Omitted keeps the stored buyer inputs; null removes them.
    const customizationSchema = data.customizationSchema === undefined
        ? undefined
        : toStoredCustomizationSchema(data.customizationSchema, currency);

    const contentToInsert = (data.additionalInfo ?? [])
        .filter((item) => item.title.trim() && item.content.trim())
        .map((item) => ({
            id: item.id.startsWith("item-") ? `prc_${nanoid()}` : item.id,
            productId: id,
            title: item.title,
            content: item.content,
            sortOrder: item.sortOrder,
        }));

    const activeVariants = await db
        .select({
            id: productVariants.id,
            isDefault: productVariants.isDefault,
            optionCombinationKey: productVariants.optionCombinationKey,
            priceMinor: productVariants.priceMinor,
            discountType: productVariants.discountType,
            discountBps: productVariants.discountBps,
            discountAmountMinor: productVariants.discountAmountMinor,
            fulfillmentKind: productVariants.fulfillmentKind,
            trackInventory: productVariants.trackInventory,
            stock: productVariants.stock,
            reservedStock: productVariants.reservedStock,
            sku: productVariants.sku,
            imageId: productVariants.imageId,
        })
        .from(productVariants)
        .where(and(eq(productVariants.productId, id), isNull(productVariants.deletedAt)));
    // Omitted keeps the flag. A gift card forces every live SKU digital and
    // untracked in this batch; discounts and open reservations are refused.
    const isGiftCard = data.isGiftCard ?? existingProduct.isGiftCard === true;
    if (isGiftCard) assertGiftCardUpdateAllowed(data, activeVariants);
    // The Shipping card's kind: a SKU turns digital only without stock (its
    // stock becomes its licence keys). Gift cards keep their own rules.
    const fulfillmentKind = data.fulfillmentKind;
    const digitalKindGuards = !isGiftCard && fulfillmentKind !== undefined
        ? await planDigitalSkuWrites(db, activeVariants.map((variant) => ({
            variantId: variant.id,
            sku: variant.sku,
            before: { kind: variant.fulfillmentKind, stock: variant.stock, trackInventory: variant.trackInventory },
            after: { kind: fulfillmentKind, stock: variant.stock, trackInventory: variant.trackInventory },
        })))
        : [];
    const mediaPlan = await validateProductMediaPlan(db, id, data.media, true);
    const submittedMediaIds = new Set(mediaPlan.rows.map((row) => row.id));
    const removedAssociationIds = mediaPlan.existingRows
        .map((row) => row.id)
        .filter((associationId) => !submittedMediaIds.has(associationId));
    const clearSkuImageIds = await assertRemovedSkuImagesAcknowledged(
        db,
        id,
        removedAssociationIds,
        data.acknowledgedSkuImageRemovalIds ?? [],
    );

    if (!(data.isActive && activeVariants.length === 0) && hasInvalidSkuTopology(activeVariants)) {
        throw new ValidationError("Product SKU data is invalid: only one default SKU is allowed, and every non-default SKU must include at least one customer option.");
    }

    // Every check of everything the Save sends runs before anything is written.
    const composition = await planProductSaveComposition(db, id, data, { priceMinor, activeVariants, mediaPlan, adminUserId });
    const sectionStatements = await planProductSaveSections(db, id, data, isGiftCard);
    const costStatements = planProductSaveCosts(db, id, data, {
        currency,
        variantIds: composition?.variantIds ?? new Map(activeVariants.map((variant) => [variant.id, variant.id])),
    });

    // Details that change nothing write nothing (no row rewritten, so no cache
    // dependency advances); a save that changes nothing at all bumps nothing.
    const unchangedRevision = await unchangedProductSaveRevision(db, id, data, {
        priceMinor,
        productPrice,
        customizationSchema,
        attributes: attributeRows.planned,
        content: contentToInsert,
        activeVariants,
        mediaPlan,
        clearSkuImageIds,
    });
    const detailsChanged = unchangedRevision === null;
    if (!detailsChanged && !composition && sectionStatements.length === 0 && costStatements.length === 0) {
        return { aggregateRevision: unchangedRevision };
    }

    // Drizzle D1 batch() requires specific tuple types
    const batchOps: unknown[] = [
        buildProductAggregateRevisionGuard(db, id, data.expectedAggregateRevision),
        // Sections first, as when they saved on their own (moved tabs become blocks before the tabs go).
        ...sectionStatements,
    ];
    // Where the statement that bumps (and returns) the revision sits.
    let revisionIndex = -1;
    if (detailsChanged) revisionIndex = batchOps.push(
        db.update(products)
            .set({
                name: data.name,
                description: data.description,
                priceMinor: productPriceMinorSql(id, priceMinor),
                categoryId: data.categoryId,
                // Omitted keeps the stored brand; null removes it.
                ...(data.brandId !== undefined ? { brandId: data.brandId } : {}),
                // Omitted keeps the warranty; null removes it.
                ...(data.warrantyPolicyId !== undefined ? { warrantyPolicyId: data.warrantyPolicyId } : {}),
                slug: data.slug,
                metaTitle: data.metaTitle,
                metaDescription: data.metaDescription,
                canonicalPath: data.canonicalPath ?? null,
                noIndex: data.noIndex ?? false,
                excludeFromSitemap: data.excludeFromSitemap ?? false,
                productCondition: data.productCondition,
                isActive: data.isActive,
                discountType: data.discountType || "percentage",
                discountBps: (data.discountType || "percentage") === "percentage" ? (productPrice.discountBps ?? 0) : 0,
                discountAmountMinor: (data.discountType || "percentage") === "flat" ? (productPrice.discountAmountMinor ?? 0) : 0,
                freeDelivery: data.freeDelivery,
                ...(data.isGiftCard !== undefined ? { isGiftCard: data.isGiftCard } : {}),
                ...(customizationSchema !== undefined ? { customizationSchema } : {}),
                // Omitted keeps the template and the EMI line.
                ...(data.pageTemplate !== undefined ? { pageTemplate: data.pageTemplate } : {}),
                ...(data.emiEligible !== undefined ? { emiEligible: data.emiEligible } : {}),
                aggregateRevision: sql`${products.aggregateRevision} + 1`,
                updatedAt: sql`unixepoch()`,
            })
            .where(eq(products.id, id))
            .returning({ aggregateRevision: products.aggregateRevision }),
    ) - 1;
    if (detailsChanged) batchOps.push(
        ...buildProductMediaUpdateStatements(db, id, mediaPlan, clearSkuImageIds),
        db.delete(productAttributeValues).where(eq(productAttributeValues.productId, id)),
        db.delete(productRichContent).where(eq(productRichContent.productId, id)),
        ...attributeRows.statements,
    );

    if (detailsChanged && contentToInsert.length > 0) {
        for (let index = 0; index < contentToInsert.length; index += PRODUCT_AGGREGATE_INSERT_CHUNK) {
            batchOps.push(db.insert(productRichContent).values(
                contentToInsert.slice(index, index + PRODUCT_AGGREGATE_INSERT_CHUNK),
            ));
        }
    }

    if (data.isActive && activeVariants.length === 0) {
        // Options sent with this save are the product's SKUs; otherwise it sells one hidden SKU.
        if (detailsChanged && !data.optionMatrix) {
            batchOps.push(db.insert(productVariants).values({
                ...defaultVariantValues(id, priceMinor),
                fulfillmentKind: isGiftCard ? "digital" : data.fulfillmentKind ?? "physical",
            }));
        }
    } else if (hasInvalidSkuTopology(activeVariants)) {
        throw new ValidationError("Product SKU data is invalid: only one default SKU is allowed, and every non-default SKU must include at least one customer option.");
    }

    if (detailsChanged && isSimpleDefaultSkuSet(activeVariants)) {
        batchOps.push(
            db
                .update(productVariants)
                .set({
                    priceMinor,
                    discountType: "percentage",
                    discountBps: 0,
                    discountAmountMinor: 0,
                    updatedAt: sql`unixepoch()`,
                })
                .where(eq(productVariants.id, activeVariants[0]!.id)),
        );
    }

    if (composition) {
        batchOps.push(...composition.statements);
        // An optioned product's price is its cheapest SKU's, as the SKUs this batch saved leave it.
        if (data.optionMatrix && detailsChanged) {
            batchOps.push(db.update(products)
                .set({ priceMinor: productPriceMinorSql(id, sql`${products.priceMinor}`) })
                .where(eq(products.id, id)));
        }
    }
    batchOps.push(...costStatements);

    // The Shipping card's kind applies to every live SKU. Checkout refuses a
    // digital line until it is deliverable, so accepting the kind is safe.
    if (isGiftCard) {
        batchOps.push(db.update(productVariants)
            .set({ fulfillmentKind: "digital", trackInventory: false, updatedAt: sql`unixepoch()` })
            .where(and(
                eq(productVariants.productId, id),
                isNull(productVariants.deletedAt),
                sql`(${productVariants.fulfillmentKind} <> 'digital' OR ${productVariants.trackInventory} = 1)`,
                // A reservation that raced in keeps tracking on, and the guard refuses the save.
                sql`(${productVariants.trackInventory} = 0 OR ${productVariants.reservedStock} = 0)`,
            )));
    } else if (data.fulfillmentKind !== undefined) {
        batchOps.push(db.update(productVariants)
            .set({ fulfillmentKind: data.fulfillmentKind, updatedAt: sql`unixepoch()` })
            .where(and(
                eq(productVariants.productId, id),
                isNull(productVariants.deletedAt),
                sql`${productVariants.fulfillmentKind} <> ${data.fulfillmentKind}`,
            )));
        // SKUs that turned digital still hold no stock at commit.
        batchOps.push(...digitalKindGuards);
    }

    // Unchanged details leave the revision to the aggregate bump (which also re-derives the price).
    if (!detailsChanged) revisionIndex = batchOps.push(buildProductAggregateRevisionBump(db, id)) - 1;
    batchOps.push(buildGiftCardProductRulesGuard(db, id));
    // The catalogue projections read this batch's own writes.
    batchOps.push(...catalogProjectionRefreshStatements(db, [id]));

    let saved: ProductAggregateRevisionResult;
    try {
        const results = await safeBatch(db, batchOps as never) as unknown[];
        saved = readProductAggregateRevisionResult(results[revisionIndex]);
    } catch (error) {
        rethrowGiftCardProductRuleViolation(error);
        rethrowDigitalStockRuleViolation(error);
        rethrowProductSaveCompositionError(error);
        return rethrowProductAggregateRevisionConflictIfStale(
            db,
            id,
            data.expectedAggregateRevision,
            error,
        );
    }
    if (composition) await reconcileVariantLowStockAlerts(db, composition.changedStockVariantIds);
    return saved;
}

/**
 * Replaces only the bounded product-media aggregate while preserving the same
 * association, SKU-image fallback, and aggregate-revision invariants as the
 * full editor command. This is the semantic section command used by bounded
 * API clients; it deliberately does not load or rewrite unrelated product
 * text, attributes, rich content, options, or SKUs.
 */
export async function updateProductMediaSection(
    db: Database,
    productId: string,
    expectedAggregateRevision: number,
    submitted: UpdateProductInput["media"],
    acknowledgedSkuImageRemovalIds: readonly string[] = [],
): Promise<ProductAggregateRevisionResult | null> {
    const product = await db
        .select({ id: products.id })
        .from(products)
        .where(eq(products.id, productId))
        .get();
    if (!product) return null;

    const mediaPlan = await validateProductMediaPlan(db, productId, submitted, true);
    const submittedMediaIds = new Set(mediaPlan.rows.map((row) => row.id));
    const removedAssociationIds = mediaPlan.existingRows
        .map((row) => row.id)
        .filter((associationId) => !submittedMediaIds.has(associationId));
    const clearSkuImageIds = await assertRemovedSkuImagesAcknowledged(
        db,
        productId,
        removedAssociationIds,
        acknowledgedSkuImageRemovalIds,
    );
    const result = await executeProductAggregateMutationBatch(
        db,
        productId,
        expectedAggregateRevision,
        buildProductMediaUpdateStatements(db, productId, mediaPlan, clearSkuImageIds),
    );
    return { aggregateRevision: result.aggregateRevision };
}

/** `${base}${suffix}` values that no SKU uses yet: BASE-COPY, then BASE-COPY-2 … */
async function freeCopySkus(db: Database, skus: string[]): Promise<string[]> {
    const stems = skus.map((sku) => `${sku.trim().slice(0, 90)}-COPY`);
    const taken = new Set<string>();
    for (let index = 0; index < stems.length; index += 40) {
        const chunk = stems.slice(index, index + 40);
        const rows = await db
            .select({ sku: productVariants.sku })
            .from(productVariants)
            .where(or(...chunk.map((stem) => handleOrNumberedCopy(sql`lower(trim(${productVariants.sku}))`, stem.toLowerCase()))));
        rows.forEach((row) => taken.add(row.sku.trim().toLowerCase()));
    }
    return stems.map((stem) => {
        let candidate = stem;
        for (let suffix = 2; taken.has(candidate.toLowerCase()); suffix += 1) candidate = `${stem}-${suffix}`;
        taken.add(candidate.toLowerCase());
        return candidate;
    });
}

/** The stored buyer inputs back in the decimal editor contract, for a copy. */
function customizationInputFromView(view: CustomizationView | null): CustomizationSchemaInput | null {
    if (!view) return null;
    return {
        fields: view.fields.map((field) => ({
            key: field.key,
            label: field.label,
            type: field.type,
            required: field.required,
            help: field.help,
            ...(field.maxLength !== null ? { maxLength: field.maxLength } : {}),
            ...(field.type === "select"
                ? { options: field.options.map((option) => ({ value: option.value, label: option.label, price: option.price })) }
                : { price: field.price }),
        })),
    };
}

/**
 * Copies a product as a new draft: text, pricing, media, attributes, extra
 * sections, content blocks, quantity bundles, the page template, buyer inputs,
 * EMI and tax class, custom fields, and its options with every live variant
 * (each with its cost per item, low-stock alert, backorder and preorder policy,
 * tax class and custom fields). Copies start with no stock, new SKUs (…-COPY)
 * and fresh generated barcodes, because stock, SKU and barcode identities
 * belong to one sellable item only.
 */
export async function duplicateProduct(
    db: Database,
    id: string,
    name: string,
): Promise<{ id: string; aggregateRevision: number }> {
    const source = await getProductDetails(db, id);
    if (!source || source.deletedAt) throw new NotFoundError("Product not found");

    let slug = `${source.slug.slice(0, 90)}-copy`;
    const slugRows = await db
        .select({ slug: products.slug })
        .from(products)
        .where(handleOrNumberedCopy(products.slug, slug));
    const slugs = new Set(slugRows.map((row) => row.slug));
    for (let suffix = 2; slugs.has(slug); suffix += 1) slug = `${source.slug.slice(0, 90)}-copy-${suffix}`;

    const readyMedia = source.media.filter((item) => item.status === "ready");
    const mediaIdMap = new Map(readyMedia.map((item) => [item.id, `pmed_${nanoid()}`]));
    const media = readyMedia.map((item, index) => ({
        id: mediaIdMap.get(item.id)!,
        mediaId: item.mediaId,
        altText: item.contextualAltText ?? null,
        isPrimary: readyMedia.some((entry) => entry.isPrimary) ? item.isPrimary : index === 0,
    }));
    const liveVariants = source.variants.filter((variant) => !variant.deletedAt);
    const optionVariants = liveVariants.filter((variant) => !variant.isDefault);
    const skus = await freeCopySkus(db, liveVariants.map((variant) => variant.sku));
    const skuOf = new Map(liveVariants.map((variant, index) => [variant.id, skus[index]!]));

    // A value no live SKU sells (its SKU was removed) stays on the source
    // until the merchant edits the matrix, but a new product may only carry
    // values some SKU uses: the copy takes exactly the values its SKUs sell.
    const soldValueIds = new Set(optionVariants.flatMap((variant) =>
        variant.selectedOptions.map((option) => option.optionValueId)));
    const parsed = createProductSchema.safeParse({
        name: name.trim().slice(0, PRODUCT_NAME_MAX_LENGTH),
        description: source.description,
        price: source.price,
        categoryId: source.categoryId,
        brandId: source.brandId,
        // A copy keeps a live warranty; an archived one is not offered to new products.
        warrantyPolicyId: source.warrantyPolicyId && await isLiveWarrantyPolicy(db, source.warrantyPolicyId)
            ? source.warrantyPolicyId
            : null,
        isActive: false,
        discountType: source.discountType === "flat" ? "flat" : "percentage",
        discountPercentage: source.discountPercentage,
        discountAmount: source.discountAmount,
        freeDelivery: source.freeDelivery,
        isGiftCard: source.isGiftCard,
        metaTitle: source.metaTitle,
        metaDescription: source.metaDescription,
        canonicalPath: null,
        noIndex: source.noIndex,
        excludeFromSitemap: source.excludeFromSitemap,
        // A copy is published where its source is.
        salesChannelIds: source.salesChannelIds,
        productCondition: source.productCondition ?? DEFAULT_PRODUCT_CONDITION,
        slug,
        media,
        attributes: source.attributes,
        additionalInfo: source.additionalInfo.map((item) => ({ ...item, id: `prc_${nanoid()}` })),
        customizationSchema: customizationInputFromView(source.customizationSchema),
        ...(source.options.length > 0 && optionVariants.length > 0
            ? {
                optionMatrix: {
                    options: source.options.map((option) => ({
                        id: option.id,
                        name: option.name,
                        standardMapping: option.standardMapping,
                        values: option.values
                            .filter((value) => soldValueIds.has(value.id))
                            .map((value) => ({ id: value.id, value: value.value })),
                    })),
                    variants: optionVariants.map((variant) => ({
                        id: variant.id,
                        selectedOptionValueIds: [...variant.selectedOptions]
                            .sort((a, b) => a.position - b.position)
                            .map((option) => option.optionValueId),
                        imageId: variant.imageId ? mediaIdMap.get(variant.imageId) ?? null : null,
                        sku: skuOf.get(variant.id)!,
                        price: variant.price,
                        stock: 0,
                        trackInventory: variant.trackInventory,
                        weight: variant.weight,
                        barcode: null,
                        barcodeType: null,
                        discountType: variant.discountType === "flat" ? "flat" : "percentage",
                        discountPercentage: variant.discountType === "flat" ? null : variant.discountPercentage,
                        discountAmount: variant.discountType === "flat" ? variant.discountAmount : null,
                        fulfillmentKind: variant.fulfillmentKind,
                    })),
                },
            }
            : {
                defaultSku: {
                    sku: liveVariants[0] ? skuOf.get(liveVariants[0].id) : undefined,
                    trackInventory: liveVariants[0]?.trackInventory ?? false,
                    stock: 0,
                    weight: liveVariants[0]?.weight ?? null,
                    fulfillmentKind: liveVariants[0]?.fulfillmentKind ?? "physical",
                },
            }),
    });
    if (!parsed.success) {
        // A copy the product form could not save either: a 400 naming why.
        const issue = parsed.error.issues[0];
        throw new ValidationError(issue?.message ?? "This product cannot be copied.", {
            field: issue?.path.join("."),
        });
    }
    const copy = await createProduct(db, parsed.data);
    // Blocks, bundles, the template, the SKUs' selling settings and the custom
    // fields are kept outside the create: one more guarded aggregate write on
    // the new draft (nobody else has it open yet).
    const [blocks, bundles, settings, copyVariants] = await Promise.all([
        buildProductContentBlockCopyStatements(db, id, copy.id),
        buildProductBundleCopyStatements(db, id, copy.id),
        db.select({
            pageTemplate: products.pageTemplate,
            emiEligible: products.emiEligible,
            // An archived tax class is not offered to new products.
            taxClassId: sql<string | null>`(SELECT ${taxClasses.id} FROM ${taxClasses} WHERE ${taxClasses.id} = ${products.taxClassId} AND ${taxClasses.deletedAt} IS NULL)`,
        }).from(products).where(eq(products.id, id)).get(),
        db.select({ id: productVariants.id, sku: productVariants.sku })
            .from(productVariants)
            .where(and(eq(productVariants.productId, copy.id), isNull(productVariants.deletedAt))),
    ]);
    // Each source SKU's copy, by the copy's new SKU code.
    const copyIdBySku = new Map(copyVariants.map((variant) => [variant.sku.trim().toLowerCase(), variant.id]));
    const copyIdOf = new Map(liveVariants.flatMap((variant) => {
        const copyId = copyIdBySku.get(skuOf.get(variant.id)!.trim().toLowerCase());
        return copyId ? [[variant.id, copyId] as const] : [];
    }));
    const statements: BatchItem<"sqlite">[] = [
        ...blocks,
        ...bundles,
        ...(settings && (settings.pageTemplate || settings.emiEligible || settings.taxClassId)
            ? [db.update(products).set({
                pageTemplate: settings.pageTemplate,
                emiEligible: settings.emiEligible,
                taxClassId: settings.taxClassId,
            }).where(eq(products.id, copy.id))]
            : []),
        ...await buildSkuSettingsCopyStatements(db, copyIdOf),
        ...await buildCustomFieldValueCopyStatements(db, id, copy.id, copyIdOf),
    ];
    if (statements.length === 0) return copy;
    const result = await executeProductAggregateMutationBatch(db, copy.id, copy.aggregateRevision, statements);
    return { id: copy.id, aggregateRevision: result.aggregateRevision };
}

/**
 * A copy's SKUs keep what the merchant set on the source's: cost per item,
 * low-stock alert, backorder and preorder policy and tax class. Never stock,
 * SKU or barcode (those identify one sellable item).
 */
async function buildSkuSettingsCopyStatements(
    db: Database,
    copyIdOf: ReadonlyMap<string, string>,
): Promise<BatchItem<"sqlite">[]> {
    if (copyIdOf.size === 0) return [];
    const sources = await db.select({
        id: productVariants.id,
        costMinor: productVariants.costMinor,
        lowStockThreshold: productVariants.lowStockThreshold,
        allowBackorder: productVariants.allowBackorder,
        backorderLimit: productVariants.backorderLimit,
        allowPreorder: productVariants.allowPreorder,
        preorderDate: productVariants.preorderDate,
        preorderMessage: productVariants.preorderMessage,
        taxClassId: sql<string | null>`(SELECT ${taxClasses.id} FROM ${taxClasses} WHERE ${taxClasses.id} = ${productVariants.taxClassId} AND ${taxClasses.deletedAt} IS NULL)`,
    }).from(productVariants)
        .where(sql`${productVariants.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify([...copyIdOf.keys()])}))`);
    return sources.flatMap(({ id: sourceId, ...facts }) => {
        const copyId = copyIdOf.get(sourceId);
        const unset = facts.costMinor === null && facts.lowStockThreshold === null && !facts.allowBackorder
            && facts.backorderLimit === 0 && !facts.allowPreorder && facts.preorderDate === null
            && facts.preorderMessage === null && facts.taxClassId === null;
        return copyId && !unset
            ? [db.update(productVariants).set({ ...facts, updatedAt: sql`unixepoch()` }).where(eq(productVariants.id, copyId))]
            : [];
    });
}

/**
 * The merchant's custom field values (namespace `custom`) of the product and
 * of each SKU, onto the copy and its SKUs. An app's own fields (its
 * namespace) stay with the source: they may name the source's records.
 */
async function buildCustomFieldValueCopyStatements(
    db: Database,
    sourceId: string,
    copyId: string,
    copyIdOf: ReadonlyMap<string, string>,
): Promise<BatchItem<"sqlite">[]> {
    const owners = JSON.stringify([sourceId, ...copyIdOf.keys()]);
    const values = await db.select({
        definitionId: customFieldValues.definitionId,
        ownerType: customFieldValues.ownerType,
        ownerId: customFieldValues.ownerId,
        value: customFieldValues.value,
    }).from(customFieldValues)
        .innerJoin(customFieldDefinitions, eq(customFieldDefinitions.id, customFieldValues.definitionId))
        .where(and(
            eq(customFieldDefinitions.namespace, "custom"),
            sql`${customFieldValues.ownerId} IN (SELECT CAST(value AS TEXT) FROM json_each(${owners}))`,
            sql`${customFieldValues.ownerType} IN ('product', 'variant')`,
        ));
    const rows = values.flatMap((row) => {
        const ownerId = row.ownerType === "product"
            ? row.ownerId === sourceId ? copyId : null
            : copyIdOf.get(row.ownerId) ?? null;
        return ownerId ? [{ ...row, ownerId }] : [];
    });
    const statements: BatchItem<"sqlite">[] = [];
    for (let index = 0; index < rows.length; index += PRODUCT_AGGREGATE_INSERT_CHUNK) {
        statements.push(db.insert(customFieldValues).values(rows.slice(index, index + PRODUCT_AGGREGATE_INSERT_CHUNK)));
    }
    return statements;
}
