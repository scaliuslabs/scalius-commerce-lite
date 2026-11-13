// src/lib/api/products.ts

import { getConfiguredSdkClient } from "./transport";
import type {
  Category,
  CategoryProductsResponse,
  Product,
  ProductVariant,
  PaginatedResponse,
  BuyerPriceRange,
  ProductFacet,
  ProductRecommendations,
} from "./types";
import { withEdgeCache, CACHE_TTL } from "@/lib/api/transport";
import { unwrapData, unwrapEnvelope } from "./unwrap";
import { LIST_CURSOR_ERROR_CODE } from "@scalius/shared/pagination";
import {
  getApiV1ProductsBySlug,
  getApiV1Products,
  getApiV1CategoriesBySlugProducts,
  getApiV1ProductsSearch,
  getApiV1ProductsSitemap,
  getApiV1ProductsRecommendations,
} from "@scalius/api-client/sdk";
import { buildCanonicalQueryString } from "@/lib/canonical-query";
import { normalizeSearchQuery } from "@/lib/search-query";
import { isProductRecommendations, recommendationSourceIds } from "@/lib/recommendations";
import {
  normalizeBuyerPriceRange,
  normalizeProductFacets,
  normalizeProductListPayload,
  normalizeProductPageData,
  normalizeRatingFacet,
  type ProductBySlugResult,
  type ProductPageData,
} from "./product-payloads";

export {
  normalizeBuyerPriceRange,
  normalizeProductFacets,
  normalizeRatingFacet,
} from "./product-payloads";
export type { ProductBySlugResult, ProductPageData } from "./product-payloads";

/**
 * Ranked recommendations for the given products (an order's items), or the
 * store's popular/newest products without ids. Null when the API is
 * unavailable, so pages leave the row out.
 */
