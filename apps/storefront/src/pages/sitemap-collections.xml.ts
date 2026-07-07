/**
 * Collections Sitemap
 * Contains all active public collection pages
 */

import {
  generateSitemap,
  getBaseUrl,
  getSitemapHeaders,
  xmlDataUnavailableResponse,
} from '@/lib/sitemap-utils';
import type { SitemapUrl } from '@/lib/sitemap-utils';
import { getSeoSettings } from '@/lib/api';
import { getAllCollections } from '@/lib/api/collections';
import type { APIContext, APIRoute } from 'astro';
import { normalizeResourceCanonicalPath } from '@scalius/shared/seo-canonical';
import { normalizeSeoDiscoverySettings } from '@scalius/shared/seo-discovery';

export const prerender = false;

export const GET: APIRoute = async (_context: APIContext) => {
  try {
    const baseUrl = getBaseUrl();
    const seo = await getSeoSettings();
    if (!seo) {
      return xmlDataUnavailableResponse('Collections sitemap is temporarily unavailable');
    }
    const sitemapPolicy = normalizeSeoDiscoverySettings(seo.discovery).sitemap;
    if (!sitemapPolicy.enabled || !sitemapPolicy.collections) {
      return new Response(generateSitemap([], baseUrl), {
        status: 200,
        headers: getSitemapHeaders(),
      });
    }

    const collections = await getAllCollections();

    if (!collections) {
      console.error('Failed to fetch collections for sitemap');
      return xmlDataUnavailableResponse('Collections sitemap is temporarily unavailable');
    }

    const collectionUrls: SitemapUrl[] = collections
      .filter((collection) => !collection.noIndex && !collection.excludeFromSitemap)
      .map((collection) => ({
        loc: `${baseUrl}${normalizeResourceCanonicalPath('collection', collection.canonicalPath) ?? `/collections/${encodeURIComponent(collection.id)}`}`,
        lastmod: collection.updatedAt ?? collection.createdAt ?? undefined,
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
