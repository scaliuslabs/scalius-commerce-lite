/**
 * Sitemap generation utilities
 * Following XML sitemap protocol: https://www.sitemaps.org/protocol.html
 */
import { getRuntimeStorefrontUrl } from "./api/runtime-env";

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
  changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
  priority?: number;
}

export interface SitemapIndexEntry {
  loc: string;
  lastmod?: string;
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
export function formatDate(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
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

  if (url.changefreq) {
    xml += `    <changefreq>${url.changefreq}</changefreq>\n`;
  }

  if (url.priority !== undefined) {
    xml += `    <priority>${url.priority.toFixed(1)}</priority>\n`;
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
  const url = getRuntimeStorefrontUrl() || import.meta.env.STOREFRONT_URL;
  if (!url) {
    throw new Error('STOREFRONT_URL environment variable is not set');
  }
  // Remove trailing slash if present
  return url.replace(/\/$/, '');
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
