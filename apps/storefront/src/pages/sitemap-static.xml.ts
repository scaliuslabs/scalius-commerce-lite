/**
 * Static Pages Sitemap
 * The homepage. Internal search results are noindexed and never listed.
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
