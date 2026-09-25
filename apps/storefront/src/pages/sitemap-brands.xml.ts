/**
 * Brands Sitemap
 * Published brand pages; the API leaves out noIndex and excludeFromSitemap
 * brands before its limit.
 */

import {
  generateSitemap,
  getBaseUrl,
  getSitemapHeaders,
  xmlDataUnavailableResponse,
} from "@/lib/sitemap-utils";
import type { SitemapUrl } from "@/lib/sitemap-utils";
import { getSitemapBrands } from "@/lib/api/brands";
import type { APIContext, APIRoute } from "astro";
import { normalizeResourceCanonicalPath } from "@scalius/shared/seo-canonical";

export const prerender = false;

export const GET: APIRoute = async (_context: APIContext) => {
  try {
    const baseUrl = getBaseUrl();
    const brands = await getSitemapBrands();
    if (!brands) {
      console.error("Failed to fetch brands for sitemap");
      return xmlDataUnavailableResponse("Brand sitemap is temporarily unavailable");
    }

    const brandUrls: SitemapUrl[] = brands.map((brand) => ({
      loc: `${baseUrl}${normalizeResourceCanonicalPath("brand", brand.canonicalPath) ?? `/brands/${brand.slug}`}`,
      lastmod: brand.updatedAt ?? undefined,
    }));

    return new Response(generateSitemap(brandUrls, baseUrl), {
      status: 200,
      headers: getSitemapHeaders(),
    });
  } catch (error: unknown) {
    console.error("Error generating brands sitemap:", error);
    return xmlDataUnavailableResponse("Brand sitemap is temporarily unavailable");
  }
};
