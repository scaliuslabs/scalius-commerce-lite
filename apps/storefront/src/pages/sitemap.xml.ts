/**
 * Master Sitemap Index
 * Links to all sub-sitemaps (products, categories, pages, static)
 */

import type { APIRoute } from 'astro';
import { generateSitemapIndex, getBaseUrl, getSitemapHeaders, xmlDataUnavailableResponse } from '@/lib/sitemap-utils';
import { getAllProducts } from '@/lib/api/products';
import { getSeoSettings } from '@/lib/api';
import type { APIContext } from 'astro';
import { normalizeSeoDiscoverySettings } from '@scalius/shared/seo-discovery';

export const prerender = false;

// Max URLs per sitemap chunk
const PRODUCTS_PER_SITEMAP = 5000;

export const GET: APIRoute = async (_context: APIContext) => {
  try {
    const baseUrl = getBaseUrl();
    const now = new Date().toISOString();
    const seo = await getSeoSettings();
    if (!seo) {
      return xmlDataUnavailableResponse('Sitemap index is temporarily unavailable');
    }

    const sitemapPolicy = normalizeSeoDiscoverySettings(seo.discovery).sitemap;
    if (!sitemapPolicy.enabled) {
      return new Response(generateSitemapIndex([], baseUrl), {
        status: 200,
        headers: getSitemapHeaders(),
      });
    }

    // Generate sitemap index with all sub-sitemaps
    const sitemaps = [];

    if (sitemapPolicy.staticPages) {
      sitemaps.push({
        loc: `${baseUrl}/sitemap-static.xml`,
        lastmod: now,
      });
    }

    if (sitemapPolicy.categories) {
      sitemaps.push({
        loc: `${baseUrl}/sitemap-categories.xml`,
        lastmod: now,
      });
    }

    if (sitemapPolicy.collections) {
      sitemaps.push({
        loc: `${baseUrl}/sitemap-collections.xml`,
        lastmod: now,
      });
    }

    if (sitemapPolicy.pages) {
      sitemaps.push({
        loc: `${baseUrl}/sitemap-pages.xml`,
        lastmod: now,
      });
    }

    if (!sitemapPolicy.products) {
      const xml = generateSitemapIndex(sitemaps, baseUrl);
      return new Response(xml, {
        status: 200,
        headers: getSitemapHeaders(),
      });
    }

    // Fetch just 1 product to get the total count for pagination
    const productsResponse = await getAllProducts({ limit: 1 });
    if (!productsResponse) {
      return xmlDataUnavailableResponse('Sitemap index is temporarily unavailable');
    }
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

    const xml = generateSitemapIndex(sitemaps, baseUrl);

    return new Response(xml, {
      status: 200,
      headers: getSitemapHeaders(),
    });
  } catch (error: unknown) {
    console.error('Error generating sitemap index:', error);
    return xmlDataUnavailableResponse('Sitemap index is temporarily unavailable');
  }
};