export async function getProductRecommendations(
  productIds: readonly string[] = [],
  limit = 8,
): Promise<ProductRecommendations | null> {
  const sourceIds = recommendationSourceIds(productIds);
  const query = sourceIds.length > 0
    ? { productIds: sourceIds.join(","), limit }
    : { limit };
  return withEdgeCache(
    `product_recommendations_${sourceIds.join(",") || "store"}_${limit}`,
    async () => {
      try {
        const { data, error } = await getApiV1ProductsRecommendations({
          client: getConfiguredSdkClient(),
          query,
        });
        if (error) {
          console.error("Error fetching product recommendations:", error);
          return null;
        }
        const recommendations = unwrapData<ProductRecommendations>(data);
        return isProductRecommendations(recommendations) ? recommendations : null;
      } catch (error: unknown) {
        console.error("Error fetching product recommendations:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.AVAILABILITY },
  );
}

/**
 * Reads product detail data while preserving the distinction between an
 * authoritative API 404 and a temporary or malformed upstream response.
 */
export async function getProductBySlugResult(
  slug: string,
  _requiresAuth = false,
): Promise<ProductBySlugResult> {
  if (!slug) {
    console.error("getProductBySlugResult: slug is required.");
    return { state: "unavailable" };
  }

  const result = await withEdgeCache<ProductBySlugResult>(
    `product_slug_${slug}`,
    async () => {
      try {
        const { data, error, response } = await getApiV1ProductsBySlug({
          client: getConfiguredSdkClient(),
          path: { slug },
        });
        if (response?.status === 404) {
          return { state: "not_found" };
        }
        if (
          error ||
          (response && (response.status < 200 || response.status >= 300))
        ) {
          console.error(
            `Error fetching product by slug "${slug}" (status ${response?.status ?? "unknown"}).`,
          );
          return null;
        }

        const productData = normalizeProductPageData(data);
        if (!productData) {
          console.error(
            `Invalid product response for slug "${slug}".`,
          );
          return null;
        }

        return { state: "found", data: productData };
      } catch (error: unknown) {
        console.error(`Error fetching product by slug "${slug}":`, error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.AVAILABILITY },
  );

  return result ?? { state: "unavailable" };
}

/**
 * Fetches the complete data needed for a product detail page.
 * Coalesced per request; the API caches it by cache generation.
 * @param slug The URL-friendly slug of the product.
 * @param _requiresAuth - Unused (preserved for signature compat).
 * @returns A promise that resolves to the product page data or null if not found.
 */
export async function getProductBySlug(
  slug: string,
  _requiresAuth = false,
): Promise<ProductPageData | null> {
  const result = await getProductBySlugResult(slug, _requiresAuth);
  return result.state === "found" ? result.data : null;
}

/**
 * Fetches all variants for a given product ID.
 * Coalesced per request; the API caches it by cache generation.
 * @param productId The unique identifier of the product.
 * @returns A promise that resolves to an array of product variants or null on failure.
 */
export async function getProductVariants(
  productId: string,
): Promise<ProductVariant[] | null> {
  if (!productId) {
    console.error("getProductVariants: productId is required.");
    return null;
  }

  return withEdgeCache(
    `product_variants_${productId}`,
    async () => {
      try {
        // There is no dedicated SDK function for /products/{id}/variants,
        // so we use the product-by-slug endpoint data which includes variants.
        // For a direct variant fetch, call the transport directly.
        const { apiFetch } = await import("./transport");
        const response = await apiFetch(
          `/products/${productId}/variants`,
          {},
          { retries: 3, timeout: 8000, auth: false },
        );

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        const json: { success: boolean; data: { variants: ProductVariant[] } } = await response.json();
        return json.data.variants;
      } catch (error: unknown) {
        console.error(
          `Error fetching variants for product ID "${productId}":`,
          error,
        );
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.AVAILABILITY },
  );
}

/**
 * Defines the available options for filtering and sorting when fetching a list of products.
 */
export interface ProductListOptions {
  page?: number;
  cursor?: string;
  limit?: number;
  sort?:
    | "relevance"
    | "newest"
    | "price-asc"
    | "price-desc"
    | "name-asc"
    | "name-desc"
    | "discount"
    | "rating";
  /** "N★ & up": whole stars 1-4. */
  minRating?: number;
  search?: string;
  minPrice?: number;
  maxPrice?: number;
  freeDelivery?: boolean;
  hasDiscount?: boolean;
  /** Only products a buyer can buy now ("Exclude out of stock"). */
  inStock?: boolean;
  ids?: string[] | string;
  [key: string]: string | number | boolean | string[] | undefined;
}

export interface SitemapProduct {
  slug: string;
  canonicalPath?: string | null;
  updatedAt: string | null;
}

/** The feed file a page with `from` reads (`@scalius/shared/catalog-feed-files`). */
export interface FeedFilePagination {
  from: number;
  /** The next file's start; null for the newest file. */
  to: number | null;
  last: boolean;
  number: number;
  total: number;
  /** This file holds more products than a file lists and no start can split it. */
  overfull: boolean;
  /** Every such file, by number. */
  overfullFiles: number[];
  /** The maintenance is still splitting files after a plan change or on its first run. */
  checking: boolean;
}

type FeedProductListPayload = {
  products?: Product[];
  data?: Product[];
  pagination?: {
    limit: number;
    cursor?: string;
    hasNextPage: boolean;
    file?: FeedFilePagination;
  };
};

export interface FeedProductPage {
  data: Product[];
  pagination: {
    limit: number;
    cursor?: string;
    hasNextPage: boolean;
    file?: FeedFilePagination;
  };
}

type SitemapProductListPayload = {
  products?: SitemapProduct[];
  data?: SitemapProduct[];
  pagination?: unknown;
};

type OptionalFeedProductsSdk = {
  getApiV1ProductsFeed?: (args: {
    client: unknown;
    query: Record<string, unknown>;
  }) => Promise<{ data?: unknown; error?: unknown; response?: { status: number } }>;
};

export function emptyProductPagination(
  options: ProductListOptions = {},
): PaginatedResponse<Product>["pagination"] {
  return {
    page: Number(options.page ?? 1),
    limit: Number(options.limit ?? 20),
    total: 0,
    totalPages: 0,
  };
}

export function normalizeProductListOptions(
  options: ProductListOptions = {},
): ProductListOptions {
  const normalized: ProductListOptions = { ...options };
  if (typeof normalized.search === "string") {
    const search = normalizeSearchQuery(normalized.search);
    if (search) {
      normalized.search = search;
    } else {
      delete normalized.search;
    }
  }
  return normalized;
}

function isFeedFilePagination(value: unknown): value is FeedFilePagination {
  const file = value as Partial<FeedFilePagination> | null;
  return Boolean(file) && Number.isSafeInteger(file!.from) && typeof file!.last === "boolean"
    && (file!.to === null ? file!.last : Number.isSafeInteger(file!.to) && file!.to! > file!.from!)
    && Number.isSafeInteger(file!.number) && Number.isSafeInteger(file!.total)
    && typeof file!.overfull === "boolean" && typeof file!.checking === "boolean"
    && Array.isArray(file!.overfullFiles) && file!.overfullFiles.every(Number.isSafeInteger);
}

function normalizeFeedProductListPayload(payload: unknown): FeedProductPage | null {
  const candidate =
    unwrapData<FeedProductListPayload>(payload) ??
    unwrapEnvelope<FeedProductListPayload>(payload) ??
    (payload as FeedProductListPayload | null);
  if (!candidate || typeof candidate !== "object") return null;
  const products = Array.isArray(candidate.products)
    ? candidate.products
    : Array.isArray(candidate.data)
      ? candidate.data
      : null;
  const pagination = candidate.pagination;
  if (
    !products ||
    !pagination ||
    !Number.isInteger(pagination.limit) ||
    pagination.limit < 1 ||
    typeof pagination.hasNextPage !== "boolean" ||
    (pagination.cursor !== undefined && typeof pagination.cursor !== "string") ||
    (pagination.hasNextPage && !pagination.cursor) ||
    (pagination.file !== undefined && !isFeedFilePagination(pagination.file))
  ) return null;
  return { data: products, pagination };
}

function normalizeSitemapProductListPayload(
  payload: unknown,
): { data: SitemapProduct[]; pagination: unknown } | null {
  const candidate =
    unwrapData<SitemapProductListPayload>(payload) ??
    unwrapEnvelope<SitemapProductListPayload>(payload) ??
    (payload as SitemapProductListPayload | null);
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
  };
}

/**
 * A feed page, "invalid_cursor" when the API refused the continuation cursor
 * (one it did not sign: forged, stale after a secret rotation, or for another
 * channel), or null when the page could not be read.
 */
/** The `error.code` of an API error envelope, if any. */
function apiErrorCode(error: unknown): string | null {
  const code = (error as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === "string" ? code : null;
}

async function readDedicatedFeedProducts(
  options: ProductListOptions,
): Promise<FeedProductPage | "invalid_cursor" | "not_found" | null> {
  const sdk = (await import("@scalius/api-client/sdk")) as OptionalFeedProductsSdk;
  if (typeof sdk.getApiV1ProductsFeed !== "function") {
    console.error("Dedicated product feed SDK route is missing.");
    return null;
  }

  try {
    const { data, error, response } = await sdk.getApiV1ProductsFeed({
      client: getConfiguredSdkClient(),
      query: options as Record<string, unknown>,
    });
    if (error) {
      if (response?.status === 400 && apiErrorCode(error) === LIST_CURSOR_ERROR_CODE) return "invalid_cursor";
      // A `from` that is no feed file's start (a URL the dashboard never listed).
      if (response?.status === 404) return "not_found";
      console.error("Error fetching feed products:", error);
      return null;
    }
    return normalizeFeedProductListPayload(data);
  } catch (error: unknown) {
    console.error("Error fetching feed products:", error);
    return null;
  }
}

/**
 * Fetches a paginated list of products belonging to a specific category.
 * Uses the bounded availability TTL because cards expose price and stock state.
 * @param categorySlug The slug of the category.
 * @param options Filtering and pagination options.
 * @returns A promise resolving to a paginated list of products or null on failure.
 */
export async function getProductsByCategory(
  categorySlug: string,
  options: ProductListOptions = {},
): Promise<CategoryProductsResponse | null> {
  if (!categorySlug) {
    console.error("getProductsByCategory: categorySlug is required.");
    return null;
  }

  const normalizedOptions = normalizeProductListOptions(options);
  const queryString = buildCanonicalQueryString(normalizedOptions, {
    defaultParams: { page: 1, limit: 20, sort: "newest" },
  });
  // v2 drops category payloads cached before buyer priceRange became authoritative.
  const cacheKey = `category_products_v2_${categorySlug}_${queryString || "default"}`;

  return withEdgeCache(
    cacheKey,
    async () => {
      try {
        const { data, error, response } = await getApiV1CategoriesBySlugProducts({
          client: getConfiguredSdkClient(),
          path: { slug: categorySlug },
          query: normalizedOptions as Record<string, unknown>,
        });

        if (error) {
          if (response?.status === 404) {
            return {
              category: null,
              categoryNotFound: true,
              data: [],
              pagination: emptyProductPagination(options),
            };
          }
          console.error(
            `Error fetching products for category "${categorySlug}":`,
            error,
          );
          return null;
        }

        const d = unwrapData<{
          category: Category;
          products: Product[];
          shelfProducts?: Product[];
          pagination: PaginatedResponse<Product>["pagination"];
          priceRange?: BuyerPriceRange;
          facets?: ProductFacet[];
          ratingFacet?: unknown;
        }>(data);
        return d
          ? {
              category: d.category,
              data: d.products,
              shelfProducts: Array.isArray(d.shelfProducts) ? d.shelfProducts : [],
              pagination: d.pagination,
              priceRange: normalizeBuyerPriceRange(d.priceRange),
              facets: normalizeProductFacets(d.facets),
              ratingFacet: normalizeRatingFacet(d.ratingFacet),
            }
          : null;
      } catch (error: unknown) {
        console.error(
          `Error fetching products for category "${categorySlug}":`,
          error,
        );
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.AVAILABILITY },
  );
}

/**
 * Fetches a list of all products, with extensive filtering and sorting capabilities.
 * Uses the bounded availability TTL because cards expose price and stock state.
 * @param options Filtering, sorting, and pagination options.
 * @returns A promise resolving to a paginated list of products or null on failure.
 */
export async function getAllProducts(
  options: ProductListOptions = {},
): Promise<PaginatedResponse<Product> | null> {
  const normalizedOptions = normalizeProductListOptions(options);
  const queryString = buildCanonicalQueryString(normalizedOptions, {
    defaultParams: { page: 1, limit: 20, sort: "newest" },
  });
  const cacheKey = `all_products_${queryString || "default"}`;

  return withEdgeCache(
    cacheKey,
    async () => {
      try {
        const { data, error } = await getApiV1Products({
          client: getConfiguredSdkClient(),
          query: normalizedOptions as Record<string, unknown>,
        });
        if (error) {
          console.error("Error fetching all products:", error);
          return null;
        }
        return normalizeProductListPayload(data);
      } catch (error: unknown) {
        console.error("Error fetching all products:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.AVAILABILITY },
  );
}

/**
 * Fetches the product projection used by public catalog feeds.
 *
 * Feed XML must use the dedicated API projection so normal storefront listings
 * stay card-light and feed-only fields do not leak into hot listing reads.
 */
export async function getFeedProducts(
  options: ProductListOptions = {},
): Promise<FeedProductPage | "invalid_cursor" | "not_found" | null> {
  const normalizedOptions = normalizeProductListOptions(options);
  const queryString = buildCanonicalQueryString(normalizedOptions, {
    defaultParams: { limit: 100 },
  });
  const cacheKey = `feed_products_${queryString || "default"}`;

  return withEdgeCache(
    cacheKey,
    () => readDedicatedFeedProducts(normalizedOptions),
    { ttlSeconds: CACHE_TTL.AVAILABILITY },
  );
}

/**
 * One page of the product sitemap. A page after the first needs the `after`
 * the sitemap index listed for it; the API refuses any other ("not_found":
 * the page was never advertised).
 */
export async function getSitemapProducts(
  options: { page?: number; limit?: number; after?: string } = {},
): Promise<{ data: SitemapProduct[] } | "not_found" | null> {
  const page = options.page ?? 1;
  const limit = options.limit ?? 100;
  const after = options.after;
  const cacheKey = `sitemap_products_page=${page}&limit=${limit}${after ? `&after=${after}` : ""}`;

  return withEdgeCache(
    cacheKey,
    async () => {
      try {
        const { data, error, response } = await getApiV1ProductsSitemap({
          client: getConfiguredSdkClient(),
          query: { page, limit, ...(after ? { after } : {}) },
        });
        if (error) {
          if (response?.status === 400 && apiErrorCode(error) === LIST_CURSOR_ERROR_CODE) return "not_found" as const;
          console.error("Error fetching sitemap products:", error);
          return null;
        }
        const payload = normalizeSitemapProductListPayload(data);
        return payload ? { data: payload.data } : null;
      } catch (error: unknown) {
        console.error("Error fetching sitemap products:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.AVAILABILITY },
  );
}

/** The sitemap index's product read: how many pages, and the `after` of each page after the first. */
export interface SitemapProductOutline {
  total: number;
  totalPages: number;
  pages: Array<{ page: number; after: string }>;
}

export async function getSitemapProductsOutline(limit: number): Promise<SitemapProductOutline | null> {
  return withEdgeCache(
    `sitemap_products_outline_limit=${limit}`,
    async () => {
      try {
        const { data, error } = await getApiV1ProductsSitemap({
          client: getConfiguredSdkClient(),
          query: { limit, outline: "true" },
        });
        if (error) {
          console.error("Error fetching the sitemap product outline:", error);
          return null;
        }
        const pagination = (unwrapData<SitemapProductListPayload>(data) ?? unwrapEnvelope<SitemapProductListPayload>(data))?.pagination as
          | { total?: unknown; totalPages?: unknown; pages?: unknown }
          | undefined;
        if (!pagination || typeof pagination.total !== "number" || typeof pagination.totalPages !== "number" || !Array.isArray(pagination.pages)) {
          return null;
        }
        const pages = pagination.pages.filter((entry): entry is { page: number; after: string } =>
          Boolean(entry) && typeof (entry as { page?: unknown }).page === "number" && typeof (entry as { after?: unknown }).after === "string");
        return { total: pagination.total, totalPages: pagination.totalPages, pages };
      } catch (error: unknown) {
        console.error("Error fetching the sitemap product outline:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.AVAILABILITY },
  );
}

/**
 * Searches for products based on a query, with pagination.
 * Intended for use in order forms or quick product lookups.
 *
 * @param search The search term.
 * @param page The page number for pagination.
 * @param limit The number of results per page.
 * @returns A promise resolving to a paginated list of products.
 */
export async function searchProductsForForm(
  search: string,
  page: number = 1,
  limit: number = 10,
): Promise<PaginatedResponse<
  Product & { variants?: ProductVariant[] }
> | null> {
  const normalizedSearch = normalizeSearchQuery(search);
  if (!normalizedSearch) {
    return {
      data: [],
      pagination: { page, limit, total: 0, totalPages: 0 },
    };
  }

  try {
    const { data } = await getApiV1ProductsSearch({
      client: getConfiguredSdkClient(),
      query: { search: normalizedSearch, page, limit },
    });

    const d = unwrapEnvelope<PaginatedResponse<Product & { variants?: ProductVariant[] }>>(data);
    if (d) {
      return {
        data: d.data ?? [],
        pagination: d.pagination,
      };
    }
    return null;
  } catch (error: unknown) {
    console.error(
      `Error searching for products with query "${normalizedSearch}":`,
      error,
    );
    return null;
  }
}
