/**
 * Image Optimization Utility for Cloudflare Images
 *
 * ROUTING STRATEGY:
 * - For absolute CDN URLs: routes transforms through the image's own origin
 *   (e.g., https://cloud.scalius.com/cdn-cgi/image/params/path)
 * - This ensures Image Resizing only needs to be enabled on the CDN zone,
 *   not on every app zone that displays images
 * - Always includes onerror=redirect for graceful degradation
 *
 * NOTE: Bypasses optimization on localhost since /cdn-cgi/ only works on Cloudflare.
 *
 * This module is PURE — it does not read environment variables. Callers must
 * supply cdnBase and isDev context via the options parameter or wrapper functions.
 */

import { resolveMediaUrl } from "./media-url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImageOptimizationOptions {
  width?: number;
  height?: number;
  quality?: number;
  format?: "auto" | "webp" | "avif" | "json";
  fit?: "scale-down" | "contain" | "cover" | "crop" | "pad";
  gravity?: "auto" | "left" | "right" | "top" | "bottom" | "center";
  sharpen?: number; // 0-10
  blur?: number; // 0-250
}

export interface ImageContext {
  /**
   * CDN base URL for resolving bare R2 keys (e.g. "https://cloud.scalius.com").
   * When omitted, bare keys are returned unresolved.
   */
  cdnBase?: string;
  /**
   * Whether we are in a development environment. When true, Cloudflare
   * /cdn-cgi/image/ transforms are skipped (they 404 on localhost).
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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

/**
 * Detect development environment via standard signals.
 * Used as a fallback when the caller does not explicitly pass isDev.
 */
function detectIsDev(): boolean {
  return (
    (typeof import.meta !== "undefined" &&
      import.meta.env?.MODE === "development") ||
    (typeof import.meta !== "undefined" && import.meta.env?.DEV === true) ||
    (typeof window !== "undefined" &&
      (window.location.hostname === "localhost" ||
        window.location.hostname === "127.0.0.1" ||
        window.location.hostname.startsWith("192.168.") ||
        window.location.hostname.includes("local"))) ||
    (typeof process !== "undefined" && process.env?.NODE_ENV === "development")
  );
}

/**
 * Detect CDN base from legacy env vars.
 * Used as a fallback when the caller does not explicitly pass cdnBase.
 */
function detectCdnBase(): string {
  const r2Url =
    typeof import.meta !== "undefined" && import.meta.env?.R2_PUBLIC_URL;
  if (r2Url) return (r2Url as string).replace(/\/$/, "");

  const cdnDomain =
    typeof import.meta !== "undefined" && import.meta.env?.CDN_DOMAIN_URL;
  if (cdnDomain) {
    const d = (cdnDomain as string).replace(/^https?:\/\//, "");
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

  // Resolve bare keys to full CDN URLs
  const resolved = resolveMediaUrl(originalUrl, cdnBase);
  if (!resolved) return "";

  // Already optimized
  if (resolved.includes("/cdn-cgi/image/")) return resolved;

  // In development, skip Cloudflare transforms (they 404 on localhost)
  if (isDev) return resolved;

  // Merge with defaults
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const params = buildParams(opts);

  // For absolute URLs, route transforms through the image's own origin.
  if (resolved.startsWith("https://")) {
    try {
      const url = new URL(resolved);
      return `${url.origin}/cdn-cgi/image/${params}${url.pathname}`;
    } catch {
      // fall through to relative path
    }
  }

  // For relative paths, use page-relative /cdn-cgi/image/
  return `/cdn-cgi/image/${params}/${resolved}`;
}

/**
 * Get the original (non-optimized) URL.
 * Use this for download links, full-resolution views, and image editing.
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

  // If URL contains /cdn-cgi/image/, extract the original URL
  if (url.includes("/cdn-cgi/image/")) {
    // Handle absolute CDN URLs: https://cdn.example.com/cdn-cgi/image/params/path
    const match = url.match(
      /^(https?:\/\/[^/]+)\/cdn-cgi\/image\/[^/]+(\/.+)$/,
    );
    if (match && match[1] && match[2]) {
      return `${match[1]}${match[2]}`;
    }
    // Handle relative URLs: /cdn-cgi/image/params/https://...
    const relMatch = url.match(/\/cdn-cgi\/image\/[^/]+\/(.+)/);
    if (relMatch && relMatch[1]) {
      return relMatch[1];
    }
  }

  // Resolve bare keys to full CDN URLs
  const base = cdnBase ?? detectCdnBase();
  return resolveMediaUrl(url, base);
}

/**
 * Check if an image URL is from R2 storage.
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
 */
export const ImagePresets = {
  productThumbnail: (
    url: string | null | undefined,
    ctx?: ImageContext,
  ) => getOptimizedImageUrl(url, { width: 200, height: 200, quality: 75 }, ctx),

  productCard: (
    url: string | null | undefined,
    ctx?: ImageContext,
  ) => getOptimizedImageUrl(url, { width: 400, height: 400, quality: 75 }, ctx),

  productDetail: (
    url: string | null | undefined,
    ctx?: ImageContext,
  ) => getOptimizedImageUrl(url, { width: 800, height: 800, quality: 85 }, ctx),

  hero: (
    url: string | null | undefined,
    ctx?: ImageContext,
  ) =>
    getOptimizedImageUrl(
      url,
      { width: 1920, height: 600, quality: 90, fit: "cover" },
      ctx,
    ),

  heroMobile: (
    url: string | null | undefined,
    ctx?: ImageContext,
  ) =>
    getOptimizedImageUrl(
      url,
      { width: 768, height: 400, quality: 85, fit: "cover" },
      ctx,
    ),
};
