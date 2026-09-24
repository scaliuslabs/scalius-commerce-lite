/**
 * Products Sitemap
 * Contains all active product pages
 * Supports pagination for large product catalogs (?page=1)
 * Limit: 50,000 URLs per sitemap page (as per sitemap protocol)
 */

import { generateSitemap, getBaseUrl, getSitemapHeaders, xmlDataUnavailableResponse } from '@/lib/sitemap-utils';
import type { SitemapUrl } from '@/lib/sitemap-utils';
import { getSitemapProducts } from '@/lib/api/products';
import type { APIContext, APIRoute } from 'astro';
import { normalizeResourceCanonicalPath } from '@scalius/shared/seo-canonical';

export const prerender = false;

const URLS_PER_SITEMAP = 5000; // Chunk size safe for Cloudflare Workers

function parsePositiveIntegerParam(
  value: string | null,
  fallback: number,
): number | null {
  if (value === null) return fallback;
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return null;
  return parsed;
}

export const GET: APIRoute = async ({ url }: APIContext) => {
  try {
    const baseUrl = getBaseUrl();

    // Get page number from query params (default to 1)
    const pageParam = url.searchParams.get('page');
    const sitemapPage = parsePositiveIntegerParam(pageParam, 1);

    if (sitemapPage === null) {
      return new Response('Invalid page parameter', { status: 400 });
    }

    // One API read per sitemap chunk: the API pages the sitemap projection up
    // to 5000 rows. Reading 50 pages of 100 repeated the public-catalogue
    // count and a deeper OFFSET scan 50 times per chunk (about 300 reads for a
    // 30k-product store's six chunks).
    const response = await getSitemapProducts({
      page: sitemapPage,
      limit: URLS_PER_SITEMAP,
    });

    if (!response) {
      return xmlDataUnavailableResponse('Product sitemap is temporarily unavailable');
    }

    const allProducts = response.data ?? [];
    if (allProducts.length === 0 && sitemapPage > 1) {
      return new Response('Page not found', { status: 404 });
    }

    const productUrls: SitemapUrl[] = allProducts.map((product) => ({
      loc: `${baseUrl}${normalizeResourceCanonicalPath('product', product.canonicalPath) ?? `/products/${product.slug}`}`,
      lastmod: product.updatedAt ?? undefined,
    }));

    const xml = generateSitemap(productUrls, baseUrl);

    return new Response(xml, {
      status: 200,
      headers: getSitemapHeaders(),
    });
  } catch (error: unknown) {
    console.error('Error generating products sitemap:', error);
    return xmlDataUnavailableResponse('Product sitemap is temporarily unavailable');
  }
};
