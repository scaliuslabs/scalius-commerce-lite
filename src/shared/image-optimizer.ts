/**
 * Image Optimization Utility for Cloudflare Images
 *
 * COST OPTIMIZATION STRATEGY:
 * - Uses ONE standard size (600x600) for ALL image displays
 * - This prevents multiple transformations of the same image
 * - CSS handles display size variations (thumbnails, previews, etc.)
 * - Significantly reduces Cloudflare Image transformation costs
 *
 * WHY 600x600?
 * - Large enough for most preview use cases
 * - Small enough to load quickly (typically 50-150KB vs 5-10MB original)
 * - Good balance between quality and performance
 * - Works well for both thumbnails and medium-sized displays
 */

import { resolveMediaUrl } from "./media-url";

// Standard optimized size for all images
const STANDARD_WIDTH = 600;
const STANDARD_HEIGHT = 600;
const STANDARD_QUALITY = 85;

/**
 * Generates an optimized image URL using Cloudflare Image Resizing
 *
 * IMPORTANT: Only works in production (Cloudflare environment)
 * In development (localhost), returns resolved URL for compatibility
 *
 * @param originalUrl - The original image URL from R2 (full URL or bare key)
 * @returns Optimized image URL with Cloudflare transformations (production) or resolved URL (dev)
 */
export function getOptimizedImageUrl(originalUrl: string | null | undefined): string {
  // Resolve bare keys to full CDN URLs
  const resolved = resolveMediaUrl(originalUrl);
  if (!resolved) return "";

  // If URL is already optimized (contains /cdn-cgi/image/), return as-is
  if (resolved.includes("/cdn-cgi/image/")) {
    return resolved;
  }

  // CRITICAL: Check if we're in development mode
  // /cdn-cgi/image/ only works on Cloudflare infrastructure
  const isDevelopment =
    import.meta.env.MODE === "development" ||
    import.meta.env.DEV === true ||
    (typeof window !== "undefined" &&
      (window.location.hostname === "localhost" ||
       window.location.hostname === "127.0.0.1" ||
       window.location.hostname.startsWith("192.168.") ||
       window.location.hostname.includes("local"))) ||
    (typeof process !== "undefined" && process.env.NODE_ENV === "development");

  // In development, return resolved URL (no optimization)
  if (isDevelopment) {
    return resolved;
  }

  // Build Cloudflare Image Resizing parameters
  const params = [
    `width=${STANDARD_WIDTH}`,
    `height=${STANDARD_HEIGHT}`,
    `fit=cover`,
    `quality=${STANDARD_QUALITY}`,
    `format=auto`,
    `sharpen=1`,
  ].join(",");

  // Construct the optimized URL
  // Format: /cdn-cgi/image/{params}/{full-url-to-image}
  return `/cdn-cgi/image/${params}/${resolved}`;
}

/**
 * Get the original (non-optimized) URL
 * Use this for download links, full-resolution views, and image editing.
 *
 * @param url - Any image URL (optimized or original)
 * @returns The original URL without Cloudflare transformations
 */
export function getOriginalImageUrl(url: string | null | undefined): string {
  if (!url) return "";

  // If URL contains /cdn-cgi/image/, extract the original URL
  if (url.includes("/cdn-cgi/image/")) {
    const match = url.match(/\/cdn-cgi\/image\/[^/]+\/(.+)/);
    if (match && match[1]) {
      return match[1];
    }
  }

  // Resolve bare keys to full CDN URLs
  return resolveMediaUrl(url);
}

/**
 * Check if an image URL is from R2 storage
 */
export function isR2Image(url: string | null | undefined): boolean {
  if (!url) return false;

  const resolved = resolveMediaUrl(url);
  if (!resolved) return false;

  try {
    return new URL(resolved).hostname === "cloud.wrygo.com";
  } catch {
    return false;
  }
}

/**
 * Optimized Image Component Props Helper
 * Returns standardized props for image elements
 */
export function getOptimizedImageProps(
  originalUrl: string | null | undefined,
  alt: string
): {
  src: string;
  alt: string;
  loading: "lazy";
  decoding: "async";
} {
  return {
    src: getOptimizedImageUrl(originalUrl),
    alt,
    loading: "lazy",
    decoding: "async",
  };
}
