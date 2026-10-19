import { describe, expect, it } from "vitest";
import { MEDIA_VARIANT_WIDTHS } from "@scalius/shared/media-variants";
import { STOREFRONT_GALLERY_VARIANTS } from "@scalius/shared/storefront-theme";

import {
  GALLERY_IMAGE_WIDTHS,
  GALLERY_STAGE_RATIO_BOUNDS,
  boundedStageRatio,
  productGalleryMainSlot,
  galleryStageRatio,
  productGalleryThumbnailSlot,
  type ProductGalleryLayout,
} from "./gallery-images";

/** A `sizes` length at a viewport, in CSS px. */
function evaluateLength(length: string, viewport: number): number {
  const scaled = /^calc\(\((.+)\) \* ([\d.]+)\)$/.exec(length);
  if (scaled) return evaluateLength(scaled[1]!, viewport) * Number(scaled[2]);
  const expression = /^calc\((.+)\)$/.exec(length)?.[1] ?? length;
  const difference = /^([\d.]+)vw - ([\d.]+)px$/.exec(expression);
  if (difference) return (Number(difference[1]) * viewport) / 100 - Number(difference[2]);
  const vw = /^([\d.]+)vw$/.exec(expression);
  if (vw) return (Number(vw[1]) * viewport) / 100;
  const px = /^([\d.]+)px$/.exec(expression);
  if (px) return Number(px[1]);
  throw new Error(`Unparsed length: ${length}`);
}

/** The width a browser takes from `sizes` at a viewport and device pixel ratio. */
function evaluateSizes(sizes: string, viewport: number, dppx = 1): number {
  for (const raw of sizes.split(/,\s*(?![^()]*\))/)) {
    let entry = raw.trim();
    const density = /^\(min-resolution: ([\d.]+)dppx\)(?: and )?\s*/.exec(entry);
    if (density) {
      if (dppx < Number(density[1])) continue;
      entry = entry.slice(density[0].length);
    }
    const match = /^(?:\((max|min)-width: (\d+)px\)\s+)?(.+)$/.exec(entry);
    if (!match) throw new Error(`Unparsed size: ${entry}`);
    const [, kind, limit, length] = match;
    if (kind === "max" && viewport > Number(limit)) continue;
    if (kind === "min" && viewport < Number(limit)) continue;
    return evaluateLength(length!, viewport);
  }
  throw new Error("No size matched");
}

/**
 * The rendered width of a square photo in the gallery's main slot, straight
 * from the CSS: section gutters, 12-column grid, thumbnail column, and the
 * mobile stage's 24rem height cap. A phone side rail takes 56px from the row.
 */
function renderedMainWidth(
  layout: ProductGalleryLayout,
  hasThumbnails: boolean,
  viewport: number,
): number {
  const railBeside = hasThumbnails && layout.thumbnails === "beside";
  if (viewport < 1024) {
    const content = viewport - 2 * (viewport < 640 ? 12 : 24);
    return Math.min(content - (railBeside && layout.phoneSideThumbnails ? 56 : 0), 384);
  }
  const content = Math.min(viewport, 1280) - 64;
  const column = (content - 11 * 40) / 12;
  const xl = viewport >= 1280;
  if (layout.gallery === "stacked") return content - 345 - 40;
  if (layout.gallery === "grid") return (content - (xl ? 480 : 400) - 40 - 8) / 2;
  const span = xl ? 6 * column + 5 * 40 : 7 * column + 6 * 40;
  // ProductGallery's CSS cap (--gallery-portrait-max) is this same number.
  const galleryWidth = span;
  if (!railBeside) return galleryWidth;
  return galleryWidth - (layout.thumbnailSize === null ? (xl ? 100 : 80) + 20 : layout.thumbnailSize + 12);
}

/** What each gallery variant renders with today's gallery (classic, thumbnails below, stacked). */
const GALLERY = Object.fromEntries(
  Object.entries(STOREFRONT_GALLERY_VARIANTS).map(([id, spec]) => [id, spec.renders({} as never) as ProductGalleryLayout]),
) as Record<keyof typeof STOREFRONT_GALLERY_VARIANTS, ProductGalleryLayout>;
const layouts = Object.entries(GALLERY);

