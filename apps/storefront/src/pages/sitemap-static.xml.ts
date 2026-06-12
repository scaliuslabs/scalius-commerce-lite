/**
 * Static Pages Sitemap
 * Contains crawlable static URLs like homepage and search.
 */

import { generateSitemap, getSitemapHeaders } from '@/lib/sitemap-utils';
import type { SitemapUrl } from '@/lib/sitemap-utils';
import { getRuntimeStorefrontUrl } from '@/lib/api/runtime-env';
import type { APIContext, APIRoute } from 'astro';

export const prerender = false;

export const GET: APIRoute = async (_context: APIContext) => {
  try {
    const baseUrl = getRuntimeStorefrontUrl();

    const staticPages: SitemapUrl[] = [
      {
        loc: `${baseUrl}/`,
        changefreq: 'daily',
        priority: 1.0,
      },
      {
        loc: `${baseUrl}/search`,
        changefreq: 'weekly',
        priority: 0.8,
      },
    ];

    const xml = generateSitemap(staticPages, baseUrl);

    return new Response(xml, {
      status: 200,
      headers: getSitemapHeaders(),
    });
  } catch (error: unknown) {
    console.error('Error generating static sitemap:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
};
