/**
 * Products Sitemap
 * Contains all active product pages
 * Supports pagination for large product catalogs (?page=1)
 * Limit: 50,000 URLs per sitemap page (as per sitemap protocol)
 */

import { generateSitemap, getSitemapHeaders } from '@/lib/sitemap-utils';
import type { SitemapUrl } from '@/lib/sitemap-utils';
import { getAllProducts } from '@/lib/api/products';
import { getRuntimeStorefrontUrl } from '@/lib/runtime-env';
import type { APIContext, APIRoute } from 'astro';
import type { Product } from '@/lib/api/types';

export const prerender = false;

const URLS_PER_SITEMAP = 5000; // Chunk size safe for Cloudflare Workers

export const GET: APIRoute = async ({ url, locals }: APIContext) => {
  try {
    const baseUrl = getRuntimeStorefrontUrl(locals);

    // Get page number from query params (default to 1)
    const pageParam = url.searchParams.get('page');
    const sitemapPage = pageParam ? parseInt(pageParam, 10) : 1;

    if (isNaN(sitemapPage) || sitemapPage < 1) {
      return new Response('Invalid page parameter', { status: 400 });
    }

    const allProducts: Product[] = [];
    const limitParams = 100; // Fetch 100 products per API call

    // We need 50 API pages to fulfill 1 sitemap chunk of 5000 products.
    // E.g., sitemapPage=1 needs api pages [1..50]. sitemapPage=2 needs api pages [51..100].
    const startApiPage = ((sitemapPage - 1) * (URLS_PER_SITEMAP / limitParams)) + 1;
    let requiredApiPages = URLS_PER_SITEMAP / limitParams;

    // We can fetch the first page to figure out totalPages so we don't over-fetch
    const firstResponse = await getAllProducts({
      page: startApiPage,
      limit: limitParams,
    });

    if (!firstResponse || !firstResponse.data || firstResponse.data.length === 0) {
      if (sitemapPage > 1) {
        return new Response('Page not found', { status: 404 });
      }
      return new Response(generateSitemap([], baseUrl), { status: 200, headers: getSitemapHeaders() });
    }

    allProducts.push(...firstResponse.data.filter((p) => p.isActive !== false));
    const totalPages = firstResponse.pagination.totalPages;

    // Limit requiredApiPages if we hit the end of the total products early
    const maxApiPage = Math.min(startApiPage + requiredApiPages - 1, totalPages);

    // Fetch remaining API pages needed for this sitemap chunk in parallel batches of 5 to avoid timeout
    const BATCH_SIZE = 5;
    for (let currentApiPage = startApiPage + 1; currentApiPage <= maxApiPage; currentApiPage += BATCH_SIZE) {
      const fetchPromises = [];
      const endBatchPage = Math.min(currentApiPage + BATCH_SIZE - 1, maxApiPage);

      for (let p = currentApiPage; p <= endBatchPage; p++) {
        fetchPromises.push(getAllProducts({ page: p, limit: limitParams }));
      }

      const batchResponses = await Promise.all(fetchPromises);
      for (const res of batchResponses) {
        if (res && res.data) {
          allProducts.push(...res.data.filter((p) => p.isActive !== false));
        }
      }
    }

    if (allProducts.length === 0 && sitemapPage > 1) {
      return new Response('Page not found', { status: 404 });
    }

    const productUrls: SitemapUrl[] = allProducts.map((product) => ({
      loc: `${baseUrl}/products/${product.slug}`,
      lastmod: product.updatedAt,
      changefreq: 'daily' as const,
      priority: 0.9,
    }));

    const xml = generateSitemap(productUrls, baseUrl);

    return new Response(xml, {
      status: 200,
      headers: getSitemapHeaders(),
    });
  } catch (error) {
    console.error('Error generating products sitemap:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
};
