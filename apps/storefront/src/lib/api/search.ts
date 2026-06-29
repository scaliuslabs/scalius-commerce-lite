// src/lib/api/search.ts

import { getConfiguredSdkClient } from "./client";
import type { SearchResults } from "./types";
import { unwrapData } from "./unwrap";
import { getApiV1Search } from "@scalius/api-client/sdk";
import { normalizeSearchQuery } from "@/lib/search-query";

/**
 * Defines the available options for a search query.
 */
export interface SearchOptions {
  categoryId?: string;
  minPrice?: number;
  maxPrice?: number;
  limit?: number;
  searchPages?: boolean;
  searchCategories?: boolean;
}

/**
 * Performs a site-wide search for products, categories, and pages.
 *
 * @param query The user's search term.
 * @param options Filtering and limiting options for the search.
 * @returns A promise resolving to a SearchResults object or null on failure.
 */
export async function search(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResults | null> {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) {
    return {
      products: [],
      categories: [],
      pages: [],
      success: true,
      query: "",
      timestamp: new Date().toISOString(),
    };
  }

  try {
    const { data } = await getApiV1Search({
      client: getConfiguredSdkClient(),
      query: { q: normalizedQuery, ...options } as Record<string, unknown>,
    });
    return unwrapData<SearchResults>(data);
  } catch (error: unknown) {
    console.error(`Error performing search for query "${normalizedQuery}":`, error);
    return null;
  }
}
