// src/lib/api/attributes.ts

import { createApiUrl, fetchWithRetry } from "./client";
import { withEdgeCache, CACHE_TTL } from "@/lib/edge-cache";

export interface FilterableAttribute {
  id: string;
  name: string;
  slug: string;
  values: string[];
}

/**
 * Fetches the filterable attributes and their unique values.
 * This can be scoped to a specific category or search query.
 * Wrapped with EdgeCache (TTL) - invalidated via purge-cache.
 *
 * @param options An object with either 'categorySlug' or 'searchQuery'.
 * @returns A promise resolving to an array of filterable attributes or null on failure.
 */
export async function getFilterableAttributes(
  options: { categorySlug?: string; searchQuery?: string } = {},
): Promise<FilterableAttribute[] | null> {
  const cacheKey = options.categorySlug
    ? `filterable_attrs_category_${options.categorySlug}`
    : options.searchQuery
      ? `filterable_attrs_search_${options.searchQuery}`
      : "filterable_attrs_global";

  return withEdgeCache(
    cacheKey,
    async () => {
      try {
        let url: string;

        if (options.categorySlug) {
          url = createApiUrl(
            `/attributes/category-slug/${options.categorySlug}`,
          );
        } else if (options.searchQuery) {
          const params = new URLSearchParams({ q: options.searchQuery });
          url = createApiUrl(`/attributes/search-filters?${params.toString()}`);
        } else {
          url = createApiUrl("/attributes/filterable");
        }

        const response = await fetchWithRetry(url, {}, 3, 8000, false);

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        const data: { filters: FilterableAttribute[] } = await response.json();
        return data.filters;
      } catch (error) {
        console.error("Error fetching filterable attributes:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}
