// src/lib/api/pages.ts

import { getConfiguredSdkClient } from "./client";
import type { ApiWidget, Page, PaginatedResponse } from "./types";
import { withEdgeCache, CACHE_TTL } from "@/lib/edge-cache";
import { unwrapData, unwrapEnvelope } from "./unwrap";
import { BUILD_ID } from "@/config/build-id";
import {
  getApiV1PagesSlugBySlug,
  getApiV1Pages,
  getApiV1StorefrontPagesSlugBySlug,
} from "@scalius/api-client/sdk";

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
        const { data, error } = await getApiV1PagesSlugBySlug({
          client: getConfiguredSdkClient(),
          path: { slug },
        });
        if (error) return null;
        return unwrapData<{ page: Page }>(data)?.page ?? null;
      } catch (error: unknown) {
        console.error(`Error fetching page by slug "${slug}":`, error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}

export interface PageRenderData {
  page: Page;
  widgets: ApiWidget[];
}

export async function getPageRenderData(
  slug: string,
): Promise<PageRenderData | null> {
  if (!slug) {
    console.error("getPageRenderData: slug is required.");
    return null;
  }

  return withEdgeCache(
    `page_render_${slug}_${BUILD_ID}`,
    async () => {
      try {
        const { data, error } = await getApiV1StorefrontPagesSlugBySlug({
          client: getConfiguredSdkClient(),
          path: { slug },
          headers: { "Cache-Control": "no-cache" },
        });
        if (error) return null;
        return unwrapEnvelope<PageRenderData>(data);
      } catch (error: unknown) {
        console.error(`Error fetching render data for page "${slug}":`, error);
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
        const { data } = await getApiV1Pages({
          client: getConfiguredSdkClient(),
          query: options as Record<string, unknown>,
        });
        const d = unwrapData<{ pages: Page[]; pagination: PaginatedResponse<Page>["pagination"] }>(data);
        if (d) {
          return { data: d.pages as Page[], pagination: d.pagination };
        }
        return null;
      } catch (error: unknown) {
        console.error("Error fetching all pages:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}
