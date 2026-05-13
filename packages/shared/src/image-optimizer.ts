/// <reference lib="dom" />
/**
 * Image Optimization Utility for Cloudflare Images
 *
 * ROUTING STRATEGY:
 * - For allowed absolute CDN URLs: routes transforms through the image's own origin
 *   (e.g., https://cloud.scalius.com/cdn-cgi/image/params/path)
 * - This ensures Image Resizing only needs to be enabled on the CDN zone,
 *   not on every app zone that displays images
 * - Always includes onerror=redirect for graceful degradation
 *
 * NOTE: In development, remote CDN images can still be optimized because the
 * request goes directly to the Cloudflare-managed CDN origin. Local HTTP media
 * URLs are left untouched.
 *
 * PURITY: The public API functions (getOptimizedImageUrl, getOriginalImageUrl, etc.)
 * are pure when an explicit ImageContext is provided. When context is omitted, they
 * fall back to detectIsDev() and detectCdnBase() which probe the runtime environment
 * (import.meta.env, window.location, globalThis.process). Prefer passing explicit
 * context for predictable behavior.
 */

import { resolveMediaUrl } from "./media-url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImageOptimizationOptions {
  /**
   * Set to `null` when the caller intentionally wants to omit the dimension
   * from Cloudflare's transform params instead of inheriting the helper default.
   */
  width?: number | null;
  height?: number | null;
  quality?: number;
  format?: "auto" | "webp" | "avif" | "json";
  fit?: "scale-down" | "contain" | "cover" | "crop" | "pad";
  gravity?: "auto" | "left" | "right" | "top" | "bottom" | "center";
  sharpen?: number; // 0-10
  blur?: number; // 0-250
}

