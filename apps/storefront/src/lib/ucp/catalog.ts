import { getVariantDiscountedPrice } from "@/components/product/lib/pricing-engine";
import { roundPriceToPrecision } from "@scalius/shared/price-utils";
import { getFeedProducts, type FeedProductPage } from "@/lib/api/products";
import { getLayoutData, type CurrencyData } from "@/lib/api/storefront";
import type { Product, ProductVariant } from "@/lib/api/types";
import { setRuntimeImageCdnPolicy } from "@/lib/api/runtime-env";
import { getOptimizedImageUrl } from "@/lib/image-optimizer";
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

export const UCP_VERSION = "2026-04-08";
export const UCP_SHOPPING_SERVICE = "dev.ucp.shopping";
export const UCP_CATALOG_SEARCH_CAPABILITY =
  "dev.ucp.shopping.catalog.search";
export const UCP_CATALOG_LOOKUP_CAPABILITY =
  "dev.ucp.shopping.catalog.lookup";

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const MAX_LOOKUP_IDS = 25;
const GID_PREFIX = "gid://scalius/";
const CATALOG_IMAGE_OPTIONS = {
  width: 1200,
  quality: 90,
  format: "auto",
  fit: "scale-down",
} as const;

type UcpStatus = "success" | "error";
type UcpMessageType = "info" | "warning" | "error";
type VariantMatchMode = "featured" | "exact";
type UcpErrorSeverity =
  | "recoverable"
  | "requires_buyer_input"
  | "requires_buyer_review"
  | "unrecoverable";

interface UcpMessage {
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
  tags?: string[];
  metadata?: Record<string, unknown>;
}

interface UcpCatalogContext {
  baseUrl: string;
  currency: Required<Pick<CurrencyData, "code" | "decimalPlaces">>;
}

interface LookupInput {
  original: string;
  normalized: string;
}

interface SearchRequestBody {
  ucp?: { version?: unknown };
  query?: unknown;
  filters?: unknown;
  pagination?: unknown;
}

interface LookupRequestBody {
  ucp?: { version?: unknown };
  ids?: unknown;
}

interface ProductRequestBody {
  ucp?: { version?: unknown };
  id?: unknown;
  selected?: unknown;
}

function ucpMetadata(status: UcpStatus, capabilities?: string[]) {
  return {
    version: UCP_VERSION,
    status,
    ...(capabilities?.length
      ? {
          capabilities: Object.fromEntries(
            capabilities.map((capability) => [
              capability,
              [buildCapability(capability)],
            ]),
          ),
        }
      : {}),
  };
}

function buildCapability(name: string) {
  const capability =
    name === UCP_CATALOG_SEARCH_CAPABILITY
      ? {
          spec: "catalog/search",
          schema: "catalog_search",
        }
      : {
          spec: "catalog/lookup",
          schema: "catalog_lookup",
        };

  return {
    version: UCP_VERSION,
    spec: `https://ucp.dev/${UCP_VERSION}/specification/${capability.spec}`,
    schema: `https://ucp.dev/${UCP_VERSION}/schemas/shopping/${capability.schema}.json`,
  };
}

export function buildUcpProfile(baseUrl: string) {
  const endpoint = `${baseUrl}/ucp`;
  return {
    ucp: {
      version: UCP_VERSION,
      services: {
        [UCP_SHOPPING_SERVICE]: [
          {
            version: UCP_VERSION,
            transport: "rest",
            endpoint,
            spec: `https://ucp.dev/${UCP_VERSION}/specification/overview`,
            schema: `https://ucp.dev/${UCP_VERSION}/services/shopping/rest.openapi.json`,
          },
        ],
      },
      capabilities: {
        [UCP_CATALOG_SEARCH_CAPABILITY]: [
          buildCapability(UCP_CATALOG_SEARCH_CAPABILITY),
        ],
        [UCP_CATALOG_LOOKUP_CAPABILITY]: [
          buildCapability(UCP_CATALOG_LOOKUP_CAPABILITY),
        ],
      },
      supported_versions: {
        [UCP_VERSION]: `${baseUrl}/.well-known/ucp`,
      },
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
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type,UCP-Agent,Request-Id,Idempotency-Key,Content-Digest,Signature,Signature-Input",
      ...extraHeaders,
    },
  });
}

