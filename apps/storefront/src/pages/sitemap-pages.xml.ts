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
import { getSitemapContent } from '@/lib/api/content-sitemap';
import { getLayoutData } from '@/lib/api/storefront';
import { readStorefrontThemeDocument } from '@/lib/storefront-theme-context';
import type { APIContext, APIRoute } from 'astro';
import { normalizeResourceCanonicalPath } from '@scalius/shared/seo-canonical';
import { STOREFRONT_ROUTE_SEGMENTS } from '@scalius/shared/storefront-route-segments';
import { parseSitemapPage, SITEMAP_PAGE_SIZE } from '@scalius/shared/sitemap-pagination';

export const prerender = false;

/**
 * One document of up to 5,000 CMS pages (`?page=N`, every page listed by
 * the index); the first also lists the live theme's landing pages.
 */
export const GET: APIRoute = async ({ url }: APIContext) => {
  const page = parseSitemapPage(url.searchParams.get('page'));
  if (page === null) return new Response('Invalid page parameter', { status: 400 });
  try {
    const baseUrl = getBaseUrl();
    // The live theme (the layout read) names the landing pages, on the first document.
    const layoutPromise = page === 1 ? getLayoutData() : null;
    const response = await getSitemapContent('pages', { page, limit: SITEMAP_PAGE_SIZE });
    if (!response) {
      return xmlDataUnavailableResponse('Pages sitemap is temporarily unavailable');
    }
    if (page > 1 && response.data.length === 0) return new Response('Page not found', { status: 404 });

    let landingUrls: SitemapUrl[] = [];
    if (layoutPromise) {
      const layout = await layoutPromise;
      if (!layout) {
        return xmlDataUnavailableResponse('Pages sitemap is temporarily unavailable');
      }
      // An unreadable theme would drop every landing page: fail closed, uncached.
      const themeRead = readStorefrontThemeDocument(layout.theme);
      if (themeRead.degraded) {
        return xmlDataUnavailableResponse('Pages sitemap is temporarily unavailable');
      }
      landingUrls = Object.entries(themeRead.theme.pages.landing)
        .filter(([, landing]) => !landing.noIndex && !landing.excludeFromSitemap)
        .map(([slug]) => ({ loc: sitemapPageUrl(baseUrl, `/pages/${slug}`) }));
    }

    const pageUrls: SitemapUrl[] = [
      ...response.data
        // A page saved on a storefront route's address is not served there (the route answers), so it is not listed.
        .filter((entry) => entry.slug && !STOREFRONT_ROUTE_SEGMENTS.has(entry.slug))
        .map((entry) => ({
          loc: sitemapPageUrl(baseUrl, normalizeResourceCanonicalPath('page', entry.canonicalPath) ?? `/${entry.slug}`),
          lastmod: entry.updatedAt ?? undefined,
        })),
      ...landingUrls,
    ];

    return new Response(generateSitemap(pageUrls), {
      status: 200,
      headers: getSitemapHeaders(),
    });
  } catch (error: unknown) {
    console.error('Error generating pages sitemap:', error);
    return xmlDataUnavailableResponse('Pages sitemap is temporarily unavailable');
  }
};
