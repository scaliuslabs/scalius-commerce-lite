/**
 * Storefront media URL resolution.
 *
 * Wraps @scalius/shared's pure resolveMediaUrl with the storefront's
 * runtime CDN base resolution (SSR: middleware-set module store,
 * client: window.__CDN_DOMAIN__ injected by Layout.astro).
 */
import { resolveMediaUrl as sharedResolveMediaUrl } from "@scalius/shared/media-url";
import {
  getRuntimeCdnDomain,
  getRuntimeImageCdnAllowedHosts,
  getRuntimeImageCdnBaseUrl,
  getRuntimeImageCdnCanonicalHostAliases,
  getRuntimeImageOptimizationEnabled,
} from "./api/runtime-env";

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

function readWindowString(name: "__IMAGE_CDN_BASE_URL__"): string {
  if (typeof window === "undefined") return "";
  return (
    (window as typeof window & Record<typeof name, string | undefined>)[name] ||
    ""
  );
}

function readWindowStringArray(
  name: "__IMAGE_CDN_HOSTS__" | "__IMAGE_CDN_CANONICAL_HOST_ALIASES__",
): string[] {
  if (typeof window === "undefined") return [];
  const value = (window as typeof window & Record<typeof name, unknown>)[name];
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string")
    : [];
}

function readWindowBoolean(
  name: "__IMAGE_OPTIMIZATION_ENABLED__",
): boolean | undefined {
  if (typeof window === "undefined") return undefined;
  const value = (window as typeof window & Record<typeof name, unknown>)[name];
  return typeof value === "boolean" ? value : undefined;
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
  const policyBase = normalizeCdnDomain(getRuntimeImageCdnBaseUrl());
  if (policyBase) return `https://${policyBase}`;

  // SSR: runtime env from middleware
  if (import.meta.env.SSR) {
    const domain = normalizeCdnDomain(getRuntimeCdnDomain());
    if (domain) return `https://${domain.replace(/^https?:\/\//, "")}`;

    // Fallback: globalThis store set by middleware (survives across the isolate)
    const globalDomain = normalizeCdnDomain(readGlobalCdnDomain());
    if (globalDomain) return `https://${globalDomain}`;
  }

  // Client-side: injected by Layout.astro into window
  const windowPolicyBase = normalizeCdnDomain(
    readWindowString("__IMAGE_CDN_BASE_URL__"),
  );
  if (windowPolicyBase) return `https://${windowPolicyBase}`;

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
    getRuntimeImageCdnBaseUrl(),
    getRuntimeCdnDomain(),
    readGlobalCdnDomain(),
    readWindowString("__IMAGE_CDN_BASE_URL__"),
    readWindowCdnDomain(),
    ...getRuntimeImageCdnAllowedHosts(),
    ...readWindowStringArray("__IMAGE_CDN_HOSTS__"),
  ]) {
    const host = normalizeCdnDomain(source);
    if (host) hosts.add(host.toLowerCase());
  }
  return [...hosts];
}

export function getCdnCanonicalHostAliases(): string[] {
  const hosts = new Set<string>();
  for (const source of [
    ...getRuntimeImageCdnCanonicalHostAliases(),
    ...readWindowStringArray("__IMAGE_CDN_CANONICAL_HOST_ALIASES__"),
  ]) {
    const host = normalizeCdnDomain(source);
    if (host) hosts.add(host.toLowerCase());
  }
  return [...hosts];
}

export function getImageOptimizationEnabled(): boolean {
  return (
    getRuntimeImageOptimizationEnabled() ??
    readWindowBoolean("__IMAGE_OPTIMIZATION_ENABLED__") ??
    true
  );
}

/**
 * Resolve a media URL using the storefront's runtime CDN base.
 */
export function resolveMediaUrl(url: string | null | undefined): string {
  return sharedResolveMediaUrl(url, getCdnBase(), {
    cdnHostAliases: getCdnCanonicalHostAliases(),
  });
}
