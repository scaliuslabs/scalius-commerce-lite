// src/lib/api/search.ts

import { createApiUrl, fetchWithRetry } from "./client";
import type { SearchResults } from "./types";

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

  const params = new URLSearchParams({ q: query });
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) {
      params.append(key, String(value));
    }
  }

  try {
    const url = createApiUrl(`/search?${params.toString()}`);
    // Search is a public endpoint.
    const response = await fetchWithRetry(url, {}, 2, 10000, false);

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    return (await response.json()) as SearchResults;
  } catch (error) {
    console.error(`Error performing search for query "${query}":`, error);
    return null;
  }
}
