/**
 * Pages sitemap: the published CMS pages and the live theme's landing pages
 * (`/pages/<slug>`), each unless it is hidden from search engines or left
 * out of the sitemap. Landing pages carry no lastmod: nothing records when
 * one alone last changed.
 */

import {
  generateSitemap,
  getBaseUrl,
  getSitemapHeaders,
  xmlDataUnavailableResponse,
  sitemapPageUrl,
} from '@/lib/sitemap-utils';
import type { SitemapUrl } from '@/lib/sitemap-utils';
import { getAllPages } from '@/lib/api/pages';
import { getLayoutData } from '@/lib/api/storefront';
import { readStorefrontTheme } from '@/lib/storefront-theme-context';
import type { Page } from '@/lib/api/types';
import type { APIContext, APIRoute } from 'astro';
import { normalizeResourceCanonicalPath } from '@scalius/shared/seo-canonical';

export const prerender = false;

export const GET: APIRoute = async (_context: APIContext) => {
  try {
    const baseUrl = getBaseUrl();

    // The live theme (the layout read) names the landing pages.
    const layoutPromise = getLayoutData();
    const allPages: Page[] = [];
    let currentPage = 1;
    let hasMore = true;

    // Fetch all pages with pagination
    while (hasMore) {
      const response = await getAllPages({
        page: currentPage,
        limit: 100,
      });

      if (!response || !response.data) {
        return xmlDataUnavailableResponse('Pages sitemap is temporarily unavailable');
      }

      if (response.data.length === 0) {
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

    const layout = await layoutPromise;
    if (!layout) {
      return xmlDataUnavailableResponse('Pages sitemap is temporarily unavailable');
    }
    const landingUrls: SitemapUrl[] = Object.entries(readStorefrontTheme(layout.theme).pages.landing)
      .filter(([, landing]) => !landing.noIndex && !landing.excludeFromSitemap)
      .map(([slug]) => ({ loc: sitemapPageUrl(baseUrl, `/pages/${slug}`) }));

    const pageUrls: SitemapUrl[] = [
      ...allPages
        .filter((page) => page.isPublished && page.slug && !page.noIndex && !page.excludeFromSitemap)
        .map((page) => ({
          loc: sitemapPageUrl(baseUrl, normalizeResourceCanonicalPath('page', page.canonicalPath) ?? `/${page.slug}`),
          lastmod: page.updatedAt ?? undefined,
        })),
      ...landingUrls,
    ];

    const xml = generateSitemap(pageUrls, baseUrl);

    return new Response(xml, {
      status: 200,
      headers: getSitemapHeaders(),
    });
  } catch (error: unknown) {
    console.error('Error generating pages sitemap:', error);
    return xmlDataUnavailableResponse('Pages sitemap is temporarily unavailable');
  }
};
