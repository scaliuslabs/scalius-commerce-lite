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
const RICH_TEXT_DEFAULT_WIDTH = 1200;
const RICH_TEXT_MIN_WIDTH = 160;
const RICH_TEXT_MAX_WIDTH = 2000;

function isImageOptimizationDisabledInCurrentEnvironment() {
  return (
    import.meta.env.MODE === "development" ||
    import.meta.env.DEV === true ||
    (typeof window !== "undefined" &&
      (window.location.hostname === "localhost" ||
       window.location.hostname === "127.0.0.1" ||
       window.location.hostname.startsWith("192.168.") ||
       window.location.hostname.includes("local"))) ||
    (typeof process !== "undefined" && process.env.NODE_ENV === "development")
  );
}

function buildCloudflareImageUrl(
  resolvedUrl: string,
  params: string[],
): string {
  return `/cdn-cgi/image/${params.join(",")}/${resolvedUrl}`;
}

function parsePixelWidth(width: string | null | undefined): number | null {
  if (!width) return null;

  const parsedWidth = parseInt(width, 10);
  if (Number.isNaN(parsedWidth) || parsedWidth <= 0) {
    return null;
  }

  return parsedWidth;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getRichTextTargetWidth(width: string | null | undefined): number {
  const parsedWidth = parsePixelWidth(width);

  if (!parsedWidth) {
    return RICH_TEXT_DEFAULT_WIDTH;
  }

  // Ask Cloudflare for a slightly larger asset than the rendered width so
  // resized/editor-selected images stay sharp on high-density displays.
  return clamp(Math.round(parsedWidth * 2), RICH_TEXT_MIN_WIDTH, RICH_TEXT_MAX_WIDTH);
}

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

  // In development, return resolved URL (no optimization)
  if (isImageOptimizationDisabledInCurrentEnvironment()) {
    return resolved;
  }

  return buildCloudflareImageUrl(resolved, [
    `width=${STANDARD_WIDTH}`,
    `height=${STANDARD_HEIGHT}`,
    `fit=cover`,
    `quality=${STANDARD_QUALITY}`,
    `format=auto`,
    `sharpen=1`,
  ]);
}

/**
 * Generates a rich-text-friendly image URL.
 *
 * Unlike square card thumbnails, rich text images should preserve aspect ratio
 * and scale their requested width to match the rendered content width.
 */
export function getRichTextOptimizedImageUrl(
  originalUrl: string | null | undefined,
  width: string | null | undefined,
): string {
  const resolved = resolveMediaUrl(originalUrl);
  if (!resolved) return "";

  if (resolved.includes("/cdn-cgi/image/")) {
    return resolved;
  }

  if (isImageOptimizationDisabledInCurrentEnvironment()) {
    return resolved;
  }

  return buildCloudflareImageUrl(resolved, [
    "onerror=redirect",
    `width=${getRichTextTargetWidth(width)}`,
    "fit=scale-down",
    `quality=${STANDARD_QUALITY}`,
    "format=avif",
  ]);
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
