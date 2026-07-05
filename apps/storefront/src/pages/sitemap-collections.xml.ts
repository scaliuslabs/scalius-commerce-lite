/**
 * Collections Sitemap
 * Contains all active public collection pages
 */

import {
  generateSitemap,
  getSitemapHeaders,
  xmlDataUnavailableResponse,
} from '@/lib/sitemap-utils';
import type { SitemapUrl } from '@/lib/sitemap-utils';
import { getAllCollections } from '@/lib/api/collections';
import { getRuntimeStorefrontUrl } from '@/lib/api/runtime-env';
import type { APIContext, APIRoute } from 'astro';

export const prerender = false;

export const GET: APIRoute = async (_context: APIContext) => {
  try {
    const baseUrl = getRuntimeStorefrontUrl();
    const collections = await getAllCollections();

    if (!collections) {
      console.error('Failed to fetch collections for sitemap');
      return xmlDataUnavailableResponse('Collections sitemap is temporarily unavailable');
    }

    const collectionUrls: SitemapUrl[] = collections.map((collection) => ({
      loc: `${baseUrl}/collections/${encodeURIComponent(collection.id)}`,
      lastmod: collection.updatedAt ?? collection.createdAt ?? undefined,
      changefreq: 'weekly' as const,
      priority: 0.7,
    }));

    const xml = generateSitemap(collectionUrls, baseUrl);

    return new Response(xml, {
      status: 200,
      headers: getSitemapHeaders(),
    });
  } catch (error: unknown) {
    console.error('Error generating collections sitemap:', error);
    return xmlDataUnavailableResponse('Collections sitemap is temporarily unavailable');
  }
};
