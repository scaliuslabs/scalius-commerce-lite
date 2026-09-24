import { describe, expect, it } from "vitest";
import { MEDIA_VARIANT_WIDTHS } from "@scalius/shared/media-variants";
import { STOREFRONT_PRODUCT_PAGE_SPECS } from "@scalius/shared/storefront-theme";

import {
  GALLERY_IMAGE_WIDTHS,
  productGalleryMainSlot,
  productGalleryThumbnailSlot,
  type ProductGalleryLayout,
} from "./gallery-images";

/** The width a browser takes from `sizes` at a viewport (px, DPR-free). */
function evaluateSizes(sizes: string, viewport: number): number {
  for (const entry of sizes.split(/,\s*(?![^()]*\))/)) {
    const match = /^(?:\((max|min)-width: (\d+)px\)\s+)?(.+)$/.exec(entry.trim());
    if (!match) throw new Error(`Unparsed size: ${entry}`);
    const [, kind, limit, length] = match;
    if (kind === "max" && viewport > Number(limit)) continue;
    if (kind === "min" && viewport < Number(limit)) continue;
    const calc = /^calc\(([\d.]+)vw - (\d+)px\)$/.exec(length!);
    if (calc) return (Number(calc[1]) * viewport) / 100 - Number(calc[2]);
    const vw = /^([\d.]+)vw$/.exec(length!);
    if (vw) return (Number(vw[1]) * viewport) / 100;
    const px = /^(\d+)px$/.exec(length!);
    if (px) return Number(px[1]);
    throw new Error(`Unparsed length: ${length}`);
  }
  throw new Error("No size matched");
}

/**
 * The rendered width of a square photo in the gallery's main slot, straight
 * from the CSS: section gutters, 12-column grid, thumbnail column, and the
 * mobile stage's 24rem height cap.
 */
function renderedMainWidth(
  layout: ProductGalleryLayout,
  hasThumbnails: boolean,
  viewport: number,
): number {
  const railBeside = hasThumbnails && layout.thumbnails === "beside";
  if (viewport < 1024) {
    const content = viewport - 2 * (viewport < 640 ? 12 : 24);
    const rail = railBeside ? Math.min(0.18 * viewport, 80) + 8 : 0;
    return Math.min(content - rail, 384);
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

const layouts = Object.entries(STOREFRONT_PRODUCT_PAGE_SPECS) as Array<
  [string, ProductGalleryLayout]
>;

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

  it("serves a DPR 3 phone a sharp photo and a laptop no more than it shows", () => {
    const { sizes } = productGalleryMainSlot(STOREFRONT_PRODUCT_PAGE_SPECS.gallery, true);
    // 390px phone: ~278 CSS px, i.e. ~834 device px at DPR 3.
    expect(evaluateSizes(sizes, 390) * 3).toBeGreaterThan(800);
    // 1440px desktop: the 468px column, not the viewport.
    expect(evaluateSizes(sizes, 1440)).toBe(468);
  });

  it("sizes thumbnails to their rail and caps their srcset at 320w", () => {
    const beside = STOREFRONT_PRODUCT_PAGE_SPECS.gallery;
    const below = STOREFRONT_PRODUCT_PAGE_SPECS.filmstrip;
    const mobile = productGalleryThumbnailSlot(beside, "mobile");
    expect(evaluateSizes(mobile.sizes, 390)).toBeCloseTo(70.2);
    expect(evaluateSizes(mobile.sizes, 800)).toBe(80);
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
