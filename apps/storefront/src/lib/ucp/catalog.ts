import { getVariantDiscountedPrice } from "@/components/product/lib/pricing-engine";
import { roundPriceToPrecision } from "@scalius/shared/price-utils";
import { resolvePriceIncrementMinor } from "@scalius/shared/currency-policy";
import { getFeedProducts, type FeedProductPage } from "@/lib/api/products";
import { AGENTS_CHANNEL_ID } from "@scalius/shared/sales-channels";
import { getLayoutData, type CurrencyData, type LayoutData } from "@/lib/api/storefront";
import type { Product, ProductVariant } from "@/lib/api/types";
import { renderForPresence, setRuntimeImageCdnPolicy } from "@/lib/api/runtime";
import { resolveMediaUrl } from "@/lib/media-url";
import {
  availableQuantityForVariant,
  isVariantAvailable,
  resolveBuyerVariants,
} from "@/lib/product-sellable-variants";
import { getBaseUrl, xmlDataUnavailableResponse } from "@/lib/sitemap-utils";
import { normalizeResourceCanonicalPath } from "@scalius/shared/seo-canonical";
import { resolveCatalogDiscoveryImageUrl } from "@scalius/shared/catalog-discovery-media";
import { DEFAULT_CURRENCY } from "@scalius/shared/currency";
import { htmlToPlainText } from "@scalius/shared/html-sanitize";
import { presenceOfPath, presencePath, stripPresencePath } from "@scalius/shared/markets";
import { resolveUcpPresence } from "./context";
import { buildUcpPolicies, buildUcpSeller, type UcpPolicy, type UcpSeller } from "./merchant";

/** The UCP release this storefront implements (https://ucp.dev/2026-08-25/). */
export const UCP_VERSION = "2026-08-25";
export const UCP_SHOPPING_SERVICE = "dev.ucp.shopping";
export const UCP_CATALOG_SEARCH_CAPABILITY =
  "dev.ucp.shopping.catalog.search";
export const UCP_CATALOG_LOOKUP_CAPABILITY =
  "dev.ucp.shopping.catalog.lookup";
/** The UCP REST binding's base path; operations are `/catalog/{search,lookup,product}` under it. */
export const UCP_REST_PATH = "/ucp";
/** The UCP MCP binding (JSON-RPC `tools/call` of search_catalog, lookup_catalog, get_product). */
export const UCP_MCP_PATH = "/ucp/mcp";

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
export const MAX_LOOKUP_IDS = 25;
const MAX_UCP_BODY_BYTES = 64 * 1024;
const MAX_ECHOED_IDENTIFIER_LENGTH = 256;
const GID_PREFIX = "gid://scalius/";
type UcpStatus = "success" | "error";
type UcpMessageType = "info" | "warning" | "error";
type VariantMatchMode = "featured" | "exact";
export type UcpErrorSeverity =
  | "recoverable"
  | "requires_buyer_input"
  | "requires_buyer_review"
  | "unrecoverable";

export interface UcpMessage {
  type: UcpMessageType;
  code: string;
  content: string;
  path?: string;
  severity?: UcpErrorSeverity;
}

interface UcpPrice {
  amount: number;
  currency: string;
}

interface UcpRating {
  value: number;
  scale_min: number;
  scale_max: number;
  count: number;
}

interface UcpVariant {
  id: string;
  title: string;
  description: { plain?: string; html?: string };
  price: UcpPrice;
  list_price?: UcpPrice;
  sku?: string;
  barcodes?: Array<{ type: string; value: string }>;
  handle?: string;
  url?: string;
  availability?: {
    available: boolean;
    status: "in_stock" | "out_of_stock";
  };
  options?: Array<{ name: string; label: string }>;
  media?: Array<{ type: "image"; url: string; alt_text?: string }>;
  metadata?: Record<string, unknown>;
  seller?: UcpSeller;
  inputs?: Array<{ id: string; match?: VariantMatchMode }>;
}

