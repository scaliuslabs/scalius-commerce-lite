/**
 * Resolves any media URL to a full, absolute CDN URL.
 *
 * Handles bare R2 object keys (e.g. "abc123.jpg") that were stored in the
 * database before R2_PUBLIC_URL was configured, as well as already-complete
 * URLs and local/CDN-optimized paths.
 */
import { getRuntimeCdnDomain } from "./api/runtime-env";

/**
 * Lazily resolve the CDN base URL (called per-use, not at module init).
 * Resolution order:
 * 1. SSR runtime: getRuntimeCdnDomain() from middleware-set store (wrangler.jsonc vars)
 * 2. Client-side: window.__CDN_DOMAIN__ injected by Layout.astro
 * 3. Build-time: import.meta.env.CDN_DOMAIN_URL (from .env if present)
 */
function getCdnBase(): string {
  // SSR: runtime env from middleware
  if (import.meta.env.SSR) {
    const domain = getRuntimeCdnDomain();
    if (domain) return `https://${domain.replace(/^https?:\/\//, '')}`;
  }

  // Client-side: injected by Layout.astro into window
  if (typeof window !== 'undefined' && (window as any).__CDN_DOMAIN__) {
    const d = (window as any).__CDN_DOMAIN__;
    return d.startsWith('http') ? d : `https://${d}`;
  }

  // Build-time fallback (from .env if present)
  const envDomain = import.meta.env.CDN_DOMAIN_URL;
  if (envDomain) return `https://${envDomain.replace(/^https?:\/\//, '')}`;

  return '';
}

export function resolveMediaUrl(url: string | null | undefined): string {
  if (!url || url.trim() === "") return "";

  // Already a full absolute URL — return as-is
  if (url.startsWith("http://") || url.startsWith("https://")) return url;

  // Already a Cloudflare-optimized path
  if (url.startsWith("/cdn-cgi/")) return url;

  // Local asset path (e.g. /img/no-image.webp)
  if (url.startsWith("/")) return url;

  // Bare R2 object key — prepend CDN base
  const base = getCdnBase();
  return base ? `${base}/${url}` : url;
}

