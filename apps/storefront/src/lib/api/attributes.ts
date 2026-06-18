// src/lib/api/attributes.ts

import { getConfiguredSdkClient } from "./client";
import { withEdgeCache, CACHE_TTL } from "@/lib/edge-cache";
import { unwrapData } from "./unwrap";
import {
  getApiV1AttributesFilterable,
  getApiV1AttributesCategorySlugByCategorySlug,
  getApiV1AttributesSearchFilters,
} from "@scalius/api-client/sdk";
import { normalizeSearchQuery } from "@/lib/search-query";

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
  const searchQuery = normalizeSearchQuery(options.searchQuery);
  const cacheKey = options.categorySlug
    ? `filterable_attrs_category_${options.categorySlug}`
    : searchQuery
      ? `filterable_attrs_search_${searchQuery}`
      : "filterable_attrs_global";

  return withEdgeCache(
    cacheKey,
    async () => {
      try {
        const client = getConfiguredSdkClient();
        let result: { data?: unknown };

        if (options.categorySlug) {
          result = await getApiV1AttributesCategorySlugByCategorySlug({
            client,
            path: { categorySlug: options.categorySlug },
          });
        } else if (searchQuery) {
          result = await getApiV1AttributesSearchFilters({
            client,
            query: { q: searchQuery },
          });
        } else {
          result = await getApiV1AttributesFilterable({ client });
        }

        return unwrapData<{ filters: FilterableAttribute[] }>(result.data)?.filters ?? null;
      } catch (error: unknown) {
        console.error("Error fetching filterable attributes:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}
