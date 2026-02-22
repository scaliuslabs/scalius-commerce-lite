/**
 * Resolves any media URL to a full, absolute CDN URL.
 *
 * Handles bare R2 object keys (e.g. "abc123.jpg") that were stored in the
 * database before R2_PUBLIC_URL was configured, as well as already-complete
 * URLs and local/CDN-optimized paths.
 */

const CDN_BASE = "https://cloud.wrygo.com";

export function resolveMediaUrl(url: string | null | undefined): string {
  if (!url || url.trim() === "") return "";

  // Already a full absolute URL — return as-is
  if (url.startsWith("http://") || url.startsWith("https://")) return url;

  // Already a Cloudflare-optimized path
  if (url.startsWith("/cdn-cgi/")) return url;

  // Local asset path (e.g. /img/no-image.webp)
  if (url.startsWith("/")) return url;

  // Bare R2 object key — prepend CDN base
  return `${CDN_BASE}/${url}`;
}
