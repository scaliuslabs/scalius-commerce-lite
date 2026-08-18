import type { Database } from "@scalius/database/client";
import {
  catalogFeedRowUtf8Bytes,
  projectCatalogFeedRows,
  type CatalogFeedOmissionReason,
  type CatalogFeedProductInput,
  type CatalogFeedRow,
  type CatalogFeedRowProjection,
} from "@scalius/shared/catalog-feed-row";
import { normalizeCatalogDiscoveryBaseUrl } from "@scalius/shared/catalog-discovery-media";
import {
  getOptimizedImageUrl,
  type ImageContext,
} from "@scalius/shared/image-optimizer";
import type { SeoDiscoverySettings } from "@scalius/shared/seo-discovery";
import { ServiceUnavailableError, ValidationError } from "@scalius/core/errors";
import type { StorefrontFeedProduct } from "./products.types";
import {
  getEligibleStorefrontFeedProductById,
  getFeedProjectionDiagnosticById,
  type ProductFeedProjectionDiagnostic,
} from "./products.storefront";

export const PRODUCT_FEED_ROW_PREVIEW_MAX_LIMIT = 10;
export const PRODUCT_FEED_ROW_PREVIEW_MAX_OUTCOMES = 250;
export const PRODUCT_FEED_ROW_PREVIEW_MAX_PRODUCT_ID_LENGTH = 128;
export const PRODUCT_FEED_ROW_PREVIEW_MAX_SKU_LENGTH = 128;
export const PRODUCT_FEED_ROW_PREVIEW_MAX_CURSOR_LENGTH = 1024;
export const PRODUCT_FEED_ROW_PREVIEW_HARD_RESPONSE_BYTES = 48 * 1024;
// Keep 2 KiB below the HTTP ceiling for an agent transport wrapper.
export const PRODUCT_FEED_ROW_PREVIEW_RESPONSE_BUDGET_BYTES = 46 * 1024;
// Ten accepted rows leave 16 KiB for entry identities, pagination, cursor,
// semantics, and the success envelope. Larger exact rows become bounded
// preview_entry_too_large outcomes, so a 250-outcome product needs at most
// 25 calls instead of degenerating to one large outcome per response.
export const PRODUCT_FEED_ROW_PREVIEW_MAX_EMITTED_ROW_BYTES = 3 * 1024;

export const PRODUCT_FEED_ROW_PREVIEW_DIAGNOSTIC_REASONS = [
  "product_not_found",
  "sku_not_found",
  "sku_ambiguous",
  "feed_disabled",
  "storefront_url_unavailable",
] as const;

export const PRODUCT_FEED_ROW_PREVIEW_OMISSION_REASONS = [
  "excluded_from_product_feed",
  "inactive_product",
  "unavailable_product",
  "unavailable_variant",
  "unresolved_variant_shape",
  "missing_image",
  "non_positive_price",
  "input_bounds_exceeded",
  ...PRODUCT_FEED_ROW_PREVIEW_DIAGNOSTIC_REASONS,
] as const;

export type ProductFeedRowPreviewDiagnosticReason =
  | CatalogFeedOmissionReason
  | (typeof PRODUCT_FEED_ROW_PREVIEW_DIAGNOSTIC_REASONS)[number];

export interface ProductFeedRowPreviewMediaPolicy {
  enabled: boolean;
  canonicalCdnUrl: string;
  allowedImageHosts: readonly string[];
  canonicalHostAliases: readonly string[];
}

export interface ProductFeedRowPreviewSourceReaders {
  readEligible(
    db: Database,
    productId: string,
  ): Promise<StorefrontFeedProduct | null>;
  readDiagnostic(
    db: Database,
    productId: string,
    normalizedSku: string,
  ): Promise<ProductFeedProjectionDiagnostic | null>;
}

export type ProductFeedRowPreviewSource =
  | { kind: "eligible"; product: StorefrontFeedProduct }
  | { kind: "diagnostic"; diagnostic: ProductFeedProjectionDiagnostic }
  | { kind: "missing" };

export interface ProductFeedRowPreviewEmittedEntry {
  status: "emitted";
  productId: string;
  variantId: string | null;
  sku: string | null;
  row: CatalogFeedRow;
}

export interface ProductFeedRowPreviewOmittedEntry {
  status: "omitted";
  productId: string;
  variantId: string | null;
  sku: string | null;
  reason: ProductFeedRowPreviewDiagnosticReason;
}