export function ucpOptionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type,UCP-Agent,Request-Id,Idempotency-Key,Content-Digest,Signature,Signature-Input",
      "Access-Control-Max-Age": "86400",
    },
  });
}

export function ucpErrorResponse(
  status: number,
  code: string,
  content: string,
  path?: string,
  severity: UcpErrorSeverity = "recoverable",
): Response {
  return ucpJsonResponse(
    {
      ucp: ucpMetadata("error"),
      messages: [
        {
          type: "error",
          code,
          content,
          severity,
          ...(path ? { path } : {}),
        },
      ],
    },
    status,
    { "Cache-Control": "private, no-cache, no-store, must-revalidate" },
  );
}

export function ucpUnavailableResponse(message: string): Response {
  return ucpJsonResponse(
    {
      ucp: ucpMetadata("error"),
      messages: [
        {
          type: "error",
          code: "temporarily_unavailable",
          content: message,
          severity: "recoverable",
        },
      ],
    },
    503,
    {
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
      "Retry-After": "30",
    },
  );
}

export function ucpProfileUnavailableResponse(): Response {
  return xmlDataUnavailableResponse("UCP profile is temporarily unavailable");
}

export async function getUcpCatalogContext(): Promise<UcpCatalogContext | null> {
  let baseUrl: string;
  try {
    baseUrl = getUcpBaseUrl();
  } catch {
    return null;
  }

  const layout = await getLayoutData();
  if (!layout) {
    return null;
  }
  setRuntimeImageCdnPolicy(layout.media);

  const code = (layout.currency?.code ?? DEFAULT_CURRENCY.code).toUpperCase();
  const decimalPlaces = Number.isInteger(layout.currency?.decimalPlaces)
    ? layout.currency!.decimalPlaces!
    : DEFAULT_CURRENCY.decimalPlaces;

  return { baseUrl, currency: { code, decimalPlaces } };
}

export function validateUcpRequest(
  request: Request,
  body: { ucp?: { version?: unknown } },
): UcpMessage[] {
  const messages: UcpMessage[] = [];
  const requestedVersion = body.ucp?.version;
  if (typeof requestedVersion === "string" && requestedVersion !== UCP_VERSION) {
    messages.push({
      type: "error",
      code: "version_unsupported",
      path: "$.ucp.version",
      content: `Unsupported UCP version. This storefront currently serves ${UCP_VERSION}.`,
    });
  }

  const ucpAgent = request.headers.get("UCP-Agent")?.trim();
  if (!ucpAgent) {
    messages.push({
      type: "error",
      code: "invalid_profile_url",
      content: "UCP-Agent header is required and must use profile=\"https://...\" structured field syntax.",
    });
  } else {
    const profile = /^profile="([^"]+)"$/i.exec(ucpAgent)?.[1];
    try {
      const parsed = profile ? new URL(profile) : null;
      if (!parsed || parsed.protocol !== "https:") {
        messages.push({
          type: "error",
          code: "invalid_profile_url",
          content: "UCP-Agent must use profile=\"https://...\" structured field syntax.",
        });
      }
    } catch {
      messages.push({
        type: "error",
        code: "invalid_profile_url",
        content: "UCP-Agent profile URL is malformed.",
      });
    }
  }

  return messages;
}

export async function parseJsonBody<T>(request: Request): Promise<T | null> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as T)
      : null;
  } catch {
    return null;
  }
}

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

