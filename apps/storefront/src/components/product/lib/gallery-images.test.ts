import { describe, expect, it } from "vitest";
import { MEDIA_VARIANT_WIDTHS } from "@scalius/shared/media-variants";
import { STOREFRONT_GALLERY_VARIANTS } from "@scalius/shared/storefront-theme";

import {
  GALLERY_IMAGE_WIDTHS,
  productGalleryMainSlot,
  productGalleryThumbnailSlot,
  type ProductGalleryLayout,
} from "./gallery-images";

/** A `sizes` length at a viewport, in CSS px. */
function evaluateLength(length: string, viewport: number): number {
  const scaled = /^calc\(\((.+)\) \* ([\d.]+)\)$/.exec(length);
  if (scaled) return evaluateLength(scaled[1]!, viewport) * Number(scaled[2]);
  const expression = /^calc\((.+)\)$/.exec(length)?.[1] ?? length;
  const difference = /^([\d.]+)vw - (\d+)px$/.exec(expression);
  if (difference) return (Number(difference[1]) * viewport) / 100 - Number(difference[2]);
  const vw = /^([\d.]+)vw$/.exec(expression);
  if (vw) return (Number(vw[1]) * viewport) / 100;
  const px = /^(\d+)px$/.exec(expression);
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
 * mobile stage's 24rem height cap. Below 1024px the thumbnails always sit in
 * a strip under the photo, so the photo spans the row.
 */
function renderedMainWidth(
  layout: ProductGalleryLayout,
  hasThumbnails: boolean,
  viewport: number,
): number {
  const railBeside = hasThumbnails && layout.thumbnails === "beside";
  if (viewport < 1024) {
    const content = viewport - 2 * (viewport < 640 ? 12 : 24);
    return Math.min(content, 384);
  }
  const content = Math.min(viewport, 1280) - 64;
  const column = (content - 11 * 40) / 12;
  const xl = viewport >= 1280;
  const span =
    layout.gallery === "stacked"
      ? Math.min(content, 576)
      : xl
        ? 6 * column + 5 * 40
        : 7 * column + 6 * 40;
  return span - (railBeside ? (xl ? 100 : 80) + 20 : 0);
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

  it("sizes thumbnails to their rail and caps their srcset at 320w", () => {
    const beside = GALLERY.classic;
    const below = GALLERY["thumbs-below"];
    // Phones and tablets: a strip of 68px thumbnails in every layout.
    const mobile = productGalleryThumbnailSlot(beside, "mobile");
    expect(evaluateSizes(mobile.sizes, 390)).toBe(68);
    expect(evaluateSizes(mobile.sizes, 800)).toBe(68);
    const desktop = productGalleryThumbnailSlot(beside, "desktop");
    expect(evaluateSizes(desktop.sizes, 1100)).toBe(76);
    expect(evaluateSizes(desktop.sizes, 1440)).toBe(96);
    expect(evaluateSizes(productGalleryThumbnailSlot(below, "mobile").sizes, 390)).toBe(68);
    expect(evaluateSizes(productGalleryThumbnailSlot(below, "desktop").sizes, 1440)).toBe(88);
    for (const slot of [mobile, desktop]) {
      expect(slot.width).toBe(160);
      expect(slot.maxWidth).toBe(320);
    }
  });
});