export interface ProductFeedRowPreviewTooLargeEntry {
  status: "preview_entry_too_large";
  productId: string;
  variantId: string | null;
  sku: string | null;
  requiredBytes: number;
}

export type ProductFeedRowPreviewEntry =
  | ProductFeedRowPreviewEmittedEntry
  | ProductFeedRowPreviewOmittedEntry
  | ProductFeedRowPreviewTooLargeEntry;

export interface ProductFeedRowPreviewResult {
  productId: string;
  requestedSku: string | null;
  policy: {
    productCatalogEnabled: boolean;
    includeUnavailableProducts: boolean;
    variantStrategy: "products" | "variants";
  };
  entries: ProductFeedRowPreviewEntry[];
  pagination: {
    limit: number;
    returned: number;
    totalOutcomes: number;
    hasNextPage: boolean;
    nextCursor: string | null;
    responseTruncated: boolean;
  };
  semantics: {
    basis: "current_saved_state";
    emittedRowsAreExact: true;
    entryFieldsTruncated: false;
    cachedFeedPropagationVerified: false;
    providerAcceptanceVerified: false;
    pagesMayRaceWithWrites: true;
    responseBudgetBytes: number;
  };
}

export interface ExecuteProductFeedRowPreviewInput {
  db: Database;
  productId: string;
  sku?: string;
  cursor?: string;
  limit?: number;
  storefrontBaseUrl?: string | null;
  currencyCode: string;
  feedsPolicy: SeoDiscoverySettings["feeds"];
  mediaPolicy: ProductFeedRowPreviewMediaPolicy;
  environmentCdnUrl?: string | null;
  readers?: ProductFeedRowPreviewSourceReaders;
}

interface PreviewCursorPayload {
  v: 1;
  productId: string;
  variantStrategy: "products" | "variants";
  includeUnavailableProducts: boolean;
  state: string;
  position: number;
}

const DEFAULT_SOURCE_READERS: ProductFeedRowPreviewSourceReaders = {
  readEligible: getEligibleStorefrontFeedProductById,
  readDiagnostic: getFeedProjectionDiagnosticById,
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function utf8Bytes(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).byteLength;
}

function successEnvelopeBytes(result: ProductFeedRowPreviewResult): number {
  return utf8Bytes({ success: true, data: result });
}

function normalizedHost(value: string | null | undefined): string {
  const raw = value?.trim();
  if (!raw) return "";
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      (url.pathname && url.pathname !== "/") ||
      url.search ||
      url.hash
    ) {
      return "";
    }
    return url.hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function buildProductFeedRowPreviewImageContext(
  mediaPolicy: ProductFeedRowPreviewMediaPolicy,
  environmentCdnUrl?: string | null,
): ImageContext {
  const configuredHost = normalizedHost(mediaPolicy.canonicalCdnUrl);
  const environmentHost = normalizedHost(environmentCdnUrl);
  const canonicalHost = configuredHost || environmentHost;
  const cdnHosts = new Set<string>();
  for (const value of [
    configuredHost,
    environmentHost,
    ...mediaPolicy.allowedImageHosts.map(normalizedHost),
  ]) {
    if (value) cdnHosts.add(value);
  }

  return {
    enabled: mediaPolicy.enabled,
    cdnBase: canonicalHost ? `https://${canonicalHost}` : "",
    cdnHosts: [...cdnHosts],
    cdnHostAliases: mediaPolicy.canonicalHostAliases
      .map(normalizedHost)
      .filter(Boolean),
    isDev: false,
  };
}

function normalizedSkuIdentity(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase("en-US") ?? "";
}

function narrowDiscountType(
  value: string | null | undefined,
): "percentage" | "flat" | null {
  if (value === null || value === undefined) return null;
  if (value === "percentage" || value === "flat") return value;
  throw new ServiceUnavailableError(
    "A saved product discount type is unreadable. Re-save the product before previewing its feed row.",
  );
}

