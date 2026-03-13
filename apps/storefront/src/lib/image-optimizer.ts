/**
 * Cloudflare Image Optimization Utility
 *
 * Transforms CDN image URLs to use Cloudflare's image resizing service.
 * Pattern: /cdn-cgi/image/{options}/{imageUrl}
 *
 * This ensures images are optimized on-the-fly by Cloudflare's edge network,
 * reducing bandwidth and improving load times.
 *
 * NOTE: Bypasses optimization on localhost since /cdn-cgi/ only works on Cloudflare.
 */

import { resolveMediaUrl } from "./media-url";

/**
 * Check if we're running on localhost/development
 * The /cdn-cgi/image/ path only works on Cloudflare's edge network
 */
const isLocalhost =
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
  onerror?: "redirect";
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
  onerror: "redirect",
};

/**
 * Generates Cloudflare Image Resizing URL
 *
 * @param imageUrl - The original CDN image URL or bare R2 key
 * @param options - Image transformation options
 * @returns Cloudflare-optimized image URL path
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
  if (isLocalhost) {
    return resolved;
  }

  // Merge with defaults
  const opts = { ...DEFAULT_PRODUCT_OPTIONS, ...options };

  // Build Cloudflare Image Resizing options string
  const optionParts: string[] = [];

  if (opts.width) optionParts.push(`width=${opts.width}`);
  if (opts.height) optionParts.push(`height=${opts.height}`);
  if (opts.quality) optionParts.push(`quality=${opts.quality}`);
  if (opts.format) optionParts.push(`format=${opts.format}`);
  if (opts.fit) optionParts.push(`fit=${opts.fit}`);
  if (opts.gravity) optionParts.push(`gravity=${opts.gravity}`);
  if (opts.sharpen !== undefined) optionParts.push(`sharpen=${opts.sharpen}`);
  if (opts.blur !== undefined) optionParts.push(`blur=${opts.blur}`);
  if (opts.onerror) optionParts.push(`onerror=${opts.onerror}`);

  const optionsString = optionParts.join(",");

  // Return Cloudflare Image Resizing URL
  // Format: /cdn-cgi/image/{options}/{imageUrl}
  return `/cdn-cgi/image/${optionsString}/${resolved}`;
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
