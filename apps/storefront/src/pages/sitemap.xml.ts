/**
 * Master Sitemap Index
 * Links to all sub-sitemaps (static, categories, brands, collections, pages,
 * articles, products). The root index also lists every active subfolder
 * presence's own sub-sitemaps (`/en-in/sitemap-products.xml`), whose URLs
 * carry that presence; a presence's index (`/en-in/sitemap.xml`) lists its
 * own. A store with one presence lists exactly the root's.
 */

import type { APIRoute } from "astro";
import { activePresences } from "@scalius/shared/markets";
import {
  generateSitemapIndex,
  getBaseUrl,
  getSitemapHeaders,
  xmlDataUnavailableResponse,
} from "@/lib/sitemap-utils";
import { getSitemapProducts } from "@/lib/api/products";
import { getLayoutData } from "@/lib/api/storefront";
import { getRuntimePresence } from "@/lib/api/runtime";
import type { APIContext } from "astro";

export const prerender = false;

// Max URLs per sitemap chunk
const PRODUCTS_PER_SITEMAP = 5000;

const CHILD_SITEMAPS = [
  "sitemap-static.xml",
  "sitemap-categories.xml",
  "sitemap-brands.xml",
  "sitemap-collections.xml",
  "sitemap-pages.xml",
  "sitemap-articles.xml",
] as const;

export const GET: APIRoute = async (_context: APIContext) => {
  try {
    const baseUrl = getBaseUrl();
    const presence = getRuntimePresence();

    // Fetch just 1 product to get the total count for pagination
    const [productsResponse, layout] = await Promise.all([
      getSitemapProducts({ limit: 1 }),
      presence ? Promise.resolve(null) : getLayoutData(),
    ]);
    if (!productsResponse) {
      return xmlDataUnavailableResponse(
        "Sitemap index is temporarily unavailable",
      );
    }
    const totalProducts = productsResponse?.pagination?.total || 0;

    // Calculate how many product sitemap chunks we need
    // If totalProducts is 0, we still want to output at least page=1
    const totalSitemaps = Math.max(
      1,
      Math.ceil(totalProducts / PRODUCTS_PER_SITEMAP),
    );

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
      ...Array.from({ length: totalSitemaps }, (_, index) => ({
        loc: `${baseUrl}${prefix}/sitemap-products.xml?page=${index + 1}`,
      })),
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