function selectedOptions(_product: Product, variant: ProductVariant) {
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

function withDetailSelections(product: UcpProduct): UcpProduct {
  if (!product.options || product.options.length === 0) return product;

  const selected = product.variants[0]?.options ?? [];
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

function productUrl(product: Product, baseUrl: string): string {
  const path =
    normalizeResourceCanonicalPath("product", product.canonicalPath) ??
    `/products/${product.slug}`;
  return new URL(path, `${baseUrl}/`).toString();
}

function variantUrl(product: Product, variant: ProductVariant, baseUrl: string): string {
  const url = new URL(productUrl(product, baseUrl));
  url.searchParams.set("variant", variant.id);
  return url.toString();
}

function catalogMedia(
  imageUrl: string | null | undefined,
  baseUrl: string,
  altText?: string | null,
) {
  const url = resolveCatalogDiscoveryImageUrl(imageUrl, baseUrl, {
    transformImageUrl: (imageUrl) =>
      getOptimizedImageUrl(imageUrl, CATALOG_IMAGE_OPTIONS),
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
  );

  return {
    listPrice: price(basePrice, context),
    finalPrice: price(finalPrice, context),
    hasDiscount: finalPrice < basePrice,
  };
}

function variantTitle(product: Product, variant: ProductVariant): string {
  const options = selectedOptions(product, variant);
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

  return {
    id: variantGid(variant.id),
    title: variantTitle(product, variant),
    description: productDescription(product),
    price: pricing.finalPrice,
    ...(pricing.hasDiscount ? { list_price: pricing.listPrice } : {}),
    ...(variant.sku ? { sku: variant.sku } : {}),
    ...(supportedBarcode(variant) ? { barcodes: supportedBarcode(variant) } : {}),
    handle: product.slug,
    url: variantUrl(product, variant, context.baseUrl),
    availability: {
      available,
      status: available ? "in_stock" : "out_of_stock",
    },
    ...(selectedOptions(product, variant).length > 0
      ? { options: selectedOptions(product, variant) }
      : {}),
    ...(media ? { media } : {}),
    metadata: {
      product_id: product.id,
      variant_id: variant.id,
      ...(quantity === null ? {} : { available_quantity: quantity }),
    },
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

function mapProduct(
  product: Product,
  context: UcpCatalogContext,
  inputMatches?: Map<string, Array<{ id: string; match?: VariantMatchMode }>>,
): UcpProduct | null {
  if (product.isActive === false) return null;
  if ((product as { excludeFromProductFeed?: unknown }).excludeFromProductFeed === true) {
    return null;
  }

  const resolution = resolveBuyerVariants(product.variants ?? []);
  if (resolution.variants.length === 0) return null;
  const media = primaryMedia(product, context.baseUrl);
  if (!media) return null;

  const variants = resolution.variants.map((variant, index) => {
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

  return {
    id: productGid(product.id),
    title: product.name,
    description: productDescription(product),
    url: productUrl(product, context.baseUrl),
    handle: product.slug,
    price_range: priceRange(variants),
    ...(listPriceRange(variants) ? { list_price_range: listPriceRange(variants) } : {}),
    variants,
    ...(productOptions(product, resolution.variants) ? { options: productOptions(product, resolution.variants) } : {}),
    ...(product.category?.name
      ? { categories: [{ value: product.category.name, taxonomy: "merchant" as const }] }
      : {}),
    ...(media ? { media } : {}),
    ...(productTags(product) ? { tags: productTags(product) } : {}),
    metadata: {
      product_id: product.id,
      available_for_sale: product.availableForSale !== false,
    },
  };
}

function parsePagination(value: unknown) {
  const pagination = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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

function hasRecognizedSearchInput(body: SearchRequestBody): boolean {
  const filters = filtersObject(body.filters);
  const priceFilter = filtersObject(filters.price);
  const hasPriceFilter = typeof priceFilter.min === "number" || typeof priceFilter.max === "number";
  const hasCategoryFilter = Array.isArray(filters.categories) && filters.categories.length > 0;
  return Boolean(
    (typeof body.query === "string" && body.query.trim()) ||
    hasCategoryFilter ||
    hasPriceFilter,
  );
}

async function loadFeedProducts(
  options: Parameters<typeof getFeedProducts>[0],
): Promise<FeedProductPage | null> {
  try {
    return await getFeedProducts(options);
  } catch (error) {
    console.error("Error loading UCP feed products:", error);
    return null;
  }
}

export async function searchCatalog(
  body: SearchRequestBody,
  context: UcpCatalogContext,
) {
  if (!hasRecognizedSearchInput(body)) {
    return {
      status: 400,
      body: {
        ucp: ucpMetadata("error", [UCP_CATALOG_SEARCH_CAPABILITY]),
        products: [],
        messages: [
          {
            type: "error",
            code: "request_invalid",
            content: "Catalog search requires a query, category filter, price filter, or extension input.",
            severity: "recoverable",
          },
        ],
      },
    };
  }

  const pagination = parsePagination(body.pagination);
  if (!pagination.valid) {
    return {
      status: 400,
      body: {
        ucp: ucpMetadata("error", [UCP_CATALOG_SEARCH_CAPABILITY]),
        products: [],
        messages: [{
          type: "error",
          code: "request_invalid",
          content: "Catalog pagination cursor is invalid or no longer supported.",
          severity: "recoverable",
          path: "$.pagination.cursor",
        }],
      },
    };
  }
  const options = buildSearchOptions(body, context, pagination);
  const result = await loadFeedProducts(options);
  if (!result) {
    return {
      status: 503,
      body: {
        ucp: ucpMetadata("error", [UCP_CATALOG_SEARCH_CAPABILITY]),
        products: [],
        messages: [
          {
            type: "error",
            code: "temporarily_unavailable",
            content: "Catalog search is temporarily unavailable.",
            severity: "recoverable",
          },
        ],
      },
    };
  }

  const products = result.data
    .map((product) => mapProduct(product, context))
    .filter((product): product is UcpProduct => Boolean(product));
  return {
    status: 200,
    body: {
      ucp: ucpMetadata("success", [UCP_CATALOG_SEARCH_CAPABILITY]),
      products,
      pagination: {
        has_next_page: result.pagination.hasNextPage,
        ...(result.pagination.cursor ? { cursor: result.pagination.cursor } : {}),
      },
    },
  };
}

function parseProductSlugFromUrl(value: string, baseUrl: string): string | null {
  try {
    const parsed = new URL(value, `${baseUrl}/`);
    const base = new URL(baseUrl);
    if (parsed.origin !== base.origin) return null;
    const match = /^\/products\/([^/?#]+)\/?$/.exec(parsed.pathname);
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

export async function lookupCatalog(
  body: LookupRequestBody,
  context: UcpCatalogContext,
) {
  const inputs = lookupInputs(body.ids, context);
  if (inputs.length > MAX_LOOKUP_IDS) {
    return {
      status: 400,
      body: {
        ucp: ucpMetadata("error", [UCP_CATALOG_LOOKUP_CAPABILITY]),
        products: [],
        messages: [
          {
            type: "error",
            code: "request_too_large",
            path: "$.ids",
            content: `Catalog lookup accepts at most ${MAX_LOOKUP_IDS} unique identifiers per request.`,
            severity: "recoverable",
          },
        ],
      },
    };
  }

  if (inputs.length === 0) {
    return {
      status: 400,
      body: {
        ucp: ucpMetadata("error", [UCP_CATALOG_LOOKUP_CAPABILITY]),
        products: [],
        messages: [
          {
            type: "error",
            code: "request_invalid",
            path: "$.ids",
            content: "Catalog lookup requires at least one product, variant, SKU, handle, or product URL identifier.",
            severity: "recoverable",
          },
        ],
      },
    };
  }

  const products = await loadProductsByInputs(inputs);
  if (products === null) {
    return {
      status: 503,
      body: {
        ucp: ucpMetadata("error", [UCP_CATALOG_LOOKUP_CAPABILITY]),
        products: [],
        messages: [
          {
            type: "error",
            code: "temporarily_unavailable",
            content: "Catalog lookup is temporarily unavailable.",
            severity: "recoverable",
          },
        ],
      },
    };
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

  return {
    status: 200,
    body: {
      ucp: ucpMetadata("success", [UCP_CATALOG_LOOKUP_CAPABILITY]),
      products: mappedProducts,
      ...(resolvedInputIds.size < inputs.length
        ? {
            messages: [
              {
                type: "info",
                code: "partial_lookup",
                content: "Some requested identifiers did not resolve to buyer-visible products.",
              },
            ],
          }
        : {}),
    },
  };
}

function selectedOptionFilters(body: ProductRequestBody): Array<{ name: string; label: string }> {
  return Array.isArray(body.selected)
    ? body.selected.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const option = value as Record<string, unknown>;
        return typeof option.name === "string" && typeof option.label === "string"
          ? [{ name: option.name, label: option.label }]
          : [];
      })
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

function orderSelectedVariantFirst(product: UcpProduct, selected: Array<{ name: string; label: string }>): UcpProduct {
  if (selected.length === 0) return product;

  const selectedVariantIndex = product.variants.findIndex((variant) => (
    selected.every((selection) => (
      variant.options?.some((option) => (
        namesMatch(option.name, selection.name) &&
        labelsMatch(option.label, selection.label)
      ))
    ))
  ));

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
) {
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) {
    return {
      status: 400,
      body: {
        ucp: ucpMetadata("error", [UCP_CATALOG_LOOKUP_CAPABILITY]),
        messages: [
          {
            type: "error",
            code: "request_invalid",
            path: "$.id",
            content: "Catalog product lookup requires an id.",
            severity: "recoverable",
          },
        ],
      },
    };
  }

  const inputs = lookupInputs([id], context);
  const products = await loadProductsByInputs(inputs);
  if (products === null) {
    return {
      status: 503,
      body: {
        ucp: ucpMetadata("error", [UCP_CATALOG_LOOKUP_CAPABILITY]),
        messages: [
          {
            type: "error",
            code: "temporarily_unavailable",
            content: "Catalog product lookup is temporarily unavailable.",
            severity: "recoverable",
          },
        ],
      },
    };
  }

  const sourceProduct = products[0];
  const product = sourceProduct ? mapProduct(sourceProduct, context) : null;
  if (!product) {
    return {
      status: 200,
      body: {
        ucp: ucpMetadata("error", [UCP_CATALOG_LOOKUP_CAPABILITY]),
        messages: [
          {
            type: "error",
            code: "not_found",
            content: "Product was not found or is not currently buyer-visible.",
            severity: "unrecoverable",
          },
        ],
      },
    };
  }

  const input = inputs[0];
  const requestedVariantId = findRequestedVariantId(sourceProduct, input);
  const requestedFirstProduct = orderRequestedVariantFirst(product, sourceProduct, input);
  const selected = selectedOptionFilters(body);
  const duplicateSelectedName = duplicateSelectedOptionName(selected);
  if (duplicateSelectedName) {
    return {
      status: 400,
      body: {
        ucp: ucpMetadata("error", [UCP_CATALOG_LOOKUP_CAPABILITY]),
        messages: [
          {
            type: "error",
            code: "request_invalid",
            path: "$.selected",
            content: `Catalog product selected options must include each option name once. Duplicate option: ${duplicateSelectedName}.`,
            severity: "recoverable",
          },
        ],
      },
    };
  }
  const orderedProduct = requestedVariantId
    ? requestedFirstProduct
    : orderSelectedVariantFirst(requestedFirstProduct, selected);

  return {
    status: 200,
    body: {
      ucp: ucpMetadata("success", [UCP_CATALOG_LOOKUP_CAPABILITY]),
      product: withDetailSelections(orderedProduct),
    },
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

function orderRequestedVariantFirst(
  product: UcpProduct,
  sourceProduct: Product,
  input: LookupInput | undefined,
): UcpProduct {
  const requestedVariantId = findRequestedVariantId(sourceProduct, input);
  if (!requestedVariantId) return product;

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
