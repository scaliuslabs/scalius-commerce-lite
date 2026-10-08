/**
 * Image slots of the product gallery (ProductGallery.astro), shared by the
 * SSR markup, the page's LCP preload and the media controller so a switch
 * or a preload picks exactly the rendition the visible slot would.
 *
 * `sizes` follow the gallery's CSS (in px, 16px per rem):
 * - Below 1024px the photo spans the row unless a phone side rail is enabled.
 *   It sits inside the section's `px-3 sm:px-6`, and the
 *   square stage is capped at `min(55vh, 24rem)` tall, so a square photo
 *   never renders wider than 384px.
 * - From 1024px the gallery spans 7 of 12 columns (`gap-x-10`) of the
 *   `max-w-7xl px-8` section, 6 from 1280px, minus the thumbnail column
 *   (80px / 100px + `lg:gap-5`, or a narrow strip plus 12px) when
 *   thumbnails sit beside the photo.
 * - Stacked and grid galleries fill the column left of the sticky info
 *   column (ProductPageLayout); on phones they are one swipeable row.
 */
import type { ResolvedStorefrontThemeLayout } from "@scalius/shared/storefront-theme";
import { capSizesDensity, type ImageSlot } from "@/lib/responsive-image";

export type ProductGalleryLayout = ResolvedStorefrontThemeLayout["productPage"];

/** Rendition widths: the `src` fallback of each slot and the zoom detail. */
export const GALLERY_IMAGE_WIDTHS = {
  thumbnail: 144,
  main: 960,
  zoom: 1600,
} as const;

/** A thumbnail is at most 100px wide: the 296 step covers DPR 3 (the first ladder step at or above 288). */
const THUMBNAIL_MAX_WIDTH = 296;

/**
 * The stage's width / height: the gallery variant's own ratio, or, for the
 * square stage, the theme's photo ratio, so a tall photo never sits in a
 * square box with bars at its sides.
 */
export function galleryStageRatio(layout: ProductGalleryLayout, imageRatio: "square" | "portrait" | "landscape"): number {
  if (layout.stageRatio !== 1) return layout.stageRatio;
  return imageRatio === "portrait" ? 0.75 : imageRatio === "landscape" ? 4 / 3 : 1;
}

/** Below 1024px: full row width (12px gutters), capped at the 384px stage. */
const MOBILE_MAIN_SIZES = ["(max-width: 407px) calc(100vw - 24px)", "(max-width: 1023px) 384px"];
const MOBILE_SIDE_MAIN_SIZES = ["(max-width: 463px) calc(100vw - 80px)", "(max-width: 1023px) 384px"];

function desktopMainSizes(layout: ProductGalleryLayout, railBeside: boolean): string[] {
  // Stacked: the column left of a 345px info column and a 40px gap.
  if (layout.gallery === "stacked") return ["(max-width: 1279px) calc(100vw - 449px)", "831px"];
  // Grid: two photos across (8px apart) left of a 400px/480px info column.
  if (layout.gallery === "grid") return ["(max-width: 1279px) calc(50vw - 256px)", "344px"];
  if (railBeside && layout.thumbnailSize !== null) {
    // A narrow strip (Amazon): its width plus a 12px gap.
    const rail = layout.thumbnailSize + 12;
    return [`(max-width: 1279px) calc(58.34vw - ${54 + rail}px)`, `${588 - rail}px`];
  }
  // 7/12 of (100vw - 64px gutters - 440px gaps) + 240px of spanned gaps.
  return railBeside
    ? ["(max-width: 1279px) calc(58.34vw - 154px)", "468px"]
    : ["(max-width: 1279px) calc(58.34vw - 54px)", "588px"];
}

/**
 * The main photo slot. The mobile and desktop images share it (one `sizes`
 * over every breakpoint), so both pick the same candidate and the hidden
 * one never downloads a second file.
 */
export function productGalleryMainSlot(
  layout: ProductGalleryLayout,
  hasThumbnails: boolean,
): ImageSlot {
  const railBeside = hasThumbnails && layout.thumbnails === "beside";
  return {
    width: GALLERY_IMAGE_WIDTHS.main,
    // The LCP photo: DPR 3 phones fetch about 2x pixels (capSizesDensity).
    sizes: capSizesDensity([...(railBeside && layout.phoneSideThumbnails ? MOBILE_SIDE_MAIN_SIZES : MOBILE_MAIN_SIZES), ...desktopMainSizes(layout, railBeside)].join(", ")),
  };
}

/** Thumbnails of the mobile or desktop rail. */
export function productGalleryThumbnailSlot(
  layout: ProductGalleryLayout,
  rail: "mobile" | "desktop",
): ImageSlot {
  const below = layout.thumbnails === "below";
  const sizes = rail === "mobile"
    ? layout.phoneSideThumbnails ? "48px" : "68px"
    : layout.thumbnailSize !== null
      ? `${layout.thumbnailSize}px`
      : below ? "88px" : "(min-width: 1280px) 96px, 76px";
  return { width: GALLERY_IMAGE_WIDTHS.thumbnail, sizes, maxWidth: THUMBNAIL_MAX_WIDTH };
}
