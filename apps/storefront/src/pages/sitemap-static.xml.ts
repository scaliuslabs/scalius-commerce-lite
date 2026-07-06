/**
 * Static Pages Sitemap
 * Contains crawlable static URLs like homepage and search.
 */

import {
  generateSitemap,
  getBaseUrl,
  getSitemapHeaders,
  xmlDataUnavailableResponse,
} from '@/lib/sitemap-utils';
import type { SitemapUrl } from '@/lib/sitemap-utils';
import { getSeoSettings } from '@/lib/api';
import type { APIContext, APIRoute } from 'astro';
import { normalizeSeoDiscoverySettings } from '@scalius/shared/seo-discovery';

export const prerender = false;

export const GET: APIRoute = async (_context: APIContext) => {
  try {
    const baseUrl = getBaseUrl();
    const seo = await getSeoSettings();
    if (!seo) {
      return xmlDataUnavailableResponse('Static sitemap is temporarily unavailable');
    }
    const sitemapPolicy = normalizeSeoDiscoverySettings(seo.discovery).sitemap;
    if (!sitemapPolicy.enabled || !sitemapPolicy.staticPages) {
      return new Response(generateSitemap([], baseUrl), {
        status: 200,
        headers: getSitemapHeaders(),
      });
    }

    const staticPages: SitemapUrl[] = [
      {
        loc: `${baseUrl}/`,
      },
      {
        loc: `${baseUrl}/search`,
      },
    ];

    const xml = generateSitemap(staticPages, baseUrl);

    return new Response(xml, {
      status: 200,
      headers: getSitemapHeaders(),
    });
  } catch (error: unknown) {
    console.error('Error generating static sitemap:', error);
    return xmlDataUnavailableResponse('Static sitemap is temporarily unavailable');
  }
};
