/**
 * Categories Sitemap
 * Contains all category pages
 */

import {
  generateSitemap,
  getSitemapHeaders,
  xmlDataUnavailableResponse,
} from '@/lib/sitemap-utils';
import type { SitemapUrl } from '@/lib/sitemap-utils';
import { getSeoSettings } from '@/lib/api';
import { getAllCategories } from '@/lib/api/categories';
import { getRuntimeStorefrontUrl } from '@/lib/api/runtime-env';
import type { APIContext, APIRoute } from 'astro';
import { normalizeSeoDiscoverySettings } from '@scalius/shared/seo-discovery';

export const prerender = false;

export const GET: APIRoute = async (_context: APIContext) => {
  try {
    const baseUrl = getRuntimeStorefrontUrl();
    const seo = await getSeoSettings();
    if (!seo) {
      return xmlDataUnavailableResponse('Category sitemap is temporarily unavailable');
    }
    const sitemapPolicy = normalizeSeoDiscoverySettings(seo.discovery).sitemap;
    if (!sitemapPolicy.enabled || !sitemapPolicy.categories) {
      return new Response(generateSitemap([], baseUrl), {
        status: 200,
        headers: getSitemapHeaders(),
      });
    }

    const categories = await getAllCategories();

    if (!categories) {
      console.error('Failed to fetch categories for sitemap');
      return xmlDataUnavailableResponse('Category sitemap is temporarily unavailable');
    }

    const categoryUrls: SitemapUrl[] = categories.map((category) => ({
      loc: `${baseUrl}/categories/${category.slug}`,
      lastmod: category.updatedAt ?? category.createdAt ?? undefined,
      changefreq: 'weekly' as const,
      priority: 0.8,
    }));

    const xml = generateSitemap(categoryUrls, baseUrl);

    return new Response(xml, {
      status: 200,
      headers: getSitemapHeaders(),
    });
  } catch (error: unknown) {
    console.error('Error generating categories sitemap:', error);
    return xmlDataUnavailableResponse('Category sitemap is temporarily unavailable');
  }
};
