/// <reference lib="dom" />
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
 * Detect CDN base from legacy env vars (R2_PUBLIC_URL, CDN_DOMAIN_URL).
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
