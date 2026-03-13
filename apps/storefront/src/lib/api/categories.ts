// src/lib/api/categories.ts

import { createApiUrl, fetchWithRetry } from "./client";
import type { Category } from "./types";
import { withEdgeCache, CACHE_TTL } from "@/lib/edge-cache";

/**
 * Fetches a list of all categories.
 * Wrapped with EdgeCache (TTL) - invalidated via purge-cache.
 * @returns A promise resolving to an array of Category objects or null on failure.
 */
export async function getAllCategories(): Promise<Category[] | null> {
  return withEdgeCache(
    "global_all_categories",
    async () => {
      try {
        const url = createApiUrl("/categories");
        const response = await fetchWithRetry(url, {}, 3, 8000, false);

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        const data: { categories: Category[] } = await response.json();
        return data.categories;
      } catch (error) {
        console.error("Error fetching all categories:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}

/**
 * Fetches a single category by its URL-friendly slug.
 * Wrapped with EdgeCache (TTL) - invalidated via purge-cache.
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
        const url = createApiUrl(`/categories/${slug}`);
        const response = await fetchWithRetry(url, {}, 3, 8000, false);

        if (!response.ok) {
          if (response.status === 404) return null;
          throw new Error(`API error: ${response.status}`);
        }

        const data: { category: Category } = await response.json();
        return data.category;
      } catch (error) {
        console.error(`Error fetching category by slug "${slug}":`, error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}
