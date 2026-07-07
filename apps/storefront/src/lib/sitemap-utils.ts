/**
 * Sitemap generation utilities
 * Following XML sitemap protocol: https://www.sitemaps.org/protocol.html
 */
import { getRuntimeStorefrontUrl } from "./api/runtime-env";
import { normalizeAbsoluteStorefrontOriginUrl } from "./storefront-origin";

export interface SitemapUrl {
  loc: string;
  lastmod?: string | number | Date;
}

export interface SitemapIndexEntry {
  loc: string;
  lastmod?: string | number | Date;
}

/**
 * Escapes XML special characters
 */
function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Formats a date to ISO 8601 format (W3C Datetime)
 */
function dateFromSitemapValue(date: string | number | Date): Date {
  if (date instanceof Date) return date;

  if (typeof date === 'number') {
    return new Date(date < 1_000_000_000_000 ? date * 1000 : date);
  }

  const trimmed = date.trim();
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    return new Date(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric);
  }

  return new Date(date);
}

export function formatDate(date: string | number | Date): string {
  const d = dateFromSitemapValue(date);
  if (Number.isNaN(d.getTime())) {
    throw new Error('Invalid sitemap date');
  }
  return d.toISOString();
}

/**
 * Generates a sitemap URL entry
 */
export function generateUrlEntry(url: SitemapUrl): string {
  let xml = '  <url>\n';
  xml += `    <loc>${escapeXml(url.loc)}</loc>\n`;

  if (url.lastmod) {
    xml += `    <lastmod>${formatDate(url.lastmod)}</lastmod>\n`;
  }

  xml += '  </url>\n';
  return xml;
}

/**
 * Generates a complete XML sitemap with XSL stylesheet for browser display
 */
export function generateSitemap(urls: SitemapUrl[], baseUrl?: string): string {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';

  // Add XSL stylesheet for pretty browser display (like Yoast SEO)
  if (baseUrl) {
    xml += `<?xml-stylesheet type="text/xsl" href="${baseUrl}/sitemap.xsl"?>\n`;
  }

  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

  for (const url of urls) {
    xml += generateUrlEntry(url);
  }

  xml += '</urlset>';
  return xml;
}

/**
 * Generates a sitemap index entry
 */
export function generateSitemapIndexEntry(entry: SitemapIndexEntry): string {
  let xml = '  <sitemap>\n';
  xml += `    <loc>${escapeXml(entry.loc)}</loc>\n`;

  if (entry.lastmod) {
    xml += `    <lastmod>${formatDate(entry.lastmod)}</lastmod>\n`;
  }

  xml += '  </sitemap>\n';
  return xml;
}

/**
 * Generates a complete sitemap index with XSL stylesheet for browser display
 */
export function generateSitemapIndex(sitemaps: SitemapIndexEntry[], baseUrl?: string): string {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';

  // Add XSL stylesheet for pretty browser display (like Yoast SEO)
  if (baseUrl) {
    xml += `<?xml-stylesheet type="text/xsl" href="${baseUrl}/sitemap.xsl"?>\n`;
  }

  xml += '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

  for (const sitemap of sitemaps) {
    xml += generateSitemapIndexEntry(sitemap);
  }

  xml += '</sitemapindex>';
  return xml;
}

/**
 * Gets the base URL from environment
 */
export function getBaseUrl(): string {
  const rawUrl = getRuntimeStorefrontUrl();
  if (!rawUrl.trim()) {
    throw new Error('STOREFRONT_URL environment variable is not set');
  }

  const normalized = normalizeAbsoluteStorefrontOriginUrl(rawUrl);
  if (!normalized) {
    throw new Error('STOREFRONT_URL must be an absolute http(s) origin URL');
  }

  return normalized;
}

/**
 * Generates cache headers for sitemaps
 */
export function getSitemapHeaders(): HeadersInit {
  return {
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
  };
}

export function xmlDataUnavailableResponse(
  message = 'Storefront catalog data is temporarily unavailable',
): Response {
  return new Response(message, {
    status: 503,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'private, no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Retry-After': '30',
    },
  });
}