export interface ImageContext {
  /**
   * Enables Cloudflare Image Resizing rewrites. When false, the optimizer only
   * resolves bare keys to the configured CDN base and leaves image URLs raw.
   */
  enabled?: boolean;
  /**
   * CDN base URL for resolving bare R2 keys (e.g. "https://cloud.scalius.com").
   * When omitted, bare keys are returned unresolved.
   */
  cdnBase?: string;
  /**
   * Hostnames that are known to support Cloudflare Image Resizing.
   * When set, absolute URLs from other hosts are returned unchanged instead of
   * being rewritten into a /cdn-cgi/image/ path that would likely fail.
   */
  cdnHosts?: string[];
  /**
   * Source hostnames whose object paths should be served from `cdnBase`.
   * Use this for merchant-controlled CDN alias/cutover cases where the same
   * R2 object keys are reachable from an older public hostname and the
   * storefront should emit only the canonical CDN host.
   */
  cdnHostAliases?: string[];
  /**
   * Whether we are in a development environment. When true, local/relative
   * images are not rewritten through /cdn-cgi/image/.
   */
  isDev?: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS: ImageOptimizationOptions = {
  width: 600,
  height: 600,
  quality: 85,
  format: "auto",
  fit: "cover",
  sharpen: 1,
};

const CLOUDFLARE_IMAGE_PATH = "/cdn-cgi/image/";

// ---------------------------------------------------------------------------
// Internal helpers (pure)
// ---------------------------------------------------------------------------

/** @internal Pure — builds the Cloudflare Image Resizing parameter string. */
function buildParams(opts: ImageOptimizationOptions): string {
  const parts: string[] = ["onerror=redirect"];
  if (opts.width) parts.push(`width=${opts.width}`);
  if (opts.height) parts.push(`height=${opts.height}`);
  if (opts.quality) parts.push(`quality=${opts.quality}`);
  if (opts.format) parts.push(`format=${opts.format}`);
  if (opts.fit) parts.push(`fit=${opts.fit}`);
  if (opts.gravity) parts.push(`gravity=${opts.gravity}`);
  if (opts.sharpen !== undefined) parts.push(`sharpen=${opts.sharpen}`);
  if (opts.blur !== undefined) parts.push(`blur=${opts.blur}`);
  return parts.join(",");
}

/** @internal Pure — true when a caller explicitly requested transform options. */
function hasRequestedTransformOptions(
  options: ImageOptimizationOptions | undefined,
): boolean {
  return Object.values(options ?? {}).some((value) => value !== undefined);
}

/** @internal Pure — returns a decoded absolute remote URL when Cloudflare wrapped one. */
function extractNestedRemoteUrl(originalPath: string): string | null {
  if (/^https?:\/\//i.test(originalPath)) return originalPath;
  if (!/^https?%3a%2f%2f/i.test(originalPath)) return null;

  try {
    const decoded = decodeURIComponent(originalPath);
    return /^https?:\/\//i.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * @internal Pure — unwraps Cloudflare Image Resizing URLs back to their
 * original asset URL/path so callers can request a different transform.
 */
function extractCloudflareImageOriginalUrl(url: string): string | null {
  if (!url.includes(CLOUDFLARE_IMAGE_PATH)) return null;

  try {
    const parsed = new URL(url);
    const markerIndex = parsed.pathname.indexOf(CLOUDFLARE_IMAGE_PATH);
    if (markerIndex < 0) return null;

    const afterMarker = parsed.pathname.slice(
      markerIndex + CLOUDFLARE_IMAGE_PATH.length,
    );
    const sourceStartIndex = afterMarker.indexOf("/");
    if (sourceStartIndex < 0) return null;

    const originalPath = afterMarker.slice(sourceStartIndex + 1);
    if (!originalPath) return null;

    const suffix = `${parsed.search}${parsed.hash}`;
    const nestedRemoteUrl = extractNestedRemoteUrl(originalPath);
    if (nestedRemoteUrl) return `${nestedRemoteUrl}${suffix}`;

    return `${parsed.origin}/${originalPath}${suffix}`;
  } catch {
    const markerIndex = url.indexOf(CLOUDFLARE_IMAGE_PATH);
    if (markerIndex < 0) return null;

    const afterMarker = url.slice(markerIndex + CLOUDFLARE_IMAGE_PATH.length);
    const sourceStartIndex = afterMarker.indexOf("/");
    if (sourceStartIndex < 0) return null;

    const originalPath = afterMarker.slice(sourceStartIndex + 1);
    if (!originalPath) return null;

    return extractNestedRemoteUrl(originalPath) ?? originalPath;
  }
}

/** @internal Pure — true for image formats Cloudflare Image Resizing should not transform. */
function isNonResizableImageUrl(value: string): boolean {
  const withoutHash = value.split("#", 1)[0] ?? "";
  const withoutQuery = withoutHash.split("?", 1)[0] ?? "";
  const pathname = (() => {
    try {
      return new URL(value).pathname;
    } catch {
      return withoutQuery;
    }
  })().toLowerCase();

  return /\.(?:svg|svgz|ico)$/.test(pathname);
}

/** @internal Pure — extracts a lowercase hostname from a URL or host-like value. */
function toHostname(value: string | undefined): string {
  const raw = value?.trim();
  if (!raw) return "";

  try {
    return new URL(
      raw.includes("://") ? raw : `https://${raw}`,
    ).hostname.toLowerCase();
  } catch {
    return (
      raw
        .replace(/^https?:\/\//, "")
        .split("/")[0]
        ?.toLowerCase() || ""
    );
  }
}

/** @internal Pure — builds the CDN host allow-list from context and cdnBase. */
function getAllowedCdnHosts(
  ctx: ImageContext | undefined,
  cdnBase: string,
): Set<string> {
  const hosts = new Set<string>();
  const baseHost = toHostname(cdnBase);
  if (baseHost) hosts.add(baseHost);

  for (const host of ctx?.cdnHosts ?? []) {
    const normalized = toHostname(host);
    if (normalized) hosts.add(normalized);
  }

  return hosts;
}

/** @internal Pure — builds the host alias set from context. */
function getAliasCdnHosts(ctx: ImageContext | undefined): Set<string> {
  const hosts = new Set<string>();
  for (const host of ctx?.cdnHostAliases ?? []) {
    const normalized = toHostname(host);
    if (normalized) hosts.add(normalized);
  }
  return hosts;
}

/** @internal Pure — checks if an absolute URL is eligible for Cloudflare resizing. */
function canResizeAbsoluteUrl(url: URL, allowedHosts: Set<string>): boolean {
  if (url.protocol !== "https:") return false;
  if (allowedHosts.size === 0) return true;
  return allowedHosts.has(url.hostname.toLowerCase());
}

// ---------------------------------------------------------------------------
// Environment detection helpers (NOT pure — probe runtime globals)
// ---------------------------------------------------------------------------

/**
 * Detect development environment via standard signals.
 * Used as a fallback when the caller does not explicitly pass `isDev`.
 *
 * **Not pure** — reads `import.meta.env`, `window.location`, and
 * `globalThis.process` to infer the environment.
 *
 * @internal
 */
function detectIsDev(): boolean {
  // Vite / Astro — import.meta.env.MODE or import.meta.env.DEV
  if (typeof import.meta !== "undefined") {
    const meta = import.meta as { env?: { MODE?: string; DEV?: boolean } };
    if (meta.env?.MODE === "development") return true;
    if (meta.env?.DEV === true) return true;
  }

  // Browser — localhost or local network
  if (typeof window !== "undefined" && "location" in window) {
    const hostname = window.location.hostname;
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname.startsWith("192.168.") ||
      hostname.includes("local")
    ) {
      return true;
    }
  }

  // Node.js / Wrangler — process.env.NODE_ENV
  if (typeof globalThis !== "undefined" && "process" in globalThis) {
    const proc = globalThis as { process?: { env?: { NODE_ENV?: string } } };
    if (proc.process?.env?.NODE_ENV === "development") return true;
  }

  return false;
}

/**
 * Detect CDN base from configured env vars (R2_PUBLIC_URL, CDN_DOMAIN_URL).
 * Used as a fallback when the caller does not explicitly pass `cdnBase`.
 *
 * **Not pure** — reads `import.meta.env` to find CDN configuration.
 *
 * @internal
 */
function detectCdnBase(): string {
  if (typeof import.meta === "undefined") return "";

  const meta = import.meta as {
    env?: { R2_PUBLIC_URL?: string; CDN_DOMAIN_URL?: string };
  };

  const r2Url = meta.env?.R2_PUBLIC_URL;
  if (r2Url) return r2Url.replace(/\/$/, "");

  const cdnDomain = meta.env?.CDN_DOMAIN_URL;
  if (cdnDomain) {
    const d = cdnDomain.replace(/^https?:\/\//, "");
    return `https://${d}`;
  }

  return "";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates an optimized image URL using Cloudflare Image Resizing.
 *
 * **Pure when `ctx` is provided.** Falls back to environment detection otherwise.
 *
 * @param originalUrl - The original image URL from R2 (full URL or bare key)
 * @param options - Cloudflare image transformation options (optional)
 * @param ctx - Runtime context: cdnBase & isDev (optional — auto-detected if omitted)
 * @returns Optimized image URL (production) or resolved URL (dev)
 */
export function getOptimizedImageUrl(
  originalUrl: string | null | undefined,
  options?: ImageOptimizationOptions,
  ctx?: ImageContext,
): string {
  const cdnBase = ctx?.cdnBase ?? detectCdnBase();
  const isDev = ctx?.isDev ?? detectIsDev();
  const allowedHosts = getAllowedCdnHosts(ctx, cdnBase);
  const aliasHosts = getAliasCdnHosts(ctx);

  const resolutionOptions = { cdnHostAliases: ctx?.cdnHostAliases };

  // Resolve bare keys and configured CDN aliases to canonical URLs.
  const resolved = resolveMediaUrl(originalUrl, cdnBase, resolutionOptions);
  if (!resolved) return "";

  const isAlreadyOptimized = resolved.includes(CLOUDFLARE_IMAGE_PATH);
  const unwrappedOriginal = isAlreadyOptimized
    ? extractCloudflareImageOriginalUrl(resolved)
    : null;
  const sourceUrl = unwrappedOriginal
    ? resolveMediaUrl(unwrappedOriginal, cdnBase, resolutionOptions)
    : resolved;

  if (ctx?.enabled === false) return sourceUrl;

  if (isNonResizableImageUrl(sourceUrl)) return sourceUrl;

  // Keep already optimized URLs idempotent unless the caller asks for a
  // context-specific transform such as a new width, height, fit, or quality.
  if (isAlreadyOptimized && !hasRequestedTransformOptions(options)) {
    return resolved;
  }

  // Merge with defaults
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const params = buildParams(opts);

  // For allowed absolute CDN URLs, route transforms through the image's own origin.
  if (/^https?:\/\//.test(sourceUrl)) {
    try {
      const url = new URL(sourceUrl);
      const canonicalBaseHost = toHostname(cdnBase);
      if (canonicalBaseHost && aliasHosts.has(url.hostname.toLowerCase())) {
        const canonicalBase = new URL(
          cdnBase.includes("://") ? cdnBase : `https://${cdnBase}`,
        );
        return `${canonicalBase.origin}/cdn-cgi/image/${params}${url.pathname}${url.search}`;
      }
      if (!canResizeAbsoluteUrl(url, allowedHosts)) return resolved;
      return `${url.origin}/cdn-cgi/image/${params}${url.pathname}${url.search}`;
    } catch {
      // fall through to relative path
    }
  }

  // In development, skip local relative transforms because localhost has no /cdn-cgi/image/.
  if (isDev) return sourceUrl;

  // For relative paths, use page-relative /cdn-cgi/image/
  const relativePath = sourceUrl.startsWith("/") ? sourceUrl : `/${sourceUrl}`;
  return `/cdn-cgi/image/${params}${relativePath}`;
}

/**
 * Get the original (non-optimized) URL.
 * Use this for download links, full-resolution views, and image editing.
 *
 * **Pure when `cdnBase` is provided.** Falls back to environment detection otherwise.
 *
 * @param url - Any image URL (optimized or original)
 * @param cdnBase - CDN base URL for resolving bare keys (optional)
 * @returns The original URL without Cloudflare transformations
 */
export function getOriginalImageUrl(
  url: string | null | undefined,
  cdnBase?: string,
): string {
  if (!url) return "";

  const original = extractCloudflareImageOriginalUrl(url);
  if (original) {
    const base = cdnBase ?? detectCdnBase();
    return resolveMediaUrl(original, base);
  }

  // Resolve bare keys to full CDN URLs
  const base = cdnBase ?? detectCdnBase();
  return resolveMediaUrl(url, base);
}

/**
 * Check if an image URL is from R2 storage.
 *
 * **Pure when `cdnBase` is provided.** Falls back to environment detection otherwise.
 *
 * @param url - The image URL to check
 * @param cdnBase - CDN base URL (e.g. "https://cloud.scalius.com")
 * @returns true if the image is hosted on the CDN
 */
export function isR2Image(
  url: string | null | undefined,
  cdnBase?: string,
): boolean {
  if (!url) return false;

  const base = cdnBase ?? detectCdnBase();
  const resolved = resolveMediaUrl(url, base);
  if (!resolved) return false;

  const cdnHost = base.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!cdnHost) return false;

  try {
    return new URL(resolved).hostname === cdnHost;
  } catch {
    return false;
  }
}

/**
 * Optimized Image Component Props Helper.
 * Returns standardized props for image elements.
 *
 * **Pure when `ctx` is provided.**
 *
 * @param originalUrl - The original image URL
 * @param alt - Alt text for the image
 * @param options - Cloudflare image transformation options (optional)
 * @param ctx - Runtime context (optional)
 */
export function getOptimizedImageProps(
  originalUrl: string | null | undefined,
  alt: string,
  options?: ImageOptimizationOptions,
  ctx?: ImageContext,
): {
  src: string;
  alt: string;
  loading: "lazy";
  decoding: "async";
} {
  return {
    src: getOptimizedImageUrl(originalUrl, options, ctx),
    alt,
    loading: "lazy",
    decoding: "async",
  };
}

/**
 * Generates responsive srcset for Cloudflare-optimized images.
 *
 * **Pure when `ctx` is provided.**
 *
 * @param imageUrl - The original CDN image URL
 * @param widths - Array of widths for srcset (defaults to [320, 640, 768, 1024, 1280])
 * @param options - Base image transformation options
 * @param ctx - Runtime context (optional)
 * @returns srcset string
 */
export function getResponsiveSrcSet(
  imageUrl: string | null | undefined,
  widths: number[] = [320, 640, 768, 1024, 1280],
  options: ImageOptimizationOptions = {},
  ctx?: ImageContext,
): string {
  if (!imageUrl || imageUrl.trim() === "") return "";
  const cdnBase = ctx?.cdnBase ?? detectCdnBase();
  const sourceUrl = resolveMediaUrl(imageUrl, cdnBase, {
    cdnHostAliases: ctx?.cdnHostAliases,
  });
  if (!sourceUrl || isNonResizableImageUrl(sourceUrl)) return "";

  return widths
    .map((width) => {
      const url = getOptimizedImageUrl(
        imageUrl,
        { ...options, width, height: width },
        ctx,
      );
      return `${url} ${width}w`;
    })
    .join(", ");
}

/**
 * Presets for common image use cases.
 * **Pure when `ctx` is provided.**
 */
export const ImagePresets = {
  productThumbnail: (url: string | null | undefined, ctx?: ImageContext) =>
    getOptimizedImageUrl(url, { width: 200, height: 200, quality: 75 }, ctx),

  productCard: (url: string | null | undefined, ctx?: ImageContext) =>
    getOptimizedImageUrl(url, { width: 400, height: 400, quality: 75 }, ctx),

  productDetail: (url: string | null | undefined, ctx?: ImageContext) =>
    getOptimizedImageUrl(url, { width: 800, height: 800, quality: 85 }, ctx),

  hero: (url: string | null | undefined, ctx?: ImageContext) =>
    getOptimizedImageUrl(
      url,
      { width: 1920, height: 600, quality: 90, fit: "cover" },
      ctx,
    ),

  heroMobile: (url: string | null | undefined, ctx?: ImageContext) =>
    getOptimizedImageUrl(
      url,
      { width: 768, height: 400, quality: 85, fit: "cover" },
      ctx,
    ),
};