interface UcpProduct {
  id: string;
  title: string;
  description: { plain?: string; html?: string };
  url?: string;
  handle?: string;
  price_range: { min: UcpPrice; max: UcpPrice };
  list_price_range?: { min: UcpPrice; max: UcpPrice };
  variants: UcpVariant[];
  selected?: Array<{ name: string; label: string }>;
  options?: Array<{
    name: string;
    values: Array<{ label: string; available?: boolean; exists?: boolean }>;
  }>;
  categories?: Array<{ value: string; taxonomy?: "merchant" }>;
  media?: Array<{ type: "image"; url: string; alt_text?: string }>;
  rating?: UcpRating;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface UcpCatalogContext {
  baseUrl: string;
  /** The subfolder presence the request is answered in; `''` is the root. */
  presence: string;
  currency: Required<Pick<CurrencyData, "code" | "decimalPlaces" | "priceIncrementMinor">>;
  /** Why buyer context was not honoured; appended to every successful response. */
  messages: UcpMessage[];
  /** The store's response-wide policies (the return policy when enabled). */
  policies: UcpPolicy[];
  /** The seller of every variant, from Business settings; null without a store name. */
  seller: UcpSeller | null;
}

interface LookupInput {
  original: string;
  normalized: string;
}

interface UcpRequestBase {
  ucp?: { version?: unknown };
  context?: unknown;
}

interface SearchRequestBody extends UcpRequestBase {
  query?: unknown;
  filters?: unknown;
  pagination?: unknown;
}

interface LookupRequestBody extends UcpRequestBase {
  ids?: unknown;
}

interface ProductRequestBody extends UcpRequestBase {
  id?: unknown;
  selected?: unknown;
  preferences?: unknown;
}

export type UcpOperation = "search" | "lookup" | "product";

/** A catalog response body (search, batch lookup, get_product, or an error). */
export interface UcpResponseBody {
  ucp: {
    version: string;
    status: UcpStatus;
    capabilities?: Record<string, Array<{ version: string }>>;
  };
  products?: UcpProduct[];
  product?: UcpProduct;
  pagination?: { has_next_page: boolean; cursor?: string };
  messages?: UcpMessage[];
  policies?: UcpPolicy[];
}

/** Search and batch lookup always carry their product list, empty on an error. */
export type UcpListBody = UcpResponseBody & { products: UcpProduct[] };

/** One catalog operation's outcome: the HTTP status the REST binding answers with, and the UCP body. */
export interface UcpOperationResult<Body extends UcpResponseBody = UcpResponseBody> {
  status: number;
  body: Body;
}

const OPERATION_CAPABILITY: Record<UcpOperation, string> = {
  search: UCP_CATALOG_SEARCH_CAPABILITY,
  lookup: UCP_CATALOG_LOOKUP_CAPABILITY,
  product: UCP_CATALOG_LOOKUP_CAPABILITY,
};

function ucpMetadata(status: UcpStatus, capability?: string) {
  return {
    version: UCP_VERSION,
    status,
    ...(capability ? { capabilities: { [capability]: [{ version: UCP_VERSION }] } } : {}),
  };
}

function capabilityDescriptor(name: string) {
  const suffix = name === UCP_CATALOG_SEARCH_CAPABILITY
    ? { spec: "shopping/catalog/search", schema: "catalog_search" }
    : { spec: "shopping/catalog/lookup", schema: "catalog_lookup" };
  return {
    version: UCP_VERSION,
    spec: `https://ucp.dev/${UCP_VERSION}/specification/${suffix.spec}`,
    schema: `https://ucp.dev/${UCP_VERSION}/schemas/shopping/${suffix.schema}.json`,
  };
}

function serviceDescriptor(transport: "rest" | "mcp", endpoint: string) {
  return {
    version: UCP_VERSION,
    transport,
    endpoint,
    spec: `https://ucp.dev/${UCP_VERSION}/specification/overview`,
    schema: transport === "rest"
      ? `https://ucp.dev/${UCP_VERSION}/services/shopping/rest.openapi.json`
      : `https://ucp.dev/${UCP_VERSION}/services/shopping/mcp.openrpc.json`,
  };
}

/**
 * The business profile at `/.well-known/ucp`: catalog search and lookup over
 * the REST and MCP bindings, and nothing that changes state. The payment
 * handler registry is required and stays empty; there is no checkout, so no
 * signing keys and no older version to link.
 */
export function buildUcpProfile(baseUrl: string) {
  return {
    ucp: {
      version: UCP_VERSION,
      services: {
        [UCP_SHOPPING_SERVICE]: [
          serviceDescriptor("rest", `${baseUrl}${UCP_REST_PATH}`),
          serviceDescriptor("mcp", `${baseUrl}${UCP_MCP_PATH}`),
        ],
      },
      capabilities: {
        [UCP_CATALOG_SEARCH_CAPABILITY]: [capabilityDescriptor(UCP_CATALOG_SEARCH_CAPABILITY)],
        [UCP_CATALOG_LOOKUP_CAPABILITY]: [capabilityDescriptor(UCP_CATALOG_LOOKUP_CAPABILITY)],
      },
      payment_handlers: {},
    },
  };
}

export function getUcpBaseUrl(): string {
  const baseUrl = getBaseUrl();
  if (!baseUrl.startsWith("https://")) {
    throw new Error("UCP discovery requires an absolute HTTPS storefront origin");
  }
  return baseUrl;
}

function ucpBaseUrlOrNull(): string | null {
  try {
    return getUcpBaseUrl();
  } catch {
    return null;
  }
}

export const UCP_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type,Accept,UCP-Agent,Request-Id,Idempotency-Key,Content-Digest,Signature,Signature-Input,MCP-Protocol-Version,Mcp-Method,Mcp-Name",
} as const;

const NO_STORE = "private, no-cache, no-store, must-revalidate";

export function ucpJsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
      ...UCP_CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

export function ucpOptionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: { ...UCP_CORS_HEADERS, "Access-Control-Max-Age": "86400" },
  });
}

function errorBody(
  code: string,
  content: string,
  { path, severity = "recoverable", capability }: { path?: string; severity?: UcpErrorSeverity; capability?: string } = {},
) {
  return {
    ucp: ucpMetadata("error", capability),
    messages: [{ type: "error" as const, code, content, severity, ...(path ? { path } : {}) }],
  };
}

export function ucpErrorResponse(
  status: number,
  code: string,
  content: string,
  path?: string,
  severity: UcpErrorSeverity = "recoverable",
): Response {
  const continueUrl = ucpBaseUrlOrNull();
  return ucpJsonResponse(
    { ...errorBody(code, content, { path, severity }), ...(continueUrl ? { continue_url: `${continueUrl}/` } : {}) },
    status,
    { "Cache-Control": NO_STORE },
  );
}

export function ucpProfileUnavailableResponse(): Response {
  return xmlDataUnavailableResponse("UCP profile is temporarily unavailable");
}

/** The store has no https web address yet: permanent until the merchant sets one, so no retry is offered. */
export const UCP_NEEDS_STORE_URL =
  "UCP discovery is off: the store has no https web address. The merchant sets its Store URL in Settings, Store details, Web addresses.";

export function ucpProfileNotConfiguredResponse(): Response {
  return ucpErrorResponse(404, "not_configured", UCP_NEEDS_STORE_URL, undefined, "unrecoverable");
}

