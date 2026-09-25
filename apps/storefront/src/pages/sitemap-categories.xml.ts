/**
 * Categories Sitemap
 * Published category pages; the API leaves out noIndex and excludeFromSitemap
 * categories before its limit and dates each page by its own last change.
 */

import {
  generateSitemap,
  getBaseUrl,
  getSitemapHeaders,
  xmlDataUnavailableResponse,
} from '@/lib/sitemap-utils';
import type { SitemapUrl } from '@/lib/sitemap-utils';
import { getSitemapCategories } from '@/lib/api/categories';
import type { APIContext, APIRoute } from 'astro';
import { normalizeResourceCanonicalPath } from '@scalius/shared/seo-canonical';

export const prerender = false;

export const GET: APIRoute = async (_context: APIContext) => {
  try {
    const baseUrl = getBaseUrl();

    const categories = await getSitemapCategories();

    if (!categories) {
      console.error('Failed to fetch categories for sitemap');
      return xmlDataUnavailableResponse('Category sitemap is temporarily unavailable');
    }

    const categoryUrls: SitemapUrl[] = categories.map((category) => ({
      loc: `${baseUrl}${normalizeResourceCanonicalPath('category', category.canonicalPath) ?? `/categories/${category.slug}`}`,
      lastmod: category.updatedAt ?? undefined,
    }));

    const xml = generateSitemap(categoryUrls, baseUrl);

    return new Response(xml, {
      status: 200,
      headers: getSitemapHeaders(),
    });
  } catch (error: unknown) {
    console.error('Error generating categories sitemap:', error);
    return xmlDataUnavailableResponse('Category sitemap is temporarily unavailable');
  }
};
