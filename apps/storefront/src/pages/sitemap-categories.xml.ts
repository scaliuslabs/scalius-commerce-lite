/**
 * Categories Sitemap
 * Contains all category pages
 */

import { generateSitemap, getSitemapHeaders } from '@/lib/sitemap-utils';
import type { SitemapUrl } from '@/lib/sitemap-utils';
import { getAllCategories } from '@/lib/api/categories';
import { getRuntimeStorefrontUrl } from '@/lib/runtime-env';
import type { APIContext, APIRoute } from 'astro';

export const prerender = false;

export const GET: APIRoute = async ({ locals }: APIContext) => {
  try {
    const baseUrl = getRuntimeStorefrontUrl(locals);
    const categories = await getAllCategories();

    if (!categories) {
      console.error('Failed to fetch categories for sitemap');
      return new Response('Failed to fetch categories', { status: 500 });
    }

    const categoryUrls: SitemapUrl[] = categories.map((category) => ({
      loc: `${baseUrl}/categories/${category.slug}`,
      lastmod: category.createdAt,
      changefreq: 'weekly' as const,
      priority: 0.8,
    }));

    const xml = generateSitemap(categoryUrls, baseUrl);

    return new Response(xml, {
      status: 200,
      headers: getSitemapHeaders(),
    });
  } catch (error) {
    console.error('Error generating categories sitemap:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
};
