// CMS pages and blog articles for the XML sitemaps: one bounded API read per
// 5,000-URL sitemap document, with the complete count the index pages by.
import { sitemapPageBounds, type SitemapPageOptions } from "@scalius/shared/sitemap-pagination";
import { getApiV1ArticlesSitemap, getApiV1PagesSitemap } from "@scalius/api-client/sdk";
import { getConfiguredSdkClient, withEdgeCache, CACHE_TTL } from "./transport";
import type { PaginatedResponse } from "./types";
import { unwrapData } from "./unwrap";

export interface SitemapContentEntry {
  slug: string;
  canonicalPath: string | null;
  updatedAt: string | null;
  publishedAt: string | null;
}

export type SitemapContentKind = "pages" | "articles";

/**
 * One sitemap document of public pages or articles (the API leaves out
 * noIndex and excludeFromSitemap ones before its limit), or null on failure.
 */
export async function getSitemapContent(
  kind: SitemapContentKind,
  options: SitemapPageOptions = {},
): Promise<PaginatedResponse<SitemapContentEntry> | null> {
  const { page, limit } = sitemapPageBounds(options);
  const read = kind === "pages" ? getApiV1PagesSitemap : getApiV1ArticlesSitemap;
  return withEdgeCache(
    `sitemap_${kind}_${page}_${limit}`,
    async () => {
      try {
        const { data, error } = await read({ client: getConfiguredSdkClient(), query: { page, limit } });
        if (error) {
          console.error(`Error fetching sitemap ${kind}:`, error);
          return null;
        }
        const payload = unwrapData<{ entries: SitemapContentEntry[]; pagination: PaginatedResponse<SitemapContentEntry>["pagination"] }>(data);
        return payload?.pagination ? { data: payload.entries, pagination: payload.pagination } : null;
      } catch (error: unknown) {
        console.error(`Error fetching sitemap ${kind}:`, error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}
