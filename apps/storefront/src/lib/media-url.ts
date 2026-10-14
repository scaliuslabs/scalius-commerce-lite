/**
 * Storefront media URL resolution.
 *
 * Wraps @scalius/shared's pure resolveMediaUrl with the storefront's
 * runtime CDN base resolution (SSR: request-local runtime context,
 * client: window.__CDN_DOMAIN__ injected by Layout.astro), and picks
 * pre-generated renditions (see @scalius/shared/media-variants).
 */
import { resolveMediaUrl as sharedResolveMediaUrl } from "@scalius/shared/media-url";
import {
  mediaImageSrcSet as sharedMediaImageSrcSet,
  mediaImageUrl as sharedMediaImageUrl,
} from "@scalius/shared/media-variants";
import {
  getRuntimeCdnDomain,
  getRuntimeImageCdnBaseUrl,
  getRuntimeImageCdnCanonicalHostAliases,
  getRuntimeMediaUrl,
  getRuntimeStorefrontUrl,
} from "./api/runtime";

function normalizeCdnDomain(value: string | null | undefined): string {
  const raw = value?.trim();
  if (!raw) return "";
  return raw.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

const LOOPBACK_CDN_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i;

/**
 * CDN bases are configured as hosts. Production media is always HTTPS; only a
 * loopback host (local `pnpm dev` serving media from the API) keeps plain HTTP.
 */
function toCdnBaseUrl(domain: string): string {
  if (!domain) return "";
  return `${LOOPBACK_CDN_HOST.test(domain) ? "http" : "https"}://${domain}`;
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
  name: "__IMAGE_CDN_CANONICAL_HOST_ALIASES__",
): string[] {
  if (typeof window === "undefined") return [];
  const value = (window as typeof window & Record<typeof name, unknown>)[name];
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string")
    : [];
}

/**
 * Lazily resolve the CDN base URL (called per-use, not at module init).
 * Resolution order (SSR):
 * 1. dashboard media setting (canonical CDN) applied to the request context
 * 2. getRuntimeCdnDomain() — platform media host seeded by the middleware
 * Resolution order (Client):
 * 1. window.__IMAGE_CDN_BASE_URL__, 2. window.__CDN_DOMAIN__ — both injected
 *    by Layout.astro from the same request context.
 *
 * No build-time baking — .dev.vars and .env files do NOT affect this.
 */
export function getCdnBase(): string {
  const policyBase = normalizeCdnDomain(getRuntimeImageCdnBaseUrl());
  if (policyBase) return toCdnBaseUrl(policyBase);

  // SSR: platform media host from the request context
  if (import.meta.env.SSR) {
    const domain = normalizeCdnDomain(getRuntimeCdnDomain());
    if (domain) return toCdnBaseUrl(domain);
  }

  // Client-side: injected by Layout.astro into window
  const windowPolicyBase = normalizeCdnDomain(
    readWindowString("__IMAGE_CDN_BASE_URL__"),
  );
  if (windowPolicyBase) return toCdnBaseUrl(windowPolicyBase);

  return toCdnBaseUrl(normalizeCdnDomain(readWindowCdnDomain()));
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

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * The platform media address whose files the storefront serves on its own
 * origin (`/media/<key>`, lib/media-proxy.ts), so a page's images reuse the
 * connection that carried the page: the LCP image costs no second DNS lookup
 * or TLS handshake. Empty when they are not served that way: no platform
 * media address, a merchant-chosen canonical CDN (that choice stays), or a
 * media address already on the store's origin.
 *
 * SSR reads the request context; the browser reads `window.__MEDIA_SOURCE_URL__`
 * (written by Layout.astro only when this is active) and its own origin.
 */
export function getSameOriginMediaSource(): string {
  if (import.meta.env.SSR) {
    if (getRuntimeImageCdnBaseUrl()?.trim()) return "";
    const source = trimTrailingSlashes(getRuntimeMediaUrl()?.trim() ?? "");
    const storefront = getRuntimeStorefrontUrl();
    if (!source || !storefront) return "";
    try {
      return new URL(source).origin === new URL(storefront).origin ? "" : source;
    } catch {
      return "";
    }
  }
  if (typeof window === "undefined") return "";
  return trimTrailingSlashes(
    (window as typeof window & { __MEDIA_SOURCE_URL__?: string }).__MEDIA_SOURCE_URL__ ?? "",
  );
}

/** The origin the storefront serves its own media from. */
function sameOriginMediaTarget(): string {
  if (import.meta.env.SSR) return getRuntimeStorefrontUrl();
  return typeof window === "undefined" ? "" : window.location.origin;
}

/**
 * `url` on the store's own origin when it is a file of the platform media
 * address (`<media address>/media/<key>` becomes `<store origin>/media/<key>`;
 * query and fragment kept); any other URL is returned unchanged. The result
 * is absolute, so social tags, JSON-LD and feeds stay valid.
 */
function mediaUrlOnStoreOrigin(url: string): string {
  if (!url) return url;
  const source = getSameOriginMediaSource();
  if (!source || !url.startsWith(`${source}/media/`)) return url;
  const target = trimTrailingSlashes(sameOriginMediaTarget());
  return target ? `${target}/${url.slice(source.length + 1)}` : url;
}

/**
 * Resolve a media URL using the storefront's runtime CDN base, then serve it
 * from the store's own origin (see `getSameOriginMediaSource`).
 */
export function resolveMediaUrl(url: string | null | undefined): string {
  return mediaUrlOnStoreOrigin(
    sharedResolveMediaUrl(url, getCdnBase(), {
      cdnHostAliases: getCdnCanonicalHostAliases(),
    }),
  );
}

/**
 * The smallest pre-generated rendition at least `width` px wide. Images
 * without renditions (legacy uploads, SVG, external URLs) are served as-is.
 */
export function mediaImageUrl(
  url: string | null | undefined,
  width: number,
): string {
  const resolved = resolveMediaUrl(url);
  return resolved ? sharedMediaImageUrl(resolved, width) : "";
}

/** `srcset` over every rendition; undefined when the image has none. */
export function mediaImageSrcSet(
  url: string | null | undefined,
): string | undefined {
  return sharedMediaImageSrcSet(resolveMediaUrl(url)) || undefined;
}
