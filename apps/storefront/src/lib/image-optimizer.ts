/**
 * Cloudflare Image Optimization Utility
 *
 * Transforms CDN image URLs to use Cloudflare's image resizing service.
 *
 * ROUTING STRATEGY:
 * - For absolute URLs: routes through the image's own origin
 *   (e.g., https://cloud.scalius.com/cdn-cgi/image/params/path)
 * - This ensures /cdn-cgi/image/ is processed by the zone that hosts the image,
 *   not the storefront zone. Only the CDN zone needs Image Resizing enabled.
 * - Always includes onerror=redirect for graceful degradation.
 *
 * NOTE: Bypasses optimization on localhost since /cdn-cgi/ only works on Cloudflare.
 */

import { resolveMediaUrl } from "./media-url";

/**
 * Check if we're running on localhost/development
 * The /cdn-cgi/image/ path only works on Cloudflare's edge network
 */
const isDev =
  import.meta.env.DEV ||
  (typeof window !== "undefined" && window.location.hostname === "localhost");

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

/**
 * Default image optimization options for product images
 */
const DEFAULT_PRODUCT_OPTIONS: ImageOptimizationOptions = {
  width: 400,
  height: 400,
  quality: 75,
  format: "auto",
  fit: "cover",
};

/**
 * Build Cloudflare Image Resizing options string
 */
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
 * Generates Cloudflare Image Resizing URL
 *
 * @param imageUrl - The original CDN image URL or bare R2 key
 * @param options - Image transformation options
 * @returns Cloudflare-optimized image URL
 */
export function getOptimizedImageUrl(
  imageUrl: string | null | undefined,
  options: ImageOptimizationOptions = {},
): string {
  // Resolve bare keys to full CDN URLs
  const resolved = resolveMediaUrl(imageUrl);

  // Handle null/undefined/empty URLs
  if (!resolved) {
    return "/img/no-image.webp";
  }

  // Bypass Cloudflare optimization on localhost (returns 404)
  if (isDev) {
    return resolved;
  }

  // Already optimized
  if (resolved.includes("/cdn-cgi/image/")) {
    return resolved;
  }

  // Merge with defaults
  const opts = { ...DEFAULT_PRODUCT_OPTIONS, ...options };
  const params = buildParams(opts);

  // For absolute URLs, route transforms through the image's own origin.
  // This ensures /cdn-cgi/image/ is processed by the CDN zone (e.g., cloud.scalius.com),
  // not the storefront zone.
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
 * Generates responsive srcset for Cloudflare-optimized images
 *
 * @param imageUrl - The original CDN image URL
 * @param widths - Array of widths for srcset (defaults to [320, 640, 768, 1024, 1280])
 * @param options - Base image transformation options
 * @returns srcset string
 */
export function getResponsiveSrcSet(
  imageUrl: string | null | undefined,
  widths: number[] = [320, 640, 768, 1024, 1280],
  options: ImageOptimizationOptions = {},
): string {
  if (!imageUrl || imageUrl.trim() === "") {
    return "";
  }

  return widths
    .map((width) => {
      const url = getOptimizedImageUrl(imageUrl, {
        ...options,
        width,
        height: width,
      });
      return `${url} ${width}w`;
    })
    .join(", ");
}

/**
 * Presets for common image use cases
 */
export const ImagePresets = {
  productThumbnail: (url: string | null | undefined) =>
    getOptimizedImageUrl(url, { width: 200, height: 200, quality: 75 }),

  productCard: (url: string | null | undefined) =>
    getOptimizedImageUrl(url, { width: 400, height: 400, quality: 75 }),

  productDetail: (url: string | null | undefined) =>
    getOptimizedImageUrl(url, { width: 800, height: 800, quality: 85 }),

  hero: (url: string | null | undefined) =>
    getOptimizedImageUrl(url, {
      width: 1920,
      height: 600,
      quality: 90,
      fit: "cover",
    }),

  heroMobile: (url: string | null | undefined) =>
    getOptimizedImageUrl(url, {
      width: 768,
      height: 400,
      quality: 85,
      fit: "cover",
    }),
};
