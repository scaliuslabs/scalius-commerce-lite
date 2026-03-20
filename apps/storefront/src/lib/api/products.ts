// src/lib/api/products.ts

import { getConfiguredSdkClient } from "./client";
import type {
  Product,
  ProductVariant,
  ProductImage,
  PaginatedResponse,
} from "./types";
import { withEdgeCache, CACHE_TTL } from "@/lib/edge-cache";
import {
  getApiV1ProductsBySlug,
  getApiV1Products,
  getApiV1CategoriesBySlugProducts,
  getApiV1Search,
} from "@scalius/api-client/sdk";

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
        return (data as any)?.data ?? null;
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
  ids?: string[];
  [key: string]: any;
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
): Promise<PaginatedResponse<Product> | null> {
  if (!categorySlug) {
    console.error("getProductsByCategory: categorySlug is required.");
    return null;
  }

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) {
      params.append(key, String(value));
    }
  }
  const queryString = params.toString();
  const cacheKey = `category_products_${categorySlug}_${queryString || "default"}`;

  return withEdgeCache(
    cacheKey,
    async () => {
      try {
        const { data, error } = await getApiV1CategoriesBySlugProducts({
          client: getConfiguredSdkClient(),
          path: { slug: categorySlug },
          query: options as Record<string, unknown>,
        });

        if (error) {
          return {
            data: [],
            pagination: {
              page: 1,
              limit: options.limit || 20,
              total: 0,
              totalPages: 0,
            },
          };
        }

        const d = (data as any)?.data;
        return { data: d?.products ?? [], pagination: d?.pagination };
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
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) {
      params.append(key, String(value));
    }
  }
  const queryString = params.toString();
  const cacheKey = `all_products_${queryString || "default"}`;

  return withEdgeCache(
    cacheKey,
    async () => {
      try {
        const { data } = await getApiV1Products({
          client: getConfiguredSdkClient(),
          query: options as Record<string, unknown>,
        });
        const d = (data as any)?.data;
        return { data: d?.products ?? [], pagination: d?.pagination };
      } catch (error: unknown) {
        console.error("Error fetching all products:", error);
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
 * NOTE: This uses the global /search endpoint which returns products without
 * inline variants. If you need variants, fetch them separately with getProductVariants().
 *
 * @param search The search term.
 * @param _page The page number for pagination (not supported by /search - included for API compatibility).
 * @param limit The number of results per page.
 * @returns A promise resolving to a paginated list of products.
 */
export async function searchProductsForForm(
  search: string,
  _page: number = 1,
  limit: number = 10,
): Promise<PaginatedResponse<
  Product & { variants?: ProductVariant[] }
> | null> {
  if (!search || !search.trim()) {
    return {
      data: [],
      pagination: { page: 1, limit, total: 0, totalPages: 0 },
    };
  }

  try {
    const { data } = await getApiV1Search({
      client: getConfiguredSdkClient(),
      query: { q: search, limit } as Record<string, unknown>,
    });

    const d = data as any;
    if (d?.success) {
      const products = d.data?.products ?? [];
      return {
        data: products as (Product & { variants?: ProductVariant[] })[],
        pagination: {
          page: 1,
          limit,
          total: products.length,
          totalPages: 1,
        },
      };
    }
    return null;
  } catch (error: unknown) {
    console.error(
      `Error searching for products with query "${search}":`,
      error,
    );
    return null;
  }
}
