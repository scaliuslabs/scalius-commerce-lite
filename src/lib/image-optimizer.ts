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

// Standard optimized size for all images
const STANDARD_WIDTH = 600;
const STANDARD_HEIGHT = 600;
const STANDARD_QUALITY = 85;

/**
 * Generates an optimized image URL using Cloudflare Image Resizing
 *
 * IMPORTANT: Only works in production (Cloudflare environment)
 * In development (localhost), returns original URL for compatibility
 *
 * @param originalUrl - The original image URL from R2
 * @returns Optimized image URL with Cloudflare transformations (production) or original URL (dev)
 *
 * @example
 * ```tsx
 * const optimizedUrl = getOptimizedImageUrl('https://r2.example.com/image.jpg');
 * <img src={optimizedUrl} alt="..." />
 * ```
 */
export function getOptimizedImageUrl(originalUrl: string | null | undefined): string {
  // Return empty string if no URL provided
  if (!originalUrl) {
    return "";
  }

  // If URL is already optimized (contains /cdn-cgi/image/), return as-is
  if (originalUrl.includes("/cdn-cgi/image/")) {
    return originalUrl;
  }

  // CRITICAL: Check if we're in development mode
  // /cdn-cgi/image/ only works on Cloudflare infrastructure
  // Check multiple indicators to determine environment
  const isDevelopment =
    // Check if we're in dev mode (astro dev) - this is the most reliable
    import.meta.env.MODE === "development" ||
    import.meta.env.DEV === true ||
    // Check hostname if running in browser
    (typeof window !== "undefined" &&
      (window.location.hostname === "localhost" ||
       window.location.hostname === "127.0.0.1" ||
       window.location.hostname.startsWith("192.168.") ||
       window.location.hostname.includes("local"))) ||
    // Check if we're in Astro dev server (no CF runtime)
    (typeof process !== "undefined" && process.env.NODE_ENV === "development");

  // In development, return original URL (no optimization)
  if (isDevelopment) {
    return originalUrl;
  }

  console.log("[Image Optimizer] Production mode, optimizing:", originalUrl);

  try {
    // Parse the URL to ensure it's valid
    new URL(originalUrl);

    // Build Cloudflare Image Resizing parameters
    const params = [
      `width=${STANDARD_WIDTH}`,
      `height=${STANDARD_HEIGHT}`,
      `fit=cover`,              // Maintains aspect ratio, crops if needed
      `quality=${STANDARD_QUALITY}`,
      `format=auto`,            // Auto-select WebP/AVIF for supported browsers
      `sharpen=1`,              // Slight sharpening for better quality at smaller size
    ].join(",");

    // Construct the optimized URL
    // Format: /cdn-cgi/image/{params}/{full-url-to-image}
    // IMPORTANT: Must use full URL for external sources like R2
    return `/cdn-cgi/image/${params}/${originalUrl}`;
  } catch (error) {
    // If URL parsing fails, return original URL as fallback
    console.warn("Failed to optimize image URL:", originalUrl, error);
    return originalUrl;
  }
}

/**
 * Get the original (non-optimized) URL
 * Use this for:
 * - Download links
 * - Full-resolution requirements
 * - Image editing/processing
 *
 * @param url - Any image URL (optimized or original)
 * @returns The original URL without Cloudflare transformations
 */
export function getOriginalImageUrl(url: string | null | undefined): string {
  if (!url) {
    return "";
  }

  // If URL contains /cdn-cgi/image/, extract the original URL
  if (url.includes("/cdn-cgi/image/")) {
    // Format: /cdn-cgi/image/{params}/{full-original-url}
    // Extract everything after the params (after the second slash following /cdn-cgi/image/)
    const match = url.match(/\/cdn-cgi\/image\/[^/]+\/(.+)/);
    if (match && match[1]) {
      // match[1] contains the full original URL
      return match[1];
    }
  }

  return url;
}

/**
 * Check if an image URL is from R2 storage
 * Useful for determining if optimization should be applied
 */
export function isR2Image(url: string | null | undefined): boolean {
  if (!url) {
    return false;
  }

  const r2PublicUrl = process.env.R2_PUBLIC_URL || "";
  if (!r2PublicUrl) {
    return false;
  }

  try {
    const r2Hostname = new URL(r2PublicUrl).hostname;
    const urlHostname = new URL(url).hostname;
    return urlHostname === r2Hostname;
  } catch {
    return false;
  }
}

/**
 * Optimized Image Component Props Helper
 * Returns standardized props for image elements
 *
 * @example
 * ```tsx
 * const imgProps = getOptimizedImageProps(imageUrl, "Product image");
 * <img {...imgProps} className="..." />
 * ```
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
