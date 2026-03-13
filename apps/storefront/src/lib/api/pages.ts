// src/lib/api/pages.ts

import { createApiUrl, fetchWithRetry } from "./client";
import type { Page, PaginatedResponse } from "./types";
import { withEdgeCache, CACHE_TTL } from "@/lib/edge-cache";

/**
 * Fetches a single CMS page by its URL-friendly slug.
 * This function only returns pages that are marked as 'published'.
 * Wrapped with EdgeCache (TTL) - invalidated via purge-cache.
 *
 * @param slug The unique slug of the page.
 * @returns A promise resolving to the Page object or null if not found or not published.
 */
export async function getPageBySlug(slug: string): Promise<Page | null> {
  if (!slug) {
    console.error("getPageBySlug: slug is required.");
    return null;
  }

  return withEdgeCache(
    `page_slug_${slug}`,
    async () => {
      try {
        const url = createApiUrl(`/pages/slug/${slug}`);
        const response = await fetchWithRetry(url, {}, 3, 8000, false);

        if (!response.ok) {
          if (response.status === 404) return null;
          throw new Error(`API error: ${response.status}`);
        }

        const data: { page: Page; success: boolean } = await response.json();
        return data.success ? data.page : null;
      } catch (error) {
        console.error(`Error fetching page by slug "${slug}":`, error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}

/**
 * Defines the available options for fetching a list of pages.
 */
export interface PageListOptions {
  page?: number;
  limit?: number;
  sort?: "title" | "createdAt" | "-title" | "-createdAt";
  publishedOnly?: boolean;
}

/**
 * Fetches a paginated list of all CMS pages.
 * Wrapped with EdgeCache (TTL) - invalidated via purge-cache.
 *
 * @param options Filtering, sorting, and pagination options.
 * @returns A promise resolving to a paginated list of Page objects or null on failure.
 */
export async function getAllPages(
  options: PageListOptions = {},
): Promise<PaginatedResponse<Page> | null> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) {
      params.append(key, String(value));
    }
  }
  const queryString = params.toString();
  const cacheKey = `all_pages_${queryString || "default"}`;

  return withEdgeCache(
    cacheKey,
    async () => {
      try {
        const url = createApiUrl(
          `/pages${queryString ? `?${queryString}` : ""}`,
        );
        const response = await fetchWithRetry(url, {}, 3, 8000, false);

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        const result = (await response.json()) as {
          pages: Page[];
          pagination: PaginatedResponse<any>["pagination"];
          success: boolean;
        };
        if (result.success) {
          return { data: result.pages, pagination: result.pagination };
        }
        return null;
      } catch (error) {
        console.error("Error fetching all pages:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}