function toCatalogFeedProduct(
  product: StorefrontFeedProduct,
): CatalogFeedProductInput {
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    description: product.description,
    price: product.price,
    discountType: narrowDiscountType(product.discountType),
    discountPercentage: product.discountPercentage,
    discountAmount: product.discountAmount,
    freeDelivery: product.freeDelivery,
    isActive: true,
    availableForSale: product.availableForSale,
    excludeFromProductFeed: product.excludeFromProductFeed,
    hasVariants: product.hasVariants,
    imageUrl: product.imageUrl,
    canonicalPath: product.canonicalPath,
    productCondition: product.productCondition,
    category: product.category
      ? { slug: product.category.slug, name: product.category.name }
      : null,
    attributes: product.attributes.map((attribute) => ({
      name: attribute.name,
      value: attribute.value,
    })),
    variants: product.variants.map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      optionCombinationKey: variant.optionCombinationKey ?? null,
      imageId: variant.imageId,
      imageUrl: variant.imageUrl,
      selectedOptions: variant.selectedOptions.map((option) => ({
        name: option.name,
        value: option.value,
        standardMapping: option.standardMapping,
      })),
      price: variant.price,
      stock: variant.stock,
      reservedStock: variant.reservedStock,
      availabilityBand: variant.availabilityBand,
      isDefault: variant.isDefault,
      trackInventory: variant.trackInventory,
      barcode: variant.barcode,
      barcodeType: variant.barcodeType,
      discountType: narrowDiscountType(variant.discountType),
      discountPercentage: variant.discountPercentage,
      discountAmount: variant.discountAmount,
      deletedAt: variant.deletedAt,
    })),
  };
}

export async function readProductFeedRowPreviewSource(
  db: Database,
  productId: string,
  normalizedSku: string,
  readers: ProductFeedRowPreviewSourceReaders = DEFAULT_SOURCE_READERS,
): Promise<ProductFeedRowPreviewSource> {
  const eligible = await readers.readEligible(db, productId);
  if (eligible) return { kind: "eligible", product: eligible };

  const diagnostic = await readers.readDiagnostic(
    db,
    productId,
    normalizedSku,
  );
  return diagnostic
    ? { kind: "diagnostic", diagnostic }
    : { kind: "missing" };
}

function diagnosticReason(
  source: ProductFeedRowPreviewSource,
  skuWasRequested: boolean,
): ProductFeedRowPreviewDiagnosticReason | null {
  if (source.kind === "missing") return "product_not_found";
  if (source.kind !== "diagnostic") return null;
  if (skuWasRequested && source.diagnostic.matchingSkuCount === 0) {
    return "sku_not_found";
  }
  if (skuWasRequested && source.diagnostic.matchingSkuCount > 1) {
    return "sku_ambiguous";
  }
  if (
    !source.diagnostic.isActive ||
    source.diagnostic.isDeleted
  ) {
    return "inactive_product";
  }
  if (source.diagnostic.excludeFromProductFeed) {
    return "excluded_from_product_feed";
  }
  if (!source.diagnostic.hasBuyerResolvableSku) {
    return "unresolved_variant_shape";
  }
  if (!source.diagnostic.hasPrimaryDiscoveryImage) {
    return "missing_image";
  }
  return "unavailable_product";
}

function matchingExactSku(
  product: StorefrontFeedProduct,
  normalizedSku: string,
):
  | { kind: "none" }
  | { kind: "ambiguous" }
  | { kind: "one"; sku: string; variantId: string } {
  const matches = product.variants.filter(
    (variant) => normalizedSkuIdentity(variant.sku) === normalizedSku,
  );
  if (matches.length === 0) return { kind: "none" };
  if (matches.length !== 1) return { kind: "ambiguous" };
  return {
    kind: "one",
    sku: matches[0]!.sku,
    variantId: matches[0]!.id,
  };
}

function orderedProjectionEntries(
  projection: CatalogFeedRowProjection,
  product: CatalogFeedProductInput,
  requestedSku: string | null,
): ProductFeedRowPreviewEntry[] {
  if (projection.omissionsTruncated) {
    throw new ServiceUnavailableError(
      "The feed preview could not report every product outcome safely.",
    );
  }
  const variantOrder = new Map(
    (product.variants ?? []).map((variant, index) => [variant.id, index]),
  );
  const skuByVariant = new Map(
    (product.variants ?? []).map((variant) => [
      variant.id,
      variant.sku?.trim() || null,
    ]),
  );
  const entries: ProductFeedRowPreviewEntry[] = [
    ...projection.rows.map((row) => ({
      status: "emitted" as const,
      productId: row.productId,
      variantId: row.variantId,
      sku:
        row.variantId
          ? requestedSku ?? skuByVariant.get(row.variantId) ?? null
          : null,
      row,
    })),
    ...projection.omissions.map((omission) => ({
      status: "omitted" as const,
      productId: omission.productId,
      variantId: omission.variantId,
      sku:
        omission.variantId
          ? requestedSku ?? skuByVariant.get(omission.variantId) ?? null
          : null,
      reason: omission.reason,
    })),
  ];
  return entries.sort((left, right) => {
    const leftIndex = left.variantId
      ? variantOrder.get(left.variantId) ?? Number.MAX_SAFE_INTEGER
      : -1;
    const rightIndex = right.variantId
      ? variantOrder.get(right.variantId) ?? Number.MAX_SAFE_INTEGER
      : -1;
    return leftIndex - rightIndex;
  });
}

function toBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function projectionState(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(JSON.stringify(value)),
  );
  return toBase64Url(new Uint8Array(digest).slice(0, 16));
}

function encodeCursor(payload: PreviewCursorPayload): string {
  return `feed-preview-v1.${toBase64Url(
    textEncoder.encode(JSON.stringify(payload)),
  )}`;
}

function decodeCursor(value: string): PreviewCursorPayload {
  const match = /^feed-preview-v1\.([A-Za-z0-9_-]+)$/u.exec(value);
  if (!match?.[1]) throw new ValidationError("Invalid feed preview cursor.");
  try {
    const parsed = JSON.parse(
      textDecoder.decode(fromBase64Url(match[1])),
    ) as Partial<PreviewCursorPayload>;
    if (
      parsed.v !== 1 ||
      typeof parsed.productId !== "string" ||
      (parsed.variantStrategy !== "products" &&
        parsed.variantStrategy !== "variants") ||
      typeof parsed.includeUnavailableProducts !== "boolean" ||
      typeof parsed.state !== "string" ||
      !Number.isSafeInteger(parsed.position) ||
      (parsed.position ?? -1) < 0
    ) {
      throw new Error("invalid cursor payload");
    }
    return parsed as PreviewCursorPayload;
  } catch {
    throw new ValidationError("Invalid feed preview cursor.");
  }
}

export function validateProductFeedRowPreviewCursor(
  value: string | undefined,
): void {
  if (value === undefined) return;
  if (
    !value ||
    value.length > PRODUCT_FEED_ROW_PREVIEW_MAX_CURSOR_LENGTH
  ) {
    throw new ValidationError("Invalid feed preview cursor.");
  }
  decodeCursor(value);
}

function baseResult(
  input: {
    productId: string;
    requestedSku: string | null;
    feedsPolicy: SeoDiscoverySettings["feeds"];
    limit: number;
  },
  entries: ProductFeedRowPreviewEntry[],
  totalOutcomes: number,
  nextCursor: string | null,
  responseTruncated: boolean,
): ProductFeedRowPreviewResult {
  return {
    productId: input.productId,
    requestedSku: input.requestedSku,
    policy: {
      productCatalogEnabled: input.feedsPolicy.productCatalogEnabled,
      includeUnavailableProducts:
        input.feedsPolicy.includeUnavailableProducts,
      variantStrategy: input.feedsPolicy.variantStrategy,
    },
    entries,
    pagination: {
      limit: input.limit,
      returned: entries.length,
      totalOutcomes,
      hasNextPage: nextCursor !== null,
      nextCursor,
      responseTruncated,
    },
    semantics: {
      basis: "current_saved_state",
      emittedRowsAreExact: true,
      entryFieldsTruncated: false,
      cachedFeedPropagationVerified: false,
      providerAcceptanceVerified: false,
      pagesMayRaceWithWrites: true,
      responseBudgetBytes:
        PRODUCT_FEED_ROW_PREVIEW_RESPONSE_BUDGET_BYTES,
    },
  };
}

async function nextCursor(
  input: {
    productId: string;
    feedsPolicy: SeoDiscoverySettings["feeds"];
  },
  state: string,
  position: number,
  totalOutcomes: number,
): Promise<string | null> {
  if (position >= totalOutcomes) return null;
  const boundState = await projectionState({
    state,
    productId: input.productId,
    variantStrategy: input.feedsPolicy.variantStrategy,
    includeUnavailableProducts:
      input.feedsPolicy.includeUnavailableProducts,
    position,
  });
  return encodeCursor({
    v: 1,
    productId: input.productId,
    variantStrategy: input.feedsPolicy.variantStrategy,
    includeUnavailableProducts:
      input.feedsPolicy.includeUnavailableProducts,
    state: boundState,
    position,
  });
}

