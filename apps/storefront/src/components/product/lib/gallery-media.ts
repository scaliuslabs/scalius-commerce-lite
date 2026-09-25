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
import type { Product, ProductMedia } from "@/lib/api";
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
}

export function formatVideoDuration(durationMs: number | null): string | null {
  if (!durationMs || durationMs <= 0) return null;
  const totalSeconds = Math.round(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function productGalleryItems(
  product: Pick<Product, "name" | "imageAlt">,
  media: readonly ProductMedia[],
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
      altText: item.altText?.trim() || fallbackAlt,
      duration: item.kind === "video" ? formatVideoDuration(item.durationMs) : null,
      isPrimary: item.isPrimary,
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
