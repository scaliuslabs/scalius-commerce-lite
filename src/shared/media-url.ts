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

  let resolvedUrl = url;

  // Determine if we are in development mode
  const isDevelopment =
    import.meta.env?.MODE === "development" ||
    import.meta.env?.DEV === true ||
    (typeof window !== "undefined" &&
      (window.location.hostname === "localhost" ||
        window.location.hostname === "127.0.0.1" ||
        window.location.hostname.startsWith("192.168.") ||
        window.location.hostname.includes("local"))) ||
    (typeof process !== "undefined" && process.env.NODE_ENV === "development");

  // Rewrite ANY URL (absolute or relative) containing the old /media/ path to /api/v1/media/ in dev
  if (isDevelopment && resolvedUrl.includes("/media/") && !resolvedUrl.includes("/api/v1/media/")) {
    resolvedUrl = resolvedUrl.replace("/media/", "/api/v1/media/");
  }

  // Already a full absolute URL — return as-is
  if (resolvedUrl.startsWith("http://") || resolvedUrl.startsWith("https://")) return resolvedUrl;

  // Already a Cloudflare-optimized path
  if (resolvedUrl.startsWith("/cdn-cgi/")) return resolvedUrl;

  // Local asset path (e.g. /img/no-image.webp)
  if (resolvedUrl.startsWith("/")) {
    return resolvedUrl;
  }

  // Bare R2 object key — prepend CDN base
  // In development, return the local api media URL for bare keys
  if (isDevelopment) {
    return `/api/v1/media/${resolvedUrl}`;
  }

  return `${CDN_BASE}/${resolvedUrl}`;
}
