/**
 * Master Sitemap Index
 * Links to all sub-sitemaps (static, categories, brands, collections, pages, articles, products)
 */

import type { APIRoute } from "astro";
import {
  generateSitemapIndex,
  getBaseUrl,
  getSitemapHeaders,
  xmlDataUnavailableResponse,
} from "@/lib/sitemap-utils";
import { getSitemapProducts } from "@/lib/api/products";
import type { APIContext } from "astro";

export const prerender = false;

// Max URLs per sitemap chunk
const PRODUCTS_PER_SITEMAP = 5000;

export const GET: APIRoute = async (_context: APIContext) => {
  try {
    const baseUrl = getBaseUrl();
    const sitemaps = [
      "sitemap-static.xml",
      "sitemap-categories.xml",
      "sitemap-brands.xml",
      "sitemap-collections.xml",
      "sitemap-pages.xml",
      "sitemap-articles.xml",
    ].map((path) => ({ loc: `${baseUrl}/${path}` }));

    // Fetch just 1 product to get the total count for pagination
    const productsResponse = await getSitemapProducts({ limit: 1 });
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

    for (let i = 1; i <= totalSitemaps; i++) {
      sitemaps.push({
        loc: `${baseUrl}/sitemap-products.xml?page=${i}`,
      });
    }

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
