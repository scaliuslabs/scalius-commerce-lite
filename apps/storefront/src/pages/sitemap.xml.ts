/**
 * Master Sitemap Index
 * Links to all sub-sitemaps (static, pages, articles, categories, brands,
 * collections, products), every 5,000-URL document of each. The root index also lists every active subfolder
 * presence's own sub-sitemaps (`/en-in/sitemap-products.xml`), whose URLs
 * carry that presence; a presence's index (`/en-in/sitemap.xml`) lists its
 * own. A store with one presence lists exactly the root's.
 */

import type { APIRoute } from "astro";
import { SITEMAP_PAGE_SIZE } from "@scalius/shared/sitemap-pagination";
import { getSitemapCategories } from "@/lib/api/categories";
import { getSitemapBrands } from "@/lib/api/brands";
import { getSitemapCollections } from "@/lib/api/collections";
import { getSitemapContent } from "@/lib/api/content-sitemap";
import { activePresences } from "@scalius/shared/markets";
import {
  generateSitemapIndex,
  getBaseUrl,
  getSitemapHeaders,
  xmlDataUnavailableResponse,
} from "@/lib/sitemap-utils";
import { getSitemapProductsOutline } from "@/lib/api/products";
import { getLayoutData } from "@/lib/api/storefront";
import { getRuntimePresence } from "@/lib/api/runtime";
import type { APIContext } from "astro";

export const prerender = false;

const CHILD_SITEMAPS = [
  "sitemap-static.xml",
] as const;

export const GET: APIRoute = async (_context: APIContext) => {
  try {
    const baseUrl = getBaseUrl();
    const presence = getRuntimePresence();

    // Counts use the same visibility predicates as each chunk. Read sequentially:
    // simultaneous count+page reads would exceed D1's six connections.
    const catalogReads = [
      ["pages", (options: { limit: number }) => getSitemapContent("pages", options)],
      ["articles", (options: { limit: number }) => getSitemapContent("articles", options)],
      ["categories", getSitemapCategories],
      ["brands", getSitemapBrands],
      ["collections", getSitemapCollections],
    ] as const;
    const catalogPages: Array<{ kind: string; pages: string[] }> = [];
    for (const [kind, read] of catalogReads) {
      const response = await read({ limit: 1 });
      if (!response) return xmlDataUnavailableResponse("Sitemap index is temporarily unavailable");
      const totalPages = Math.max(1, Math.ceil(response.pagination.total / SITEMAP_PAGE_SIZE));
      catalogPages.push({ kind, pages: Array.from({ length: totalPages }, (_, index) => `page=${index + 1}`) });
    }
    // Products: the only count, with the signed boundary each later page starts after.
    const productOutline = await getSitemapProductsOutline(SITEMAP_PAGE_SIZE);
    if (!productOutline) return xmlDataUnavailableResponse("Sitemap index is temporarily unavailable");
    catalogPages.push({
      kind: "products",
      pages: ["page=1", ...productOutline.pages.map(({ page, after }) => `page=${page}&after=${encodeURIComponent(after)}`)],
    });
    const layout = presence ? null : await getLayoutData();
    if (!presence && !layout) return xmlDataUnavailableResponse("Sitemap index is temporarily unavailable");

    // The root index lists the root's children, then every other active
    // presence's; a presence's own index lists its own.
    const prefixes = presence
      ? [`/${presence}`]
      : ["", ...activePresences(layout?.markets ?? { markets: [] })
        .map(({ presence: each }) => each.value)
        .filter((value) => value !== "")
        .map((value) => `/${value}`)];
    const sitemaps = prefixes.flatMap((prefix) => [
      ...CHILD_SITEMAPS.map((path) => ({ loc: `${baseUrl}${prefix}/${path}` })),
      ...catalogPages.flatMap(({ kind, pages }) => pages.map((query) => ({
        loc: `${baseUrl}${prefix}/sitemap-${kind}.xml?${query}`,
      }))),
    ]);

    const xml = generateSitemapIndex(sitemaps, baseUrl);

    return new Response(xml, {
      status: 200,
      headers: getSitemapHeaders(),
    });
  } catch (error: unknown) {
    console.error("Error generating sitemap index:", error);
    return xmlDataUnavailableResponse(
      "Sitemap index is temporarily unavailable",
    );
  }
};
