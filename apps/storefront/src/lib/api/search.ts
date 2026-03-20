// src/lib/api/search.ts

import { getConfiguredSdkClient } from "./client";
import type { SearchResults } from "./types";
import { unwrapData } from "./unwrap";
import { getApiV1Search } from "@scalius/api-client/sdk";

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
  if (!query || !query.trim()) {
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
      query: { q: query, ...options } as Record<string, unknown>,
    });
    return unwrapData<SearchResults>(data);
  } catch (error: unknown) {
    console.error(`Error performing search for query "${query}":`, error);
    return null;
  }
}
