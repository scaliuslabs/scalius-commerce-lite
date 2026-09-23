import { mediaImageSrcSet, mediaImageUrl } from "./media-url";

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