function layoutCurrency(layout: LayoutData): UcpCatalogContext["currency"] {
  const code = (layout.currency?.code ?? DEFAULT_CURRENCY.code).toUpperCase();
  const decimalPlaces = Number.isInteger(layout.currency?.decimalPlaces)
    ? layout.currency!.decimalPlaces!
    : DEFAULT_CURRENCY.decimalPlaces;
  // UCP prices are what checkout charges: at the page market's increment.
  const priceIncrementMinor = resolvePriceIncrementMinor(code, layout.currency?.priceIncrementMinor);
  return { code, decimalPlaces, priceIncrementMinor };
}

/**
 * The market, currency, policies and seller a catalog request is answered
 * with. The buyer context picks a presence (lib/ucp/context.ts); every read
 * after that runs under it, as the presence page's reads do (its layout's
 * currency, the feed priced and translated in its market). A store with only
 * its root, or a request without context, reads exactly what it read before.
 */
export async function getUcpCatalogContext(buyerContext?: unknown): Promise<UcpCatalogContext | null> {
  const baseUrl = ucpBaseUrlOrNull();
  if (!baseUrl) return null;

  let layout = await getLayoutData();
  if (!layout) return null;

  const resolution = resolveUcpPresence(layout.markets, layoutCurrency(layout).code, buyerContext);
  if (resolution.presence) {
    renderForPresence(resolution.presence);
    layout = await getLayoutData();
    if (!layout) return null;
  }
  setRuntimeImageCdnPolicy(layout.media);

  const policies = buildUcpPolicies(layout.seo?.returnPolicy, baseUrl, layout.business?.country);
  return {
    baseUrl,
    presence: resolution.presence,
    currency: layoutCurrency(layout),
    messages: resolution.messages,
    policies,
    seller: buildUcpSeller(layout.business, policies),
  };
}

// ---------------------------------------------------------------------------
// Negotiation
// ---------------------------------------------------------------------------

export interface UcpNegotiationError {
  /** REST status (`invalid_profile_url` 400, `version_unsupported` 422). */
  status: number;
  code: "invalid_profile_url" | "version_unsupported";
  content: string;
  path?: string;
  severity: UcpErrorSeverity;
}

/** The `profile` member of a `UCP-Agent` structured-field dictionary, or null. */
export function ucpAgentProfileFromHeader(header: string | null | undefined): string | null {
  const value = header?.trim();
  if (!value) return null;
  const member = /(?:^|,)\s*profile\s*=\s*"([^"\\]*)"\s*(?:;[^,]*)?\s*(?=,|$)/i.exec(value);
  return member?.[1] ?? null;
}

/**
 * The platform profile and protocol version check every catalog request
 * passes before any read (UCP overview, Negotiation): the profile must be an
 * HTTPS URL, and a declared version must be this one.
 */
export function negotiateUcpRequest(
  profile: unknown,
  body: UcpRequestBase,
): UcpNegotiationError | null {
  let parsed: URL | null = null;
  try {
    parsed = typeof profile === "string" && profile ? new URL(profile) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.protocol !== "https:") {
    return {
      status: 400,
      code: "invalid_profile_url",
      content: "A UCP platform profile is required: send UCP-Agent: profile=\"https://...\" (REST) or meta[\"ucp-agent\"].profile (MCP).",
      severity: "recoverable",
    };
  }
  const requestedVersion = body.ucp?.version;
  if (typeof requestedVersion === "string" && requestedVersion !== UCP_VERSION) {
    return {
      status: 422,
      code: "version_unsupported",
      path: "$.ucp.version",
      content: `UCP version ${requestedVersion.slice(0, 32)} is not supported. This business implements version ${UCP_VERSION}.`,
      severity: "unrecoverable",
    };
  }
  return null;
}

/** A JSON body of at most 64 KiB, or undefined when it is missing, larger, or not JSON. */
export async function readJsonBody(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength) {
    const parsedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > MAX_UCP_BODY_BYTES
    ) {
      return undefined;
    }
  }

  try {
    if (!request.body) return undefined;
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalLength = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalLength += value.byteLength;
      if (totalLength > MAX_UCP_BODY_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function parseJsonBody<T>(request: Request): Promise<T | null> {
  const body = await readJsonBody(request);
  return isJsonObject(body) ? (body as T) : null;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function stripHtml(text: string | null | undefined): string {
  return htmlToPlainText(text);
}

function productDescription(product: Product) {
  const plain = stripHtml(product.description) || product.name;
  const description: { plain?: string; html?: string } = { plain };
  if (product.description && /<[^>]+>/.test(product.description)) {
    description.html = product.description;
  }
  return description;
}

function toMinorUnits(amount: number, currency: UcpCatalogContext["currency"]): number {
  const multiplier = 10 ** currency.decimalPlaces;
  const roundedAmount = roundPriceToPrecision(amount, currency.decimalPlaces);
  return Math.max(0, Math.round(roundedAmount * multiplier));
}

function price(amount: number, context: UcpCatalogContext): UcpPrice {
  return {
    amount: toMinorUnits(amount, context.currency),
    currency: context.currency.code,
  };
}

function productGid(id: string): string {
  return `${GID_PREFIX}product/${id}`;
}

function variantGid(id: string): string {
  return `${GID_PREFIX}product-variant/${id}`;
}

function normalizeLookupValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  if (trimmed.startsWith(`${GID_PREFIX}product-variant/`)) {
    return trimmed.slice(`${GID_PREFIX}product-variant/`.length);
  }
  if (trimmed.startsWith(`${GID_PREFIX}variant/`)) {
    return trimmed.slice(`${GID_PREFIX}variant/`.length);
  }
  if (trimmed.startsWith(`${GID_PREFIX}product/`)) {
    return trimmed.slice(`${GID_PREFIX}product/`.length);
  }
  return trimmed;
}

function uniqueStrings(values: string[], max = MAX_LOOKUP_IDS): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).slice(0, max);
}

