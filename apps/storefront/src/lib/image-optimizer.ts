/**
 * Storefront image optimization.
 *
 * Re-exports @scalius/shared's image optimizer, pre-bound with the
 * storefront's runtime CDN base and dev-mode detection.
 */
import {
  getOptimizedImageUrl as sharedGetOptimizedImageUrl,
  getResponsiveSrcSet as sharedGetResponsiveSrcSet,
  ImagePresets as sharedImagePresets,
  type ImageOptimizationOptions,
  type ImageContext,
} from "@scalius/shared/image-optimizer";
import {
  getCdnBase,
  getCdnCanonicalHostAliases,
  getCdnHosts,
  getImageOptimizationEnabled,
} from "./media-url";

export type { ImageOptimizationOptions, ImageContext };

// Dev detection — matches the shared util's logic but uses Vite/Astro env
const isDev =
  import.meta.env.DEV ||
  (typeof window !== "undefined" && window.location.hostname === "localhost");

/** Build the storefront's ImageContext lazily */
function getCtx(): ImageContext {
  return {
    enabled: getImageOptimizationEnabled(),
    cdnBase: getCdnBase(),
    cdnHosts: getCdnHosts(),
    cdnHostAliases: getCdnCanonicalHostAliases(),
    isDev,
  };
}

/**
 * Generates Cloudflare Image Resizing URL, pre-configured with the
 * storefront's runtime CDN base.
 */
export function getOptimizedImageUrl(
  imageUrl: string | null | undefined,
  options: ImageOptimizationOptions = {},
): string {
  return sharedGetOptimizedImageUrl(imageUrl, options, getCtx());
}

/**
 * Generates responsive srcset for Cloudflare-optimized images.
 */
export function getResponsiveSrcSet(
  imageUrl: string | null | undefined,
  widths: number[] = [320, 640, 768, 1024, 1280],
  options: ImageOptimizationOptions = {},
): string {
  return sharedGetResponsiveSrcSet(imageUrl, widths, options, getCtx());
}

/**
 * Presets for common image use cases, pre-configured with storefront context.
 */
export const ImagePresets = {
  productThumbnail: (url: string | null | undefined) =>
    sharedImagePresets.productThumbnail(url, getCtx()),
  productCard: (url: string | null | undefined) =>
    sharedImagePresets.productCard(url, getCtx()),
  productDetail: (url: string | null | undefined) =>
    sharedImagePresets.productDetail(url, getCtx()),
  hero: (url: string | null | undefined) =>
    sharedImagePresets.hero(url, getCtx()),
  heroMobile: (url: string | null | undefined) =>
    sharedImagePresets.heroMobile(url, getCtx()),
};
