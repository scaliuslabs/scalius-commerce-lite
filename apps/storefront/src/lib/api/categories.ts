import { sitemapPageBounds, type SitemapPageOptions } from "@scalius/shared/sitemap-pagination";
// src/lib/api/categories.ts

import { getConfiguredSdkClient } from "./transport";
import type { Category, PaginatedResponse } from "./types";
import { withEdgeCache, CACHE_TTL } from "@/lib/api/transport";
import { unwrapData } from "./unwrap";
import {
  getApiV1Categories,
  getApiV1CategoriesSitemap,
} from "@scalius/api-client/sdk";

export interface SitemapCategory {
  slug: string;
  canonicalPath: string | null;
  updatedAt: string | null;
}

/**
 * Category pages for the sitemap (the API leaves out noIndex and
 * excludeFromSitemap categories before its limit), or null on failure.
 */
export async function getSitemapCategories(options: SitemapPageOptions = {}): Promise<PaginatedResponse<SitemapCategory> | null> {
  const { page, limit } = sitemapPageBounds(options);
  return withEdgeCache(
    `sitemap_categories_${page}_${limit}`,
    async () => {
      try {
        const { data, error } = await getApiV1CategoriesSitemap({ client: getConfiguredSdkClient(), query: { page, limit } });
        if (error) {
          console.error("Error fetching sitemap categories:", error);
          return null;
        }
        const payload = unwrapData<{ categories: SitemapCategory[]; pagination: PaginatedResponse<SitemapCategory>["pagination"] }>(data);
        return payload?.pagination ? { data: payload.categories, pagination: payload.pagination } : null;
      } catch (error: unknown) {
        console.error("Error fetching sitemap categories:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}

/**
 * Fetches a list of all categories.
 * Coalesced per request; the API caches it by cache generation.
 * @returns A promise resolving to an array of Category objects or null on failure.
 */
export async function getAllCategories(): Promise<Category[] | null> {
  return withEdgeCache(
    "global_all_categories",
    async () => {
      try {
        const { data } = await getApiV1Categories({
          client: getConfiguredSdkClient(),
        });
        return unwrapData<{ categories: Category[] }>(data)?.categories ?? null;
      } catch (error: unknown) {
        console.error("Error fetching all categories:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}

