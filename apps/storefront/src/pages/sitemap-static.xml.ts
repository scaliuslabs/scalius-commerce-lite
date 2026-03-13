/**
 * Static Pages Sitemap
 * Contains static URLs like homepage, search, cart, etc.
 */

import { generateSitemap, getSitemapHeaders } from '@/lib/sitemap-utils';
import type { SitemapUrl } from '@/lib/sitemap-utils';
import { getRuntimeStorefrontUrl } from '@/lib/runtime-env';
import type { APIContext, APIRoute } from 'astro';

export const prerender = false;

export const GET: APIRoute = async ({ locals }: APIContext) => {
  try {
    const baseUrl = getRuntimeStorefrontUrl(locals);

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
      {
        loc: `${baseUrl}/cart`,
        changefreq: 'weekly',
        priority: 0.3,
      },
    ];

    const xml = generateSitemap(staticPages, baseUrl);

    return new Response(xml, {
      status: 200,
      headers: getSitemapHeaders(),
    });
  } catch (error) {
    console.error('Error generating static sitemap:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
};
