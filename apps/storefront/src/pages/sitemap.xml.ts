/**
 * Master Sitemap Index
 * Links to all sub-sitemaps (products, categories, pages, static)
 */

import type { APIRoute } from 'astro';
import { generateSitemapIndex, getSitemapHeaders } from '@/lib/sitemap-utils';
import { getAllProducts } from '@/lib/api/products';
import { getRuntimeStorefrontUrl } from '@/lib/runtime-env';
import type { APIContext } from 'astro';

export const prerender = false;

// Max URLs per sitemap chunk
const PRODUCTS_PER_SITEMAP = 5000;

export const GET: APIRoute = async ({ locals }: APIContext) => {
  try {
    const baseUrl = getRuntimeStorefrontUrl(locals);
    const now = new Date().toISOString();

    // Generate sitemap index with all sub-sitemaps
    const sitemaps = [
      {
        loc: `${baseUrl}/sitemap-static.xml`,
        lastmod: now,
      },
      {
        loc: `${baseUrl}/sitemap-categories.xml`,
        lastmod: now,
      },
      {
        loc: `${baseUrl}/sitemap-pages.xml`,
        lastmod: now,
      },
    ];

    // Fetch just 1 product to get the total count for pagination
    const productsResponse = await getAllProducts({ limit: 1 });
    const totalProducts = productsResponse?.pagination?.total || 0;

    // Calculate how many product sitemap chunks we need
    // If totalProducts is 0, we still want to output at least page=1
    const totalSitemaps = Math.max(1, Math.ceil(totalProducts / PRODUCTS_PER_SITEMAP));

    for (let i = 1; i <= totalSitemaps; i++) {
      sitemaps.push({
        loc: `${baseUrl}/sitemap-products.xml?page=${i}`,
        lastmod: now,
      });
    }

    // Add Facebook feed as well
    sitemaps.push({
      loc: `${baseUrl}/api/facebook-feed.xml`,
      lastmod: now,
    });


    const xml = generateSitemapIndex(sitemaps, baseUrl);

    return new Response(xml, {
      status: 200,
      headers: getSitemapHeaders(),
    });
  } catch (error) {
    console.error('Error generating sitemap index:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
};
