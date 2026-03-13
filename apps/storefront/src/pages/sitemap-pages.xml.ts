/**
 * CMS Pages Sitemap
 * Contains all published CMS pages
 */

import { generateSitemap, getSitemapHeaders } from '@/lib/sitemap-utils';
import type { SitemapUrl } from '@/lib/sitemap-utils';
import { getAllPages } from '@/lib/api/pages';
import type { Page } from '@/lib/api/types';
import { getRuntimeStorefrontUrl } from '@/lib/runtime-env';
import type { APIContext, APIRoute } from 'astro';

export const prerender = false;

export const GET: APIRoute = async ({ locals }: APIContext) => {
  try {
    const baseUrl = getRuntimeStorefrontUrl(locals);
    const allPages: Page[] = [];
    let currentPage = 1;
    let hasMore = true;

    // Fetch all pages with pagination
    while (hasMore) {
      const response = await getAllPages({
        page: currentPage,
        limit: 100,
        publishedOnly: true,
      });

      if (!response || !response.data || response.data.length === 0) {
        hasMore = false;
        break;
      }

      allPages.push(...response.data);

      // Check if there are more pages
      if (response.pagination.page >= response.pagination.totalPages) {
        hasMore = false;
      } else {
        currentPage++;
      }
    }

    if (allPages.length === 0) {
      console.log('No published pages found for sitemap');
      // Return empty sitemap instead of error
      const xml = generateSitemap([], baseUrl);
      return new Response(xml, {
        status: 200,
        headers: getSitemapHeaders(),
      });
    }

    const pageUrls: SitemapUrl[] = allPages
      .filter((page) => page.isPublished && page.slug) // Extra safety check
      .map((page) => ({
        loc: `${baseUrl}/${page.slug}`,
        lastmod: page.publishedAt
          ? new Date(page.publishedAt).toISOString()
          : new Date(page.updatedAt).toISOString(),
        changefreq: 'monthly' as const,
        priority: 0.6,
      }));

    const xml = generateSitemap(pageUrls, baseUrl);

    return new Response(xml, {
      status: 200,
      headers: getSitemapHeaders(),
    });
  } catch (error) {
    console.error('Error generating pages sitemap:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
};