describe("product gallery image slots", () => {
  it("maps every slot onto a pre-generated rendition width", () => {
    for (const width of Object.values(GALLERY_IMAGE_WIDTHS)) {
      expect(MEDIA_VARIANT_WIDTHS).toContain(width);
    }
  });

  for (const [name, layout] of layouts) {
    for (const hasThumbnails of [true, false]) {
      it(`sizes the ${name} main photo to its slot (${hasThumbnails ? "with" : "without"} thumbnails)`, () => {
        const { sizes } = productGalleryMainSlot(layout, hasThumbnails);
        for (let viewport = 320; viewport <= 1920; viewport += 1) {
          const size = evaluateSizes(sizes, viewport);
          const rendered = renderedMainWidth(layout, hasThumbnails, viewport);
          // Never undersized (blurry), at most a couple of px oversized.
          expect(size, `${viewport}px`).toBeGreaterThanOrEqual(rendered - 0.01);
          expect(size, `${viewport}px`).toBeLessThanOrEqual(rendered + 2);
        }
      });
    }
  }

  it("serves a DPR 2 phone its full density, a DPR 3 phone about 2x, and a laptop no more than it shows", () => {
    const { sizes } = productGalleryMainSlot(GALLERY.classic, true);
    // 390px phone: the full 366px row (thumbnails in a strip below).
    expect(evaluateSizes(sizes, 390, 2)).toBe(366);
    // DPR 3 asks for ~2x pixels (~730 device px: the 960w rendition, not 1600w).
    const dpr3 = evaluateSizes(sizes, 390, 3) * 3;
    expect(dpr3).toBeGreaterThan(2 * 366 - 5);
    expect(dpr3).toBeLessThan(960);
    // 1440px desktop: the 468px column, not the viewport.
    expect(evaluateSizes(sizes, 1440)).toBe(468);
  });

  it("never narrows a tall stage: the portrait gallery fills its column like the others", () => {
    const { sizes } = productGalleryMainSlot(GALLERY.portrait, true);
    expect(evaluateSizes(sizes, 390)).toBe(366);
    expect(evaluateSizes(sizes, 1440)).toBeGreaterThan(404);
  });

  it("adapts the stage to the first photo's stored ratio, within bounds, unless the variant states its own", () => {
    // A square photo in a portrait-ratio theme (Noor) gets a square stage: no bands.
    expect(galleryStageRatio(GALLERY.classic, "portrait", 1)).toBe(1);
    expect(galleryStageRatio(GALLERY.stacked, "portrait", 1)).toBe(1);
    expect(galleryStageRatio(GALLERY.classic, "square", 0.8)).toBe(0.8);
    expect(galleryStageRatio(GALLERY.classic, "square", 1.5)).toBe(1.5);
    // A very tall or very wide photo sits in the nearest bound, uncropped.
    expect(galleryStageRatio(GALLERY.classic, "square", 0.3)).toBe(boundedStageRatio(GALLERY_STAGE_RATIO_BOUNDS.min));
    expect(galleryStageRatio(GALLERY.classic, "square", 4)).toBe(boundedStageRatio(GALLERY_STAGE_RATIO_BOUNDS.max));
    expect(boundedStageRatio(4 / 3)).toBe(1.3333);
    // The portrait gallery is an explicit stage.
    expect(galleryStageRatio(GALLERY.portrait, "square", 1)).toBe(0.75);
  });

  it("falls back to the theme's photo ratio only for a photo of unknown size", () => {
    expect(galleryStageRatio(GALLERY.classic, "portrait")).toBe(0.75);
    expect(galleryStageRatio(GALLERY.classic, "landscape", null)).toBeCloseTo(4 / 3);
    expect(galleryStageRatio(GALLERY.classic, "square", Number.NaN)).toBe(1);
    expect(galleryStageRatio(GALLERY.portrait, "square")).toBe(0.75);
  });

  it("gives both rails one thumbnail slot sized to the visible rail, capped at 296w", () => {
    const beside = productGalleryThumbnailSlot(GALLERY.classic);
    const below = productGalleryThumbnailSlot(GALLERY["thumbs-below"]);
    // Phones and tablets: a strip of 68px thumbnails in every layout.
    expect(evaluateSizes(beside.sizes, 390)).toBe(68);
    expect(evaluateSizes(beside.sizes, 800)).toBe(68);
    // Computers: the rail beside the photo, or the strip below it.
    expect(evaluateSizes(beside.sizes, 1100)).toBe(76);
    expect(evaluateSizes(beside.sizes, 1440)).toBe(96);
    expect(evaluateSizes(below.sizes, 390)).toBe(68);
    expect(evaluateSizes(below.sizes, 1440)).toBe(88);
    for (const slot of [beside, below]) {
      expect(slot.width).toBe(144);
      expect(slot.maxWidth).toBe(296);
    }
  });

  it("sizes the Daily Essentials phone side rail and image without changing marketplace phones", () => {
    const side = STOREFRONT_GALLERY_VARIANTS["thumbs-left"].renders({ phoneSideThumbnails: true });
    const marketplace = GALLERY["thumbs-left"];
    expect(evaluateSizes(productGalleryMainSlot(side, true).sizes, 390)).toBe(310);
    expect(evaluateSizes(productGalleryThumbnailSlot(side).sizes, 390)).toBe(48);
    expect(evaluateSizes(productGalleryMainSlot(marketplace, true).sizes, 390)).toBe(366);
    expect(evaluateSizes(productGalleryThumbnailSlot(marketplace).sizes, 390)).toBe(68);
  });
});
