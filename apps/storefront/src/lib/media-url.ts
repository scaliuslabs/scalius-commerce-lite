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
 * Resolution order (SSR):
 * 1. getRuntimeCdnDomain() — module-level store set by middleware
 * 2. globalThis.__SCALIUS_CDN_DOMAIN__ — fallback set by middleware
 * Resolution order (Client):
 * 3. window.__CDN_DOMAIN__ — injected by Layout.astro
 *
 * All values come from Cloudflare Worker runtime env (wrangler.jsonc vars).
 * No build-time baking — .dev.vars and .env files do NOT affect this.
 */
function getCdnBase(): string {
  // SSR: runtime env from middleware
  if (import.meta.env.SSR) {
    const domain = getRuntimeCdnDomain();
    if (domain) return `https://${domain.replace(/^https?:\/\//, '')}`;

    // Fallback: globalThis store set by middleware (survives across the isolate)
    const globalDomain = (globalThis as any).__SCALIUS_CDN_DOMAIN__ as string | undefined;
    if (globalDomain) return `https://${globalDomain.replace(/^https?:\/\//, '')}`;
  }

  // Client-side: injected by Layout.astro into window
  if (typeof window !== 'undefined' && (window as any).__CDN_DOMAIN__) {
    const d = (window as any).__CDN_DOMAIN__;
    return d.startsWith('http') ? d : `https://${d}`;
  }

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