async function assertCursorContext(
  cursor: PreviewCursorPayload,
  input: {
    productId: string;
    feedsPolicy: SeoDiscoverySettings["feeds"];
  },
  state: string,
  totalOutcomes: number,
): Promise<void> {
  const expectedState = await projectionState({
    state,
    productId: input.productId,
    variantStrategy: input.feedsPolicy.variantStrategy,
    includeUnavailableProducts:
      input.feedsPolicy.includeUnavailableProducts,
    position: cursor.position,
  });
  if (
    cursor.productId !== input.productId ||
    cursor.variantStrategy !== input.feedsPolicy.variantStrategy ||
    cursor.includeUnavailableProducts !==
      input.feedsPolicy.includeUnavailableProducts ||
    cursor.state !== expectedState ||
    cursor.position > totalOutcomes
  ) {
    throw new ValidationError(
      "The feed preview cursor is stale or does not match this product and policy.",
    );
  }
}

async function boundSingleEntry(
  entry: ProductFeedRowPreviewEntry,
  input: {
    productId: string;
    requestedSku: string | null;
    feedsPolicy: SeoDiscoverySettings["feeds"];
    limit: number;
  },
  state: string,
  position: number,
  totalOutcomes: number,
): Promise<ProductFeedRowPreviewEntry> {
  if (entry.status !== "emitted") return entry;
  const single = baseResult(
    input,
    [entry],
    totalOutcomes,
    await nextCursor(input, state, position + 1, totalOutcomes),
    false,
  );
  const requiredBytes = successEnvelopeBytes(single);
  if (
    requiredBytes <= PRODUCT_FEED_ROW_PREVIEW_RESPONSE_BUDGET_BYTES &&
    catalogFeedRowUtf8Bytes(entry.row) <=
      PRODUCT_FEED_ROW_PREVIEW_MAX_EMITTED_ROW_BYTES
  ) {
    return entry;
  }
  return {
    status: "preview_entry_too_large",
    productId: entry.productId,
    variantId: entry.variantId,
    sku: entry.sku,
    requiredBytes,
  };
}

async function paginateOutcomes(
  input: {
    productId: string;
    requestedSku: string | null;
    feedsPolicy: SeoDiscoverySettings["feeds"];
    limit: number;
    cursorPayload: PreviewCursorPayload | null;
  },
  outcomes: ProductFeedRowPreviewEntry[],
  state: string,
): Promise<ProductFeedRowPreviewResult> {
  const decoded = input.cursorPayload;
  if (decoded) {
    await assertCursorContext(decoded, input, state, outcomes.length);
  }
  const start = decoded?.position ?? 0;
  const selected: ProductFeedRowPreviewEntry[] = [];
  let responseTruncated = false;
  let position = start;

  while (
    position < outcomes.length &&
    selected.length < input.limit
  ) {
    const entry = await boundSingleEntry(
      outcomes[position]!,
      input,
      state,
      position,
      outcomes.length,
    );
    const candidate = [...selected, entry];
    const candidateResult = baseResult(
      input,
      candidate,
      outcomes.length,
      await nextCursor(input, state, position + 1, outcomes.length),
      false,
    );
    if (
      successEnvelopeBytes(candidateResult) >
      PRODUCT_FEED_ROW_PREVIEW_RESPONSE_BUDGET_BYTES
    ) {
      responseTruncated = true;
      break;
    }
    selected.push(entry);
    position += 1;
  }

  const result = baseResult(
    input,
    selected,
    outcomes.length,
    await nextCursor(input, state, position, outcomes.length),
    responseTruncated,
  );
  if (
    successEnvelopeBytes(result) >
      PRODUCT_FEED_ROW_PREVIEW_HARD_RESPONSE_BYTES ||
    (selected.length === 0 && position < outcomes.length)
  ) {
    throw new ServiceUnavailableError(
      "The feed preview response could not fit its bounded envelope.",
    );
  }
  return result;
}

function oneOmission(
  productId: string,
  requestedSku: string | null,
  reason: ProductFeedRowPreviewDiagnosticReason,
): ProductFeedRowPreviewEntry[] {
  return [
    {
      status: "omitted",
      productId,
      variantId: null,
      sku: requestedSku,
      reason,
    },
  ];
}

