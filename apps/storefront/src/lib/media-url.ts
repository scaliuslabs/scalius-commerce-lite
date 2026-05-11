/**
 * Storefront media URL resolution.
 *
 * Wraps @scalius/shared's pure resolveMediaUrl with the storefront's
 * runtime CDN base resolution (SSR: middleware-set module store,
 * client: window.__CDN_DOMAIN__ injected by Layout.astro).
 */
import { resolveMediaUrl as sharedResolveMediaUrl } from "@scalius/shared/media-url";
import { getRuntimeCdnDomain } from "./api/runtime-env";

function normalizeCdnDomain(value: string | null | undefined): string {
  const raw = value?.trim();
  if (!raw) return "";
  return raw.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function readGlobalCdnDomain(): string {
  return (
    (globalThis as typeof globalThis & { __SCALIUS_CDN_DOMAIN__?: string })
      .__SCALIUS_CDN_DOMAIN__ || ""
  );
}

function readWindowCdnDomain(): string {
  if (typeof window === "undefined") return "";
  return (
    (window as typeof window & { __CDN_DOMAIN__?: string }).__CDN_DOMAIN__ || ""
  );
}

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
    const domain = normalizeCdnDomain(getRuntimeCdnDomain());
    if (domain) return `https://${domain.replace(/^https?:\/\//, "")}`;

    // Fallback: globalThis store set by middleware (survives across the isolate)
    const globalDomain = normalizeCdnDomain(readGlobalCdnDomain());
    if (globalDomain) return `https://${globalDomain}`;
  }

  // Client-side: injected by Layout.astro into window
  const windowDomain = normalizeCdnDomain(readWindowCdnDomain());
  if (windowDomain) return `https://${windowDomain}`;

  return "";
}

/**
 * Return configured CDN hostnames that are eligible for Cloudflare Image Resizing.
 */
export function getCdnHosts(): string[] {
  const hosts = new Set<string>();
  for (const source of [
    getRuntimeCdnDomain(),
    readGlobalCdnDomain(),
    readWindowCdnDomain(),
  ]) {
    const host = normalizeCdnDomain(source);
    if (host) hosts.add(host.toLowerCase());
  }
  return [...hosts];
}

/**
 * Resolve a media URL using the storefront's runtime CDN base.
 */
export function resolveMediaUrl(url: string | null | undefined): string {
  return sharedResolveMediaUrl(url, getCdnBase());
}
