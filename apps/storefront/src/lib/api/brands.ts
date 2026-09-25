// src/lib/api/brands.ts
// Brand reads: the brand page listing and the brand sitemap. Coalesced per
// request; the API caches them under the store's cache generation.

import { getConfiguredSdkClient, withEdgeCache, CACHE_TTL } from "./transport";
import type { Brand, BrandProductsResponse, PaginatedResponse, Product } from "./types";
import { unwrapData } from "./unwrap";
import {
  getApiV1BrandsBySlugProducts,
  getApiV1BrandsSitemap,
} from "@scalius/api-client/sdk";
import { buildCanonicalQueryString } from "@/lib/canonical-query";
import {
  emptyProductPagination,
  normalizeBuyerPriceRange,
  normalizeProductFacets,
  normalizeRatingFacet,
  normalizeProductListOptions,
  type ProductListOptions,
} from "./products";

export interface SitemapBrand {
  slug: string;
  canonicalPath: string | null;
  updatedAt: string | null;
}

/**
 * A brand page's products with the brand record, filters and facets.
 * `brandNotFound` is an authoritative 404 (unpublished, trashed or unknown);
 * null means the API could not answer.
 */
export async function getProductsByBrand(
  brandSlug: string,
  options: ProductListOptions = {},
): Promise<BrandProductsResponse | null> {
  if (!brandSlug) return null;
  const normalizedOptions = normalizeProductListOptions(options);
  const queryString = buildCanonicalQueryString(normalizedOptions, {
    defaultParams: { page: 1, limit: 20, sort: "newest" },
  });

  return withEdgeCache(
    `brand_products_${brandSlug}_${queryString || "default"}`,
    async () => {
      try {
        const { data, error, response } = await getApiV1BrandsBySlugProducts({
          client: getConfiguredSdkClient(),
          path: { slug: brandSlug },
          query: normalizedOptions as Record<string, unknown>,
        });
        if (error) {
          if (response?.status === 404) {
            return { brand: null, brandNotFound: true, data: [], pagination: emptyProductPagination(options) };
          }
          console.error(`Error fetching products for brand "${brandSlug}":`, error);
          return null;
        }
        const payload = unwrapData<{
          brand: Brand;
          products: Product[];
          pagination: PaginatedResponse<Product>["pagination"];
          priceRange?: unknown;
          facets?: unknown;
          ratingFacet?: unknown;
        }>(data);
        return payload
          ? {
              brand: payload.brand,
              data: payload.products,
              pagination: payload.pagination,
              priceRange: normalizeBuyerPriceRange(payload.priceRange),
              facets: normalizeProductFacets(payload.facets),
              ratingFacet: normalizeRatingFacet(payload.ratingFacet),
            }
          : null;
      } catch (error: unknown) {
        console.error(`Error fetching products for brand "${brandSlug}":`, error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.AVAILABILITY },
  );
}

/** Brand pages for the sitemap (already filtered for noIndex and excludeFromSitemap), or null on failure. */
export async function getSitemapBrands(): Promise<SitemapBrand[] | null> {
  return withEdgeCache(
    "sitemap_brands",
    async () => {
      try {
        const { data, error } = await getApiV1BrandsSitemap({ client: getConfiguredSdkClient() });
        if (error) {
          console.error("Error fetching sitemap brands:", error);
          return null;
        }
        return unwrapData<{ brands: SitemapBrand[] }>(data)?.brands ?? null;
      } catch (error: unknown) {
        console.error("Error fetching sitemap brands:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}