function uniqueLookupIdentifiers(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function selectedOptions(variant: ProductVariant) {
  return variant.selectedOptions.map((option) => ({ name: option.name, label: option.value }));
}

function productOptions(product: Product, variants: ProductVariant[]) {
  const names = product.options?.map((option) => option.name)
    ?? uniqueStrings(variants.flatMap((variant) => variant.selectedOptions.map((option) => option.name)));
  const options = names.map((name) => ({
    name,
    values: uniqueStrings(variants.flatMap((variant) => variant.selectedOptions
      .filter((option) => namesMatch(option.name, name))
      .map((option) => option.value))).map((label) => ({ label })),
  })).filter((option) => option.values.length > 0);
  return options.length > 0 ? options : undefined;
}

function namesMatch(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function labelsMatch(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function variantMatchesSelection(
  variant: UcpVariant,
  selected: Array<{ name: string; label: string }>,
): boolean {
  return selected.every((selection) =>
    variant.options?.some((option) =>
      namesMatch(option.name, selection.name) &&
      labelsMatch(option.label, selection.label)
    ) ?? false
  );
}

function detailOptionValues(
  product: UcpProduct,
  optionName: string,
  selected: Array<{ name: string; label: string }>,
  values: Array<{ label: string }>,
) {
  const selectedOtherOptions = selected.filter((selection) =>
    !namesMatch(selection.name, optionName)
  );

  return values.map(({ label }) => {
    const candidateSelection = [
      ...selectedOtherOptions,
      { name: optionName, label },
    ];
    const matchingVariants = product.variants.filter((variant) =>
      variantMatchesSelection(variant, candidateSelection)
    );

    return {
      label,
      exists: matchingVariants.length > 0,
      available: matchingVariants.some((variant) => variant.availability?.available === true),
    };
  });
}

/**
 * The detail product's effective selections and the availability of every
 * option value relative to them: the buyer's (relaxed) selections when they
 * named some, else the featured variant's full option set.
 */
function withDetailSelections(
  product: UcpProduct,
  effective: Array<{ name: string; label: string }> = [],
): UcpProduct {
  if (!product.options || product.options.length === 0) return product;

  const selected = effective.length > 0 ? effective : product.variants[0]?.options ?? [];
  if (selected.length === 0) return product;

  return {
    ...product,
    selected,
    options: product.options.map((option) => ({
      ...option,
      values: detailOptionValues(product, option.name, selected, option.values),
    })),
  };
}

function productPath(product: Product, presence: string): string {
  const path =
    normalizeResourceCanonicalPath("product", product.canonicalPath) ??
    `/products/${product.slug}`;
  // The presence page: its market's prices, its language's handle.
  return presencePath(presence, path);
}

function productUrl(product: Product, context: UcpCatalogContext): string {
  return new URL(productPath(product, context.presence), `${context.baseUrl}/`).toString();
}

function variantUrl(product: Product, variant: ProductVariant, context: UcpCatalogContext): string {
  const url = new URL(productUrl(product, context));
  url.searchParams.set("variant", variant.id);
  return url.toString();
}

function catalogMedia(
  imageUrl: string | null | undefined,
  baseUrl: string,
  altText?: string | null,
) {
  const url = resolveCatalogDiscoveryImageUrl(imageUrl, baseUrl, {
    resolveImageUrl: resolveMediaUrl,
  });
  if (!url) return undefined;

  return [{
    type: "image" as const,
    url,
    ...(altText ? { alt_text: altText } : {}),
  }];
}

function primaryMedia(product: Product, baseUrl: string) {
  return catalogMedia(product.imageUrl, baseUrl, product.imageAlt);
}

function variantMedia(
  product: Product,
  variant: ProductVariant,
  baseUrl: string,
) {
  if (!variant.imageId) return undefined;
  return catalogMedia(
    variant.imageUrl,
    baseUrl,
    variantTitle(product, variant),
  );
}

function supportedBarcode(variant: ProductVariant) {
  const value = variant.barcode?.trim();
  if (!value) return undefined;

  const type = variant.barcodeType?.toLowerCase();
  if (type === "upc") return [{ type: "UPC", value }];
  if (type === "ean13") return [{ type: "EAN", value }];
  if (type === "isbn") return [{ type: "ISBN", value }];
  if (type === "gtin") return [{ type: "GTIN", value }];
  return undefined;
}

function variantPrices(
  product: Product,
  variant: ProductVariant,
  context: UcpCatalogContext,
) {
  const basePrice = roundPriceToPrecision(
    variant.price ?? product.price,
    context.currency.decimalPlaces,
  );
  // The product page's rule (pages/products/[slug].astro), in the page market's currency.
  const finalPrice = getVariantDiscountedPrice(
    variant.price,
    product.price,
    variant.discountType,
    variant.discountPercentage,
    variant.discountAmount,
    product.discountType,
    product.discountPercentage,
    product.discountAmount,
    context.currency.decimalPlaces,
    context.currency.code,
    context.currency.priceIncrementMinor,
  );

  return {
    listPrice: price(basePrice, context),
    finalPrice: price(finalPrice, context),
    hasDiscount: finalPrice < basePrice,
  };
}

function hasPositiveVariantPricing(
  product: Product,
  variant: ProductVariant,
  context: UcpCatalogContext,
): boolean {
  const pricing = variantPrices(product, variant, context);
  return pricing.listPrice.amount > 0 && pricing.finalPrice.amount > 0;
}

function variantTitle(product: Product, variant: ProductVariant): string {
  const options = selectedOptions(variant);
  if (options.length === 0) return product.name;
  return `${product.name} - ${options.map((option) => `${option.name}: ${option.label}`).join(" / ")}`;
}

function mapVariant(
  product: Product,
  variant: ProductVariant,
  context: UcpCatalogContext,
  inputs?: Array<{ id: string; match?: VariantMatchMode }>,
  productMedia?: Array<{ type: "image"; url: string; alt_text?: string }>,
): UcpVariant {
  const pricing = variantPrices(product, variant, context);
  const media =
    variantMedia(product, variant, context.baseUrl) ??
    productMedia ??
    primaryMedia(product, context.baseUrl);
  const available = product.isActive !== false && isVariantAvailable(variant);
  const quantity = availableQuantityForVariant(variant);
  const options = selectedOptions(variant);

  return {
    id: variantGid(variant.id),
    title: variantTitle(product, variant),
    description: productDescription(product),
    price: pricing.finalPrice,
    ...(pricing.hasDiscount ? { list_price: pricing.listPrice } : {}),
    ...(variant.sku ? { sku: variant.sku } : {}),
    ...(supportedBarcode(variant) ? { barcodes: supportedBarcode(variant) } : {}),
    handle: product.slug,
    url: variantUrl(product, variant, context),
    availability: {
      available,
      status: available ? "in_stock" : "out_of_stock",
    },
    ...(options.length > 0 ? { options } : {}),
    ...(media ? { media } : {}),
    metadata: {
      product_id: product.id,
      variant_id: variant.id,
      ...(quantity === null ? {} : { available_quantity: quantity }),
    },
    ...(context.seller ? { seller: context.seller } : {}),
    ...(inputs?.length ? { inputs } : {}),
  };
}

function priceRange(variants: UcpVariant[]) {
  const amounts = variants.map((variant) => variant.price.amount);
  const currency = variants[0]!.price.currency;
  return {
    min: { amount: Math.min(...amounts), currency },
    max: { amount: Math.max(...amounts), currency },
  };
}

function listPriceRange(variants: UcpVariant[]) {
  const listPrices = variants
    .map((variant) => variant.list_price)
    .filter((value): value is UcpPrice => Boolean(value));
  if (listPrices.length === 0) return undefined;

  const currency = listPrices[0]!.currency;
  const amounts = listPrices.map((value) => value.amount);
  return {
    min: { amount: Math.min(...amounts), currency },
    max: { amount: Math.max(...amounts), currency },
  };
}

function productTags(product: Product): string[] | undefined {
  const tags = [
    ...(product.freeDelivery ? ["free_delivery"] : []),
    ...(product.attributes ?? []).map((attribute) => `${attribute.name}:${attribute.value}`),
  ];
  return tags.length > 0 ? tags : undefined;
}

/** The published-review aggregate; the feed sends none while the store's reviews are off. */
function productRating(product: Product): UcpRating | undefined {
  const rating = product.rating;
  if (!rating || !Number.isFinite(rating.average) || !Number.isInteger(rating.count) || rating.count < 1) {
    return undefined;
  }
  return { value: rating.average, scale_min: 1, scale_max: 5, count: rating.count };
}

function mapProduct(
  product: Product,
  context: UcpCatalogContext,
  inputMatches?: Map<string, Array<{ id: string; match?: VariantMatchMode }>>,
): UcpProduct | null {
  if (product.isActive === false) return null;

  const resolution = resolveBuyerVariants(product.variants ?? []);
  if (resolution.variants.length === 0) return null;
  const media = primaryMedia(product, context.baseUrl);
  if (!media) return null;

  const pricedVariants = resolution.variants.filter((variant) =>
    hasPositiveVariantPricing(product, variant, context)
  );
  if (pricedVariants.length === 0) return null;

  const variants = pricedVariants.map((variant, index) => {
    const inputs = inputMatches?.get(variant.id);
    const featuredInputs = index === 0 ? inputMatches?.get(product.id) : undefined;
    return mapVariant(
      product,
      variant,
      context,
      [
        ...(inputs ?? []),
        ...(featuredInputs ?? []),
      ],
      media,
    );
  });
  const options = productOptions(product, pricedVariants);
  const listRange = listPriceRange(variants);
  const tags = productTags(product);
  const rating = productRating(product);

  return {
    id: productGid(product.id),
    title: product.name,
    description: productDescription(product),
    url: productUrl(product, context),
    handle: product.slug,
    price_range: priceRange(variants),
    ...(listRange ? { list_price_range: listRange } : {}),
    variants,
    ...(options ? { options } : {}),
    ...(product.category?.name
      ? { categories: [{ value: product.category.name, taxonomy: "merchant" as const }] }
      : {}),
    media,
    ...(rating ? { rating } : {}),
    ...(tags ? { tags } : {}),
    metadata: {
      product_id: product.id,
      available_for_sale: product.availableForSale !== false,
    },
  };
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** A successful body with the context's messages and the store's policies appended. */
function successBody<Payload extends Omit<UcpResponseBody, "ucp">>(
  capability: string,
  payload: Payload,
  context: UcpCatalogContext,
  messages: UcpMessage[] = [],
): Payload & UcpResponseBody {
  const allMessages = [...messages, ...context.messages];
  return {
    ucp: ucpMetadata("success", capability),
    ...payload,
    ...(allMessages.length > 0 ? { messages: allMessages } : {}),
    ...(context.policies.length > 0 ? { policies: context.policies } : {}),
  };
}

type ErrorOptions = { path?: string; severity?: UcpErrorSeverity };

function productError(status: number, code: string, content: string, options: ErrorOptions = {}): UcpOperationResult {
  return { status, body: errorBody(code, content, { ...options, capability: UCP_CATALOG_LOOKUP_CAPABILITY }) };
}

function listError(
  operation: "search" | "lookup",
  status: number,
  code: string,
  content: string,
  options: ErrorOptions = {},
): UcpOperationResult<UcpListBody> {
  const body = errorBody(code, content, { ...options, capability: OPERATION_CAPABILITY[operation] });
  return { status, body: { ...body, products: [] } };
}

function operationError(
  operation: UcpOperation,
  status: number,
  code: string,
  content: string,
  options: ErrorOptions = {},
): UcpOperationResult {
  return operation === "product"
    ? productError(status, code, content, options)
    : listError(operation, status, code, content, options);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function parsePagination(value: unknown) {
  const pagination = isJsonObject(value) ? value : {};
  const requestedLimit = typeof pagination.limit === "number"
    ? pagination.limit
    : Number(pagination.limit ?? DEFAULT_SEARCH_LIMIT);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(requestedLimit)))
    : DEFAULT_SEARCH_LIMIT;
  const cursorValue = pagination.cursor;
  if (cursorValue !== undefined && (
    typeof cursorValue !== "string" ||
    cursorValue.length > 512 ||
    !/^feed-v1\.[0-9a-z]+\.[A-Za-z0-9_-]+$/.test(cursorValue)
  )) {
    return { valid: false as const, limit };
  }

  return {
    valid: true as const,
    limit,
    ...(typeof cursorValue === "string" ? { cursor: cursorValue } : {}),
  };
}

function filtersObject(value: unknown): Record<string, unknown> {
  return isJsonObject(value) ? value : {};
}

function minorUnitsToMajor(value: unknown, context: UcpCatalogContext): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value / (10 ** context.currency.decimalPlaces);
}

function buildSearchOptions(
  body: SearchRequestBody,
  context: UcpCatalogContext,
  pagination: Extract<ReturnType<typeof parsePagination>, { valid: true }>,
) {
  const filters = filtersObject(body.filters);
  const priceFilter = filtersObject(filters.price);
  const categories = Array.isArray(filters.categories)
    ? filters.categories.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const query = typeof body.query === "string" ? body.query.trim() : "";
  // Price filters are in the answered currency's minor units (the market's, as its page shows).
  const minPrice = minorUnitsToMajor(priceFilter.min, context);
  const maxPrice = minorUnitsToMajor(priceFilter.max, context);

  return {
    limit: pagination.limit,
    ...(pagination.cursor ? { cursor: pagination.cursor } : {}),
    ...(query ? { search: query } : {}),
    ...(categories[0] ? { category: categories[0] } : {}),
    ...(minPrice !== undefined ? { minPrice } : {}),
    ...(maxPrice !== undefined ? { maxPrice } : {}),
  };
}

function hasPriceFilter(body: SearchRequestBody): boolean {
  const priceFilter = filtersObject(filtersObject(body.filters).price);
  return typeof priceFilter.min === "number" || typeof priceFilter.max === "number";
}

function hasRecognizedSearchInput(body: SearchRequestBody): boolean {
  const filters = filtersObject(body.filters);
  const hasCategoryFilter = Array.isArray(filters.categories) && filters.categories.length > 0;
  return Boolean(
    (typeof body.query === "string" && body.query.trim()) ||
    hasCategoryFilter ||
    hasPriceFilter(body),
  );
}

async function loadFeedProducts(
  options: Parameters<typeof getFeedProducts>[0],
): Promise<FeedProductPage | null> {
  try {
    // UCP lists what the AI agents sales channel publishes (MARKETS-DESIGN D6).
    return await getFeedProducts({ ...options, channel: AGENTS_CHANNEL_ID });
  } catch (error) {
    console.error("Error loading UCP feed products:", error);
    return null;
  }
}

export async function searchCatalog(
  body: SearchRequestBody,
  context: UcpCatalogContext,
): Promise<UcpOperationResult<UcpListBody>> {
  if (!hasRecognizedSearchInput(body)) {
    return listError(
      "search",
      400,
      "request_invalid",
      "Catalog search requires a query, category filter, price filter, or extension input.",
    );
  }

  const pagination = parsePagination(body.pagination);
  if (!pagination.valid) {
    return listError(
      "search",
      400,
      "request_invalid",
      "Catalog pagination cursor is invalid or no longer supported.",
      { path: "$.pagination.cursor" },
    );
  }
  const options = buildSearchOptions(body, context, pagination);
  const result = await loadFeedProducts(options);
  if (!result) {
    return listError("search", 503, "temporarily_unavailable", "Catalog search is temporarily unavailable.");
  }

  const products = result.data
    .map((product) => mapProduct(product, context))
    .filter((product): product is UcpProduct => Boolean(product));
  const requestedCurrency = isJsonObject(body.context) && typeof body.context.currency === "string"
    ? body.context.currency.trim().toUpperCase()
    : "";
  const filterMessages: UcpMessage[] = hasPriceFilter(body) && requestedCurrency && requestedCurrency !== context.currency.code
    ? [{
      type: "warning",
      code: "price_filter_currency",
      content: `The price filter was applied in ${context.currency.code} minor units, the currency these prices are in.`,
    }]
    : [];
  return {
    status: 200,
    body: successBody(UCP_CATALOG_SEARCH_CAPABILITY, {
      products,
      pagination: {
        has_next_page: result.pagination.hasNextPage,
        ...(result.pagination.cursor ? { cursor: result.pagination.cursor } : {}),
      },
    }, context, filterMessages),
  };
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

function parseProductSlugFromUrl(value: string, baseUrl: string): string | null {
  try {
    const parsed = new URL(value, `${baseUrl}/`);
    const base = new URL(baseUrl);
    if (parsed.origin !== base.origin) return null;
    // A presence page names the same product (`/en-in/products/x`).
    const pathname = stripPresencePath(parsed.pathname, presenceOfPath(parsed.pathname));
    const match = /^\/products\/([^/?#]+)\/?$/.exec(pathname);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function lookupInputs(ids: unknown, context: UcpCatalogContext): LookupInput[] {
  if (!Array.isArray(ids)) return [];

  return uniqueLookupIdentifiers(ids.filter((id): id is string => typeof id === "string"))
    .map((original) => ({
      original,
      normalized: parseProductSlugFromUrl(original, context.baseUrl) ?? normalizeLookupValue(original),
    }))
    .filter((input) => input.normalized.length > 0);
}

async function loadProductsByInputs(inputs: LookupInput[]): Promise<Product[] | null> {
  if (inputs.length === 0) return [];

  const result = await loadFeedProducts({
    limit: Math.max(inputs.length, DEFAULT_SEARCH_LIMIT),
    ids: inputs.map((input) => input.normalized).join(","),
  });
  if (!result) return null;

  return Array.from(
    new Map(result.data.map((product) => [product.id, product])).values(),
  );
}

function buildInputMatches(products: Product[], inputs: LookupInput[]) {
  const matches = new Map<string, Map<string, Array<{ id: string; match?: VariantMatchMode }>>>();

  for (const product of products) {
    const productMatches = new Map<string, Array<{ id: string; match?: VariantMatchMode }>>();
    const variants = product.variants ?? [];
    for (const input of inputs) {
      if (
        input.normalized === product.id ||
        input.normalized === product.slug ||
        input.original === productGid(product.id)
      ) {
        productMatches.set(product.id, [
          ...(productMatches.get(product.id) ?? []),
          { id: input.original, match: "featured" },
        ]);
        continue;
      }

      const variant = variants.find((candidate) => (
        input.normalized === candidate.id ||
        input.normalized === candidate.sku ||
        input.original === variantGid(candidate.id)
      ));
      if (variant) {
        productMatches.set(variant.id, [
          ...(productMatches.get(variant.id) ?? []),
          { id: input.original, match: "exact" },
        ]);
      }
    }
    matches.set(product.id, productMatches);
  }

  return matches;
}

/** The size check of a batch lookup, before any read (REST 400, MCP -32602). */
export function lookupTooLarge(body: LookupRequestBody): boolean {
  return Array.isArray(body.ids) &&
    uniqueLookupIdentifiers(body.ids.filter((id): id is string => typeof id === "string")).length > MAX_LOOKUP_IDS;
}

function lookupTooLargeResult(): UcpOperationResult<UcpListBody> {
  return listError(
    "lookup",
    400,
    "request_too_large",
    `Catalog lookup accepts at most ${MAX_LOOKUP_IDS} unique identifiers per request.`,
    { path: "$.ids" },
  );
}

export async function lookupCatalog(
  body: LookupRequestBody,
  context: UcpCatalogContext,
): Promise<UcpOperationResult<UcpListBody>> {
  if (lookupTooLarge(body)) return lookupTooLargeResult();

  const inputs = lookupInputs(body.ids, context);
  if (inputs.length === 0) {
    return listError(
      "lookup",
      400,
      "request_invalid",
      "Catalog lookup requires at least one product, variant, SKU, handle, or product URL identifier.",
      { path: "$.ids" },
    );
  }

  const products = await loadProductsByInputs(inputs);
  if (products === null) {
    return listError("lookup", 503, "temporarily_unavailable", "Catalog lookup is temporarily unavailable.");
  }

  const inputMatches = buildInputMatches(products, inputs);
  const mappedProducts = products
    .map((product) => mapProduct(product, context, inputMatches.get(product.id)))
    .filter((product): product is UcpProduct => Boolean(product))
    .map((product) => ({
      ...product,
      variants: product.variants.filter((variant) => variant.inputs?.length),
    }))
    .filter((product) => product.variants.length > 0);
  const resolvedInputIds = new Set(
    mappedProducts.flatMap((product) => (
      product.variants.flatMap((variant) => variant.inputs?.map((input) => input.id) ?? [])
    )),
  );
  // One `not_found` per identifier that resolved to no buyer-visible variant (UCP lookup).
  const notFound: UcpMessage[] = inputs
    .filter((input) => !resolvedInputIds.has(input.original))
    .map((input) => ({
      type: "info",
      code: "not_found",
      content: input.original.slice(0, MAX_ECHOED_IDENTIFIER_LENGTH),
    }));

  return {
    status: 200,
    body: successBody(UCP_CATALOG_LOOKUP_CAPABILITY, { products: mappedProducts }, context, notFound),
  };
}

// ---------------------------------------------------------------------------
// Get product
// ---------------------------------------------------------------------------

function selectedOptionFilters(body: ProductRequestBody): Array<{ name: string; label: string }> {
  return Array.isArray(body.selected)
    ? body.selected.flatMap((value) => {
        if (!isJsonObject(value)) return [];
        return typeof value.name === "string" && typeof value.label === "string"
          ? [{ name: value.name, label: value.label }]
          : [];
      })
    : [];
}

function preferenceOrder(body: ProductRequestBody): string[] {
  return Array.isArray(body.preferences)
    ? body.preferences.filter((value): value is string => typeof value === "string")
    : [];
}

function duplicateSelectedOptionName(
  selected: Array<{ name: string; label: string }>,
): string | null {
  const seen = new Set<string>();
  for (const selection of selected) {
    const normalized = selection.name.trim().toLowerCase();
    if (seen.has(normalized)) return selection.name;
    seen.add(normalized);
  }
  return null;
}

/**
 * The selections a variant exists for: when none matches all of them, drop
 * one at a time, options the buyer gave no preference for first, then from
 * the end of `preferences` (UCP get_product).
 */
function relaxedSelection(
  product: UcpProduct,
  selected: Array<{ name: string; label: string }>,
  preferences: string[],
): Array<{ name: string; label: string }> {
  const rank = (name: string) => {
    const index = preferences.findIndex((preference) => namesMatch(preference, name));
    return index === -1 ? Number.POSITIVE_INFINITY : index;
  };
  const current = [...selected];
  while (current.length > 0 && !product.variants.some((variant) => variantMatchesSelection(variant, current))) {
    let dropIndex = 0;
    current.forEach((selection, index) => {
      if (rank(selection.name) >= rank(current[dropIndex]!.name)) dropIndex = index;
    });
    current.splice(dropIndex, 1);
  }
  return current;
}

function orderSelectedVariantFirst(product: UcpProduct, selected: Array<{ name: string; label: string }>): UcpProduct {
  if (selected.length === 0) return product;

  const selectedVariantIndex = product.variants.findIndex((variant) => variantMatchesSelection(variant, selected));

  if (selectedVariantIndex <= 0) return product;
  return {
    ...product,
    variants: [
      product.variants[selectedVariantIndex]!,
      ...product.variants.slice(0, selectedVariantIndex),
      ...product.variants.slice(selectedVariantIndex + 1),
    ],
  };
}

export async function getCatalogProduct(
  body: ProductRequestBody,
  context: UcpCatalogContext,
): Promise<UcpOperationResult> {
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) {
    return productError(400, "request_invalid", "Catalog product lookup requires an id.", { path: "$.id" });
  }

  const selected = selectedOptionFilters(body);
  const duplicateSelectedName = duplicateSelectedOptionName(selected);
  if (duplicateSelectedName) {
    return productError(
      400,
      "request_invalid",
      `Catalog product selected options must include each option name once. Duplicate option: ${duplicateSelectedName.slice(0, 64)}.`,
      { path: "$.selected" },
    );
  }

  const inputs = lookupInputs([id], context);
  const products = await loadProductsByInputs(inputs);
  if (products === null) {
    return productError(503, "temporarily_unavailable", "Catalog product lookup is temporarily unavailable.");
  }

  const sourceProduct = products[0];
  const product = sourceProduct ? mapProduct(sourceProduct, context) : null;
  if (!sourceProduct || !product) {
    // An application outcome, not a transport error: HTTP 200, never retried with the same id.
    return productError(
      200,
      "not_found",
      "Product was not found or is not currently buyer-visible.",
      { severity: "unrecoverable" },
    );
  }

  const input = inputs[0];
  const requestedVariantId = findRequestedVariantId(sourceProduct, input);
  if (requestedVariantId) {
    return {
      status: 200,
      body: successBody(UCP_CATALOG_LOOKUP_CAPABILITY, {
        product: withDetailSelections(orderRequestedVariantFirst(product, requestedVariantId)),
      }, context),
    };
  }
  const effective = relaxedSelection(product, selected, preferenceOrder(body));
  return {
    status: 200,
    body: successBody(UCP_CATALOG_LOOKUP_CAPABILITY, {
      product: withDetailSelections(orderSelectedVariantFirst(product, effective), effective),
    }, context),
  };
}

function findRequestedVariantId(
  sourceProduct: Product,
  input: LookupInput | undefined,
): string | null {
  if (!input) return null;

  const requestedVariant = (sourceProduct.variants ?? []).find((variant) => (
    input.normalized === variant.id ||
    input.normalized === variant.sku ||
    input.original === variantGid(variant.id)
  ));
  return requestedVariant?.id ?? null;
}

function orderRequestedVariantFirst(product: UcpProduct, requestedVariantId: string): UcpProduct {
  const requestedGid = variantGid(requestedVariantId);
  const index = product.variants.findIndex((variant) => variant.id === requestedGid);
  if (index <= 0) return product;

  return {
    ...product,
    variants: [
      product.variants[index]!,
      ...product.variants.slice(0, index),
      ...product.variants.slice(index + 1),
    ],
  };
}

// ---------------------------------------------------------------------------
// Operations (shared by the REST and MCP bindings)
// ---------------------------------------------------------------------------

/**
 * One catalog operation, from its request body to its UCP body. The REST
 * routes and the MCP tools both call this and serialize the body the same
 * way, so the two bindings answer with the same bytes.
 */
export async function runUcpCatalogOperation(
  operation: UcpOperation,
  body: Record<string, unknown>,
): Promise<UcpOperationResult> {
  // An oversized batch is refused before any read.
  if (operation === "lookup" && lookupTooLarge(body)) return lookupTooLargeResult();
  const context = await getUcpCatalogContext(body.context);
  if (!context) {
    return operationError(operation, 503, "temporarily_unavailable", "Catalog context is temporarily unavailable.");
  }
  if (operation === "search") return searchCatalog(body, context);
  if (operation === "lookup") return lookupCatalog(body, context);
  return getCatalogProduct(body, context);
}

/** The REST response of an operation: cacheable only for a successful result. */
export function ucpOperationResponse(result: UcpOperationResult): Response {
  const succeeded = result.status === 200 && result.body.ucp.status === "success";
  return ucpJsonResponse(result.body, result.status, {
    ...(succeeded ? {} : { "Cache-Control": NO_STORE }),
    ...(result.status === 503 ? { "Retry-After": "30" } : {}),
  });
}

/** The UCP REST binding: `POST /ucp/catalog/{search,lookup,product}`. */
export async function handleUcpRestRequest(request: Request, operation: UcpOperation): Promise<Response> {
  const body = await parseJsonBody<Record<string, unknown>>(request);
  if (!body) {
    return ucpErrorResponse(400, "request_invalid", "Request body must be a JSON object.");
  }

  const negotiation = negotiateUcpRequest(ucpAgentProfileFromHeader(request.headers.get("UCP-Agent")), body);
  if (negotiation) {
    return ucpErrorResponse(negotiation.status, negotiation.code, negotiation.content, negotiation.path, negotiation.severity);
  }

  return ucpOperationResponse(await runUcpCatalogOperation(operation, body));
}