export async function executeProductFeedRowPreview(
  input: ExecuteProductFeedRowPreviewInput,
): Promise<ProductFeedRowPreviewResult> {
  const productId = input.productId.trim();
  if (
    !productId ||
    productId.length > PRODUCT_FEED_ROW_PREVIEW_MAX_PRODUCT_ID_LENGTH
  ) {
    throw new ValidationError("Use an exact bounded product ID.");
  }
  const requestedSku = input.sku?.trim() || null;
  if (
    requestedSku &&
    requestedSku.length > PRODUCT_FEED_ROW_PREVIEW_MAX_SKU_LENGTH
  ) {
    throw new ValidationError("Use an exact bounded SKU.");
  }
  const normalizedSku = normalizedSkuIdentity(requestedSku ?? undefined);
  const limit = input.limit ?? PRODUCT_FEED_ROW_PREVIEW_MAX_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > PRODUCT_FEED_ROW_PREVIEW_MAX_LIMIT
  ) {
    throw new ValidationError(
      `Feed preview limit must be between 1 and ${PRODUCT_FEED_ROW_PREVIEW_MAX_LIMIT}.`,
    );
  }
  validateProductFeedRowPreviewCursor(input.cursor);
  // Decode and shape-check opaque cursors before touching D1. Their bound
  // product/policy/state is checked after the current projection is known.
  const cursorPayload = input.cursor ? decodeCursor(input.cursor) : null;

  const baseInput = {
    productId,
    requestedSku,
    feedsPolicy: input.feedsPolicy,
    limit,
    cursorPayload,
  };

  if (!input.feedsPolicy.productCatalogEnabled) {
    const outcomes = oneOmission(productId, requestedSku, "feed_disabled");
    const state = await projectionState({
      productId,
      feedsPolicy: input.feedsPolicy,
      requestedSku,
    });
    return paginateOutcomes(baseInput, outcomes, state);
  }

  const storefrontBaseUrl = normalizeCatalogDiscoveryBaseUrl(
    input.storefrontBaseUrl,
  );
  if (!storefrontBaseUrl) {
    const outcomes = oneOmission(
      productId,
      requestedSku,
      "storefront_url_unavailable",
    );
    const state = await projectionState({
      productId,
      feedsPolicy: input.feedsPolicy,
      requestedSku,
      storefrontBaseUrl: null,
    });
    return paginateOutcomes(baseInput, outcomes, state);
  }

  // Keep the normal public feed lookup and its five-lane enrichment isolated;
  // only run the diagnostic fallback after it returns no exact product ID.
  const source = await readProductFeedRowPreviewSource(
    input.db,
    productId,
    normalizedSku,
    input.readers,
  );
  const sourceReason = diagnosticReason(source, requestedSku !== null);
  if (sourceReason) {
    const outcomes = oneOmission(productId, requestedSku, sourceReason);
    const state = await projectionState({
      source,
      feedsPolicy: input.feedsPolicy,
      requestedSku,
    });
    return paginateOutcomes(baseInput, outcomes, state);
  }
  if (source.kind !== "eligible") {
    throw new ServiceUnavailableError("Product feed preview is unavailable.");
  }

  let exactSkuMatch: Extract<
    ReturnType<typeof matchingExactSku>,
    { kind: "one" }
  > | null = null;
  if (requestedSku) {
    const exactSku = matchingExactSku(source.product, normalizedSku);
    if (exactSku.kind !== "one") {
      const outcomes = oneOmission(
        productId,
        requestedSku,
        exactSku.kind === "ambiguous" ? "sku_ambiguous" : "sku_not_found",
      );
      const state = await projectionState({
        source: source.product.id,
        exactSku,
        feedsPolicy: input.feedsPolicy,
        requestedSku,
      });
      return paginateOutcomes(baseInput, outcomes, state);
    }
    exactSkuMatch = exactSku;
  }

  const imageContext = buildProductFeedRowPreviewImageContext(
    input.mediaPolicy,
    input.environmentCdnUrl,
  );
  const product = toCatalogFeedProduct(source.product);
  if (requestedSku && input.feedsPolicy.variantStrategy === "variants") {
    product.variants = (product.variants ?? []).filter(
      (variant) => normalizedSkuIdentity(variant.sku ?? undefined) === normalizedSku,
    );
  }
  const projection = projectCatalogFeedRows({
    products: [product],
    storefrontBaseUrl,
    currencyCode: input.currencyCode,
    policy: {
      variantStrategy: input.feedsPolicy.variantStrategy,
      includeUnavailableProducts:
        input.feedsPolicy.includeUnavailableProducts,
    },
    transformImageUrl: (sourceUrl, options) =>
      getOptimizedImageUrl(sourceUrl, options, imageContext),
    maxReportedOmissions: 250,
  });
  const outcomes = orderedProjectionEntries(
    projection,
    product,
    exactSkuMatch?.sku ?? null,
  );
  const state = await projectionState({
    product,
    feedsPolicy: input.feedsPolicy,
    storefrontBaseUrl,
    currencyCode: input.currencyCode,
    imageContext,
  });
  return paginateOutcomes(baseInput, outcomes, state);
}
