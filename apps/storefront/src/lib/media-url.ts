/**
 * Storefront media URL resolution.
 *
 * Wraps @scalius/shared's pure resolveMediaUrl with the storefront's
 * runtime CDN base resolution (SSR: middleware-set module store,
 * client: window.__CDN_DOMAIN__ injected by Layout.astro).
 */
import { resolveMediaUrl as sharedResolveMediaUrl } from "@scalius/shared/media-url";
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
export function getCdnBase(): string {
  // SSR: runtime env from middleware
  if (import.meta.env.SSR) {
    const domain = getRuntimeCdnDomain();
    if (domain) return `https://${domain.replace(/^https?:\/\//, "")}`;

    // Fallback: globalThis store set by middleware (survives across the isolate)
    if (__SCALIUS_CDN_DOMAIN__)
      return `https://${__SCALIUS_CDN_DOMAIN__.replace(/^https?:\/\//, "")}`;
  }

  // Client-side: injected by Layout.astro into window
  if (typeof window !== "undefined" && window.__CDN_DOMAIN__) {
    const d = window.__CDN_DOMAIN__;
    return d.startsWith("http") ? d : `https://${d}`;
  }

  return "";
}

/**
 * Resolve a media URL using the storefront's runtime CDN base.
 */
export function resolveMediaUrl(url: string | null | undefined): string {
  return sharedResolveMediaUrl(url, getCdnBase());
}
