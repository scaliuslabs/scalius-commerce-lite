/**
 * Collections Sitemap
 * Active collection pages; the API leaves out noIndex and excludeFromSitemap
 * collections before its limit and dates each page by its own last change.
 */

import {
  generateSitemap,
  getBaseUrl,
  getSitemapHeaders,
  xmlDataUnavailableResponse,
} from '@/lib/sitemap-utils';
import type { SitemapUrl } from '@/lib/sitemap-utils';
import { getSitemapCollections } from '@/lib/api/collections';
import type { APIContext, APIRoute } from 'astro';
import { normalizeResourceCanonicalPath } from '@scalius/shared/seo-canonical';

export const prerender = false;

export const GET: APIRoute = async (_context: APIContext) => {
  try {
    const baseUrl = getBaseUrl();

    const collections = await getSitemapCollections();

    if (!collections) {
      console.error('Failed to fetch collections for sitemap');
      return xmlDataUnavailableResponse('Collections sitemap is temporarily unavailable');
    }

    const collectionUrls: SitemapUrl[] = collections.map((collection) => ({
      loc: `${baseUrl}${normalizeResourceCanonicalPath('collection', collection.canonicalPath) ?? `/collections/${encodeURIComponent(collection.id)}`}`,
      lastmod: collection.updatedAt ?? undefined,
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
