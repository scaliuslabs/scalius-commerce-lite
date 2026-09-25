// src/lib/api/categories.ts

import { getConfiguredSdkClient } from "./transport";
import type { Category } from "./types";
import { withEdgeCache, CACHE_TTL } from "@/lib/api/transport";
import { unwrapData } from "./unwrap";
import {
  getApiV1Categories,
  getApiV1CategoriesBySlug,
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
export async function getSitemapCategories(): Promise<SitemapCategory[] | null> {
  return withEdgeCache(
    "sitemap_categories",
    async () => {
      try {
        const { data, error } = await getApiV1CategoriesSitemap({ client: getConfiguredSdkClient() });
        if (error) {
          console.error("Error fetching sitemap categories:", error);
          return null;
        }
        return unwrapData<{ categories: SitemapCategory[] }>(data)?.categories ?? null;
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

/**
 * Fetches a single category by its URL-friendly slug.
 * Coalesced per request; the API caches it by cache generation.
 * @param slug The slug of the category.
 * @returns A promise resolving to a Category object or null if not found.
 */
export async function getCategoryBySlug(
  slug: string,
): Promise<Category | null> {
  if (!slug) {
    console.error("getCategoryBySlug: slug is required.");
    return null;
  }

  return withEdgeCache(
    `category_slug_${slug}`,
    async () => {
      try {
        const { data, error } = await getApiV1CategoriesBySlug({
          client: getConfiguredSdkClient(),
          path: { slug },
        });
        if (error) return null;
        return unwrapData<{ category: Category }>(data)?.category ?? null;
      } catch (error: unknown) {
        console.error(`Error fetching category by slug "${slug}":`, error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}
