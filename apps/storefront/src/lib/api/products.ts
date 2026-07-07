// src/lib/api/products.ts

import { getConfiguredSdkClient } from "./client";
import type {
  Category,
  CategoryProductsResponse,
  Product,
  ProductVariant,
  ProductImage,
  PaginatedResponse,
} from "./types";
import { withEdgeCache, CACHE_TTL } from "@/lib/edge-cache";
import { unwrapData, unwrapEnvelope } from "./unwrap";
import {
  getApiV1ProductsBySlug,
  getApiV1Products,
  getApiV1CategoriesBySlugProducts,
  getApiV1ProductsSearch,
  getApiV1ProductsSitemap,
} from "@scalius/api-client/sdk";
import { buildCanonicalQueryString } from "@/lib/cache-key";
import { normalizeSearchQuery } from "@/lib/search-query";

/**
 * A comprehensive data structure for a single product page,
 * including the main product, its category, images, variants, and related items.
 */
export interface ProductPageData {
  product: Product;
  category: Product["category"];
  images: ProductImage[];
  variants: ProductVariant[];
  relatedProducts: Product[];
}

/**
 * Fetches the complete data needed for a product detail page.
 * Wrapped with EdgeCache (TTL) - invalidated via purge-cache.
 * @param slug The URL-friendly slug of the product.
 * @param _requiresAuth - Unused (preserved for signature compat).
 * @returns A promise that resolves to the product page data or null if not found.
 */
export async function getProductBySlug(
  slug: string,
  _requiresAuth = false,
): Promise<ProductPageData | null> {
  if (!slug) {
    console.error("getProductBySlug: slug is required.");
    return null;
  }

  return withEdgeCache(
    `product_slug_${slug}`,
    async () => {
      try {
        const { data, error } = await getApiV1ProductsBySlug({
          client: getConfiguredSdkClient(),
          path: { slug },
        });
        if (error) return null;
        return unwrapData<ProductPageData>(data);
      } catch (error: unknown) {
        console.error(`Error fetching product by slug "${slug}":`, error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}

/**
 * Fetches all variants for a given product ID.
 * Wrapped with EdgeCache (TTL) - invalidated via purge-cache.
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
        // For a direct variant fetch, fall back to fetchWithRetry.
        const { createApiUrl, fetchWithRetry } = await import("./client");
        const url = createApiUrl(`/products/${productId}/variants`);
        const response = await fetchWithRetry(url, {}, 3, 8000, false);

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
    { ttlSeconds: CACHE_TTL.LONG },
  );
}

/**
 * Defines the available options for filtering and sorting when fetching a list of products.
 */
export interface ProductListOptions {
  page?: number;
  limit?: number;
  sort?:
    | "newest"
    | "price-asc"
    | "price-desc"
    | "name-asc"
    | "name-desc"
    | "discount";
  search?: string;
  minPrice?: number;
  maxPrice?: number;
  freeDelivery?: boolean;
  hasDiscount?: boolean;
  ids?: string[] | string;
  [key: string]: string | number | boolean | string[] | undefined;
}

export interface SitemapProduct {
  slug: string;
  canonicalPath?: string | null;
  updatedAt: string | null;
}

type ProductListPayload = {
  products?: Product[];
  data?: Product[];
  pagination?: PaginatedResponse<Product>["pagination"];
};

type SitemapProductListPayload = {
  products?: SitemapProduct[];
  data?: SitemapProduct[];
  pagination?: PaginatedResponse<SitemapProduct>["pagination"];
};

type OptionalFeedProductsSdk = {
  getApiV1ProductsFeed?: (args: {
    client: unknown;
    query: Record<string, unknown>;
  }) => Promise<{ data?: unknown; error?: unknown }>;
};

function emptyProductPagination(
  options: ProductListOptions = {},
): PaginatedResponse<Product>["pagination"] {
  return {
    page: Number(options.page ?? 1),
    limit: Number(options.limit ?? 20),
    total: 0,
    totalPages: 0,
  };
}

function normalizeProductListOptions(
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

function normalizeProductListPayload(
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
  };
}

function normalizeSitemapProductListPayload(
  payload: unknown,
): PaginatedResponse<SitemapProduct> | null {
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

async function readDedicatedFeedProducts(
  options: ProductListOptions,
): Promise<PaginatedResponse<Product> | null> {
  const sdk = (await import("@scalius/api-client/sdk")) as OptionalFeedProductsSdk;
  if (typeof sdk.getApiV1ProductsFeed !== "function") {
    console.error("Dedicated product feed SDK route is missing.");
    return null;
  }

  try {
    const { data, error } = await sdk.getApiV1ProductsFeed({
      client: getConfiguredSdkClient(),
      query: options as Record<string, unknown>,
    });
    if (error) {
      console.error("Error fetching feed products:", error);
      return null;
    }
    return normalizeProductListPayload(data);
  } catch (error: unknown) {
    console.error("Error fetching feed products:", error);
    return null;
  }
}

/**
 * Fetches a paginated list of products belonging to a specific category.
 * Wrapped with EdgeCache (1h TTL) - shorter TTL as paginated data can be large.
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
  const cacheKey = `category_products_${categorySlug}_${queryString || "default"}`;

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
          pagination: PaginatedResponse<Product>["pagination"];
        }>(data);
        return d
          ? { category: d.category, data: d.products, pagination: d.pagination }
          : null;
      } catch (error: unknown) {
        console.error(
          `Error fetching products for category "${categorySlug}":`,
          error,
        );
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.MEDIUM },
  );
}

/**
 * Fetches a list of all products, with extensive filtering and sorting capabilities.
 * Wrapped with EdgeCache (1h TTL) - shorter TTL as paginated data can be large.
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
        const d = unwrapData<{ products: Product[]; pagination: PaginatedResponse<Product>["pagination"] }>(data);
        return d
          ? { data: d.products, pagination: d.pagination }
          : null;
      } catch (error: unknown) {
        console.error("Error fetching all products:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.MEDIUM },
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
): Promise<PaginatedResponse<Product> | null> {
  const normalizedOptions = normalizeProductListOptions({
    ...options,
    includeVariants: "true",
  });
  const queryString = buildCanonicalQueryString(normalizedOptions, {
    defaultParams: { page: 1, limit: 20, sort: "newest" },
  });
  const cacheKey = `feed_products_${queryString || "default"}`;

  return withEdgeCache(
    cacheKey,
    () => readDedicatedFeedProducts(normalizedOptions),
    { ttlSeconds: CACHE_TTL.MEDIUM },
  );
}

export async function getSitemapProducts(
  options: Pick<ProductListOptions, "page" | "limit"> = {},
): Promise<PaginatedResponse<SitemapProduct> | null> {
  const normalizedOptions = normalizeProductListOptions(options);
  const queryString = buildCanonicalQueryString(normalizedOptions, {
    defaultParams: { page: 1, limit: 100 },
  });
  const cacheKey = `sitemap_products_${queryString || "default"}`;

  return withEdgeCache(
    cacheKey,
    async () => {
      try {
        const { data, error } = await getApiV1ProductsSitemap({
          client: getConfiguredSdkClient(),
          query: {
            page: normalizedOptions.page,
            limit: normalizedOptions.limit,
          },
        });
        if (error) {
          console.error("Error fetching sitemap products:", error);
          return null;
        }
        return normalizeSitemapProductListPayload(data);
      } catch (error: unknown) {
        console.error("Error fetching sitemap products:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.MEDIUM },
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
