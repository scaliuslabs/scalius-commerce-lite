import { mediaImageSrcSet, mediaImageUrl, resolveMediaUrl } from "./media-url";
import {
  responsiveImageSources,
  type ImageSlot,
  type ResponsiveImageSources,
} from "./responsive-image";

export const PRODUCT_IMAGE_FALLBACK = "/placeholder-product.svg";

function normalizeImageSource(url: string | null | undefined): string {
  return typeof url === "string" ? url.trim() : "";
}

export function hasProductImage(url: string | null | undefined): boolean {
  return normalizeImageSource(url) !== "";
}

/** A product image rendition at least `width` px wide, or the placeholder. */
export function getProductImageUrl(
  url: string | null | undefined,
  width: number,
  fallback = PRODUCT_IMAGE_FALLBACK,
): string {
  const source = normalizeImageSource(url);
  return (source && mediaImageUrl(source, width)) || fallback;
}

/** `srcset` over every rendition of a product image; undefined when it has none. */
export function getProductImageSrcSet(
  url: string | null | undefined,
): string | undefined {
  const source = normalizeImageSource(url);
  return source ? mediaImageSrcSet(source) : undefined;
}

/**
 * The CDN URL of a product image (its largest rendition when it has any), or
 * the placeholder. Client scripts derive slot sources from it with
 * `responsiveImageSources`, the helper `productImageSources` uses on SSR.
 */
export function resolveProductImageUrl(
  url: string | null | undefined,
  fallback = PRODUCT_IMAGE_FALLBACK,
): string {
  const source = normalizeImageSource(url);
  return (source && resolveMediaUrl(source)) || fallback;
}

/** `src`/`srcset`/`sizes` of a product image in `slot`, or the placeholder. */
export function productImageSources(
  url: string | null | undefined,
  slot: ImageSlot,
  fallback = PRODUCT_IMAGE_FALLBACK,
): ResponsiveImageSources {
  return responsiveImageSources(resolveProductImageUrl(url, fallback), slot);
}
