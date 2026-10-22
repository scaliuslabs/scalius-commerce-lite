/**
 * The product page's media, in one order shared by the gallery, the stacked
 * and grid layouts and the page's LCP preload, so the preload always names
 * the file the first paint shows.
 *
 * - Photos and uploaded videos in the merchant's order; the primary one is
 *   featured (a `?variant=` link features that SKU's photo instead).
 * - A video's poster stands in for it until the buyer presses play: the
 *   poster is what paints first, never the video.
 */
import type { Product, ProductMedia, ProductVariant } from "@/lib/api";
import { hasProductImage, resolveProductImageUrl } from "@/lib/product-media";

export interface PageGalleryItem {
  /** The product media id. */
  id: string;
  mediaId: string | null;
  kind: "image" | "video";
  /** Image: the CDN URL every slot derives from. Video: the file or embed URL. */
  url: string;
  /** Video: the poster's base URL (a slot sizes it); null without one. */
  posterUrl: string | null;
  altText: string;
  /** Video: "0:32"; null when unknown. */
  duration: string | null;
  isPrimary: boolean;
  /** Width / height from the stored media dimensions; null when unknown. */
  aspectRatio: number | null;
}

/** A stored file's width / height, or null when either side is unknown. */
export function mediaAspectRatio(media: { width?: number | null; height?: number | null }): number | null {
  const { width, height } = media;
  return typeof width === "number" && typeof height === "number" && width > 0 && height > 0 ? width / height : null;
}

export function formatVideoDuration(durationMs: number | null): string | null {
  if (!durationMs || durationMs <= 0) return null;
  const totalSeconds = Math.round(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

/**
 * A SKU photo's words when the merchant wrote none: the product and the
 * option values every SKU showing it shares ("Echo Mini Speaker, Black"), so
 * each thumbnail says which choice it shows instead of repeating the name.
 */
function variantPhotoAlt(
  productName: string,
  mediaId: string,
  variants: ReadonlyArray<Pick<ProductVariant, "imageId" | "selectedOptions">>,
): string | null {
  const users = variants.filter((variant) => variant.imageId === mediaId);
  if (users.length === 0) return null;
  const shared = users[0]!.selectedOptions.filter((option) =>
    users.every((variant) => variant.selectedOptions.some((other) =>
      other.optionDefinitionId === option.optionDefinitionId && other.optionValueId === option.optionValueId)),
  );
  const values = shared.map((option) => option.value?.trim()).filter(Boolean);
  return values.length > 0 ? `${productName}, ${values.join(" / ")}` : null;
}

export function productGalleryItems(
  product: Pick<Product, "name" | "imageAlt">,
  media: readonly ProductMedia[],
  variants: ReadonlyArray<Pick<ProductVariant, "imageId" | "selectedOptions">> = [],
): PageGalleryItem[] {
  const fallbackAlt = product.imageAlt?.trim() || product.name;
  return media
    .filter((item) => (item.kind === "video" ? Boolean(item.url) : hasProductImage(item.url)))
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))
    .map((item): PageGalleryItem => ({
      id: item.id,
      mediaId: item.mediaId,
      kind: item.kind,
      url: item.kind === "video" ? item.url : resolveProductImageUrl(item.url),
      posterUrl: item.kind === "video" && item.posterUrl ? resolveProductImageUrl(item.posterUrl) : null,
      altText: item.altText?.trim() || (item.kind === "image" ? variantPhotoAlt(product.name, item.id, variants) : null) || fallbackAlt,
      duration: item.kind === "video" ? formatVideoDuration(item.durationMs) : null,
      isPrimary: item.isPrimary,
      aspectRatio: mediaAspectRatio(item),
    }));
}

/** The item the page paints first: the `?variant=` SKU photo, else the primary, else the first. */
export function featuredGalleryItem(
  items: readonly PageGalleryItem[],
  initialProductMediaId: string | null,
): PageGalleryItem | null {
  return (
    (initialProductMediaId
      ? items.find((item) => item.id === initialProductMediaId && item.kind === "image")
      : undefined) ??
    items.find((item) => item.isPrimary) ??
    items[0] ??
    null
  );
}
