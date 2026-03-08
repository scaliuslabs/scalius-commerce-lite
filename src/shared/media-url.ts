/**
 * Resolves any media URL to a full, absolute CDN URL.
 *
 * Handles bare R2 object keys (e.g. "abc123.jpg") that were stored in the
 * database before R2_PUBLIC_URL was configured, as well as already-complete
 * URLs and local/CDN-optimized paths.
 */
/**
 * CDN base URL resolved from env vars (R2_PUBLIC_URL or CDN_DOMAIN_URL).
 * In SSR (Hono Worker), these are available via import.meta.env.
 * Falls back to empty string which keeps bare keys as-is.
 */
function resolveCdnBase(): string {
  const r2Url = import.meta.env?.R2_PUBLIC_URL;
  if (r2Url) return r2Url.replace(/\/$/, '');

  const cdnDomain = import.meta.env?.CDN_DOMAIN_URL;
  if (cdnDomain) {
    const d = cdnDomain.replace(/^https?:\/\//, '');
    return `https://${d}`;
  }

  return '';
}

const CDN_BASE = resolveCdnBase();

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
