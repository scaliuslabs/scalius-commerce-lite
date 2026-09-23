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
import type { APIContext, APIRoute } from 'astro';

export const prerender = false;

export const GET: APIRoute = async (_context: APIContext) => {
  try {
    const baseUrl = getBaseUrl();

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
