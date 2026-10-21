/**
 * The public product payloads as the storefront reads them: detail and list
 * envelopes with malformed parts dropped. Pure functions with no transport,
 * so the server reads (products.ts, through the SDK) and the browser reads
 * (browser-products.ts, plain fetch) normalize the same way.
 */
import type {
  BuyerPriceRange,
  PaginatedResponse,
  Product,
  ProductFacet,
  ProductFacetDisplay,
  ProductFacetKind,
  ProductFacetValue,
  ProductMedia,
  ProductRecommendations,
  ProductVariant,
  RatingFacetValue,
} from "./types";
import { unwrapData, unwrapEnvelope } from "./unwrap";
import { isProductRecommendations } from "@/lib/recommendations";

/**
 * A comprehensive data structure for a single product page,
 * including the main product, its category, ordered media, variants, and ranked recommendations.
 */
export interface ProductPageData {
  product: Product;
  category: Product["category"];
  media: ProductMedia[];
  variants: ProductVariant[];
  recommendations: ProductRecommendations;
}

export type ProductBySlugResult =
  | { state: "found"; data: ProductPageData }
  | { state: "not_found" }
  | { state: "unavailable" };

export function normalizeProductPageData(payload: unknown): ProductPageData | null {
  const candidate = unwrapData<ProductPageData>(payload);
  if (
    !candidate ||
    typeof candidate !== "object" ||
    !candidate.product ||
    typeof candidate.product !== "object" ||
    !Array.isArray(candidate.media) ||
    !Array.isArray(candidate.variants) ||
    !isProductRecommendations(candidate.recommendations)
  ) {
    return null;
  }

  return candidate;
}

type ProductListPayload = {
  products?: Product[];
  data?: Product[];
  pagination?: PaginatedResponse<Product>["pagination"];
  priceRange?: BuyerPriceRange;
  facets?: ProductFacet[];
  ratingFacet?: unknown;
  correctedQuery?: string | null;
};

export function normalizeBuyerPriceRange(value: unknown): BuyerPriceRange | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { min, max } = value as { min?: unknown; max?: unknown };
  if (
    typeof min !== "number" ||
    typeof max !== "number" ||
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    min < 0 ||
    max < min
  ) {
    return undefined;
  }
  return { min, max };
}

const FACET_KINDS = new Set<ProductFacetKind>(["attribute", "option", "brand", "category"]);
const FACET_DISPLAYS = new Set<ProductFacetDisplay>(["checkbox", "range", "swatch", "search_list"]);
/** A swatch paints a `style` attribute, so only a plain hex colour is kept. */
const FACET_SWATCH = /^#[0-9a-f]{6}$/i;
const finiteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * The listing's "N★ & up" rows, highest first: whole stars 1-4 with a
 * non-negative count. Anything malformed is dropped (no rating group).
 */
export function normalizeRatingFacet(value: unknown): RatingFacetValue[] {
  if (!Array.isArray(value)) return [];
  const rows = new Map<number, number>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const { min, count } = candidate as Record<string, unknown>;
    if (typeof min !== "number" || !Number.isInteger(min) || min < 1 || min > 4) continue;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) continue;
    rows.set(min, count);
  }
  return [...rows].map(([min, count]) => ({ min, count })).sort((left, right) => right.min - left.min);
}

/** The listing facets as the catalog components read them; malformed facets and values are dropped. */
export function normalizeProductFacets(value: unknown): ProductFacet[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): ProductFacet[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const facet = candidate as Record<string, unknown>;
    if (
      typeof facet.id !== "string" ||
      typeof facet.name !== "string" ||
      typeof facet.slug !== "string" ||
      !Array.isArray(facet.values)
    ) return [];
    const kind = FACET_KINDS.has(facet.kind as ProductFacetKind)
      ? facet.kind as ProductFacetKind
      : facet.slug === "brand" ? "brand" : facet.slug.startsWith("option.") ? "option" : "attribute";
    const display = FACET_DISPLAYS.has(facet.display as ProductFacetDisplay)
      ? facet.display as ProductFacetDisplay
      : "checkbox";
    const bounds = facet.range as { min?: unknown; max?: unknown } | null | undefined;
    const range = display === "range" && bounds && finiteNumber(bounds.min) && finiteNumber(bounds.max) && bounds.max >= bounds.min
      ? { min: bounds.min, max: bounds.max }
      : null;
    const values = display === "range" ? [] : facet.values.flatMap((option): ProductFacetValue[] => {
      if (!option || typeof option !== "object") return [];
      const { value, label, count, swatch } = option as Record<string, unknown>;
      if (typeof value !== "string" || !value || typeof count !== "number" || !Number.isInteger(count) || count < 0) return [];
      return [{
        value,
        label: typeof label === "string" && label.trim() ? label : value,
        count,
        swatch: typeof swatch === "string" && FACET_SWATCH.test(swatch) ? swatch : null,
      }];
    });
    return [{
      id: facet.id,
      name: facet.name,
      slug: facet.slug,
      kind,
      display,
      unit: typeof facet.unit === "string" && facet.unit.trim() ? facet.unit.trim() : null,
      values,
      range,
    }];
  });
}

export function normalizeProductListPayload(
  payload: unknown,
): PaginatedResponse<Product> | null {
  const candidate =
    unwrapData<ProductListPayload>(payload) ??
    unwrapEnvelope<ProductListPayload>(payload) ??
    (payload as ProductListPayload | null);
  if (!candidate || typeof candidate !== "object") return null;

  const products = Array.isArray(candidate.products)
    ? candidate.products
    : Array.isArray(candidate.data)
      ? candidate.data
      : null;
  if (!products || !candidate.pagination) return null;

  return {
    data: products,
    pagination: candidate.pagination,
    priceRange: normalizeBuyerPriceRange(candidate.priceRange),
    facets: normalizeProductFacets(candidate.facets),
    ratingFacet: normalizeRatingFacet(candidate.ratingFacet),
    correctedQuery: typeof candidate.correctedQuery === "string" ? candidate.correctedQuery : null,
  };
}
