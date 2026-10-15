// src/lib/api/pages.ts

import { apiFetch, getConfiguredSdkClient } from "./transport";
import type { Page, PaginatedResponse } from "./types";
import { withEdgeCache, CACHE_TTL } from "@/lib/api/transport";
import { unwrapData, unwrapEnvelope } from "./unwrap";
import { BUILD_ID } from "@/config/build-id";
import type { HomepageSectionData } from "./storefront";
import {
  getApiV1PagesSlugBySlug,
  getApiV1Pages,
  getApiV1StorefrontPagesSlugBySlug,
  getApiV1StorefrontLandingBySlug,
  getApiV1StorefrontTemplateByKind,
} from "@scalius/api-client/sdk";
import type { StorefrontPageTemplate } from "@scalius/shared/storefront-theme";

/**
 * Fetches a single CMS page by its URL-friendly slug.
 * This function only returns pages that are marked as 'published'.
 * Coalesced per request; the API caches it by cache generation.
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
}

/** A published landing page's words and its sections' data (its sections come from the layout's theme). */
export interface LandingPageData {
  title: string;
  description: string;
  sections: HomepageSectionData;
}

/**
 * A published landing page (`/pages/<slug>`) with its sections' data:
 * `"missing"` when the live theme has no page at that handle (a 404), null
 * when the read failed (the page answers 503 rather than a false 404).
 * Starts beside the layout read and joins its one public batch.
 */
export async function getLandingPageData(slug: string): Promise<LandingPageData | "missing" | null> {
  return withEdgeCache<LandingPageData | "missing">(`landing_${slug}_${BUILD_ID}`, async () => {
    const { data, response } = await getApiV1StorefrontLandingBySlug({
      client: getConfiguredSdkClient(), path: { slug },
    });
    if (response?.status === 404) return "missing";
    if (!response?.ok) return null;
    return unwrapEnvelope<LandingPageData>(data);
  }, { ttlSeconds: CACHE_TTL.LONG });
}

/**
 * What a page template's sections show (the sections around a product,
 * listing, cart or CMS page's fixed part); null when the read failed, so
 * the page renders without them. Starts beside the layout read and joins
 * its one public batch.
 */
export async function getTemplateSectionsData(kind: StorefrontPageTemplate, resource?: string): Promise<HomepageSectionData | null> {
  return withEdgeCache<HomepageSectionData | null>(`template_${kind}_${resource ?? ""}_${BUILD_ID}`, async () => {
    try {
      if (resource) {
        const response = await apiFetch(`/storefront/template/${kind}?resource=${encodeURIComponent(resource)}`, {}, { auth: false });
        return response.ok ? unwrapEnvelope<{ sections: HomepageSectionData }>(await response.json())?.sections ?? null : null;
      }
      const { data, response } = await getApiV1StorefrontTemplateByKind({
        client: getConfiguredSdkClient(), path: { kind },
      });
      if (!response?.ok) return null;
      return unwrapEnvelope<{ sections: HomepageSectionData }>(data)?.sections ?? null;
    } catch {
      return null;
    }
  }, { ttlSeconds: CACHE_TTL.LONG });
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
}

/**
 * Fetches a paginated list of all CMS pages.
 * Coalesced per request; the API caches it by cache generation.
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
