/**
 * Resolves any media URL to a full, absolute CDN URL.
 *
 * Handles bare R2 object keys (e.g. "abc123.jpg") that were stored in the
 * database before R2_PUBLIC_URL was configured, as well as already-complete
 * URLs and local/CDN-optimized paths.
 *
 * This is a PURE function — it accepts cdnBase as a parameter rather than
 * reading environment variables directly. Each app is responsible for
 * resolving cdnBase from its own runtime environment and passing it in.
 */

/**
 * Resolve a media URL to a full, absolute CDN URL.
 *
 * @param url - The original image URL or bare R2 object key
 * @param cdnBase - The CDN base URL (e.g. "https://cloud.scalius.com"). When
 *   empty/undefined, bare R2 keys are returned as-is.
 * @returns Resolved absolute URL, or empty string for null/undefined/empty input
 */
export function resolveMediaUrl(url: string | null | undefined, cdnBase?: string): string {
  if (!url || url.trim() === "") return "";

  // Already a full absolute URL — return as-is
  if (url.startsWith("http://") || url.startsWith("https://")) return url;

  // Already a Cloudflare-optimized path
  if (url.startsWith("/cdn-cgi/")) return url;

  // Local asset path (e.g. /img/no-image.webp)
  if (url.startsWith("/")) return url;

  // Bare R2 object key — prepend CDN base
  const base = cdnBase?.replace(/\/$/, "");
  return base ? `${base}/${url}` : url;
}
