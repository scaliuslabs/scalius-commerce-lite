/**
 * CMS Pages Sitemap
 * Contains all published CMS pages
 */

import {
  generateSitemap,
  getBaseUrl,
  getSitemapHeaders,
  xmlDataUnavailableResponse,
} from '@/lib/sitemap-utils';
import type { SitemapUrl } from '@/lib/sitemap-utils';
import { getSeoSettings } from '@/lib/api';
import { getAllPages } from '@/lib/api/pages';
import type { Page } from '@/lib/api/types';
import type { APIContext, APIRoute } from 'astro';
import { normalizeCanonicalPath } from '@scalius/shared/seo-canonical';
import { normalizeSeoDiscoverySettings } from '@scalius/shared/seo-discovery';

export const prerender = false;

export const GET: APIRoute = async (_context: APIContext) => {
  try {
    const baseUrl = getBaseUrl();
    const seo = await getSeoSettings();
    if (!seo) {
      return xmlDataUnavailableResponse('Pages sitemap is temporarily unavailable');
    }
    const sitemapPolicy = normalizeSeoDiscoverySettings(seo.discovery).sitemap;
    if (!sitemapPolicy.enabled || !sitemapPolicy.pages) {
      return new Response(generateSitemap([], baseUrl), {
        status: 200,
        headers: getSitemapHeaders(),
      });
    }

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
      .filter((page) => page.isPublished && page.slug && !page.noIndex && !page.excludeFromSitemap)
      .map((page) => ({
        loc: `${baseUrl}${normalizeCanonicalPath(page.canonicalPath) ?? `/${page.slug}`}`,
        lastmod: page.publishedAt ?? page.updatedAt,
      }));

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
