// @vitest-environment node

import { describe, expect, it } from "vitest";

import { requestRuntime } from "./api/runtime";
import { productImageSources, PRODUCT_IMAGE_FALLBACK } from "./product-media";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { DENSITY_CAP_SCALE, capSizesDensity, responsiveImageSources, scaleSizes } from "./responsive-image";

describe("capSizesDensity", () => {
  it("repeats every entry first for DPR 2.5+ screens at 2/3 of the width", () => {
    expect(capSizesDensity("calc(100vw - 2rem)")).toBe(
      "(min-resolution: 2.5dppx) calc((100vw - 2rem) * 0.666), calc(100vw - 2rem)",
    );
    expect(capSizesDensity("(max-width: 407px) calc(100vw - 24px), (max-width: 1023px) 384px, 468px")).toBe([
      "(min-resolution: 2.5dppx) and (max-width: 407px) calc((100vw - 24px) * 0.666)",
      "(min-resolution: 2.5dppx) and (max-width: 1023px) calc((384px) * 0.666)",
      "(min-resolution: 2.5dppx) calc((468px) * 0.666)",
      "(max-width: 407px) calc(100vw - 24px)",
      "(max-width: 1023px) 384px",
      "468px",
    ].join(", "));
  });

  it("keeps compound conditions and nested math intact", () => {
    expect(capSizesDensity("(min-width: 64rem) and (max-width: 80rem) calc(100vw - 4rem), min(50vw, 30rem)")).toBe([
      "(min-resolution: 2.5dppx) and (min-width: 64rem) and (max-width: 80rem) calc((100vw - 4rem) * 0.666)",
      "(min-resolution: 2.5dppx) calc((min(50vw, 30rem)) * 0.666)",
      "(min-width: 64rem) and (max-width: 80rem) calc(100vw - 4rem)",
      "min(50vw, 30rem)",
    ].join(", "));
  });
});

describe("card photo bytes", () => {
  it("fetches every card photo 120-480 px wide at <= 1.2x its pixels at DPR 1, 2 and 3 (about 2x at DPR 3)", () => {
    const master = "https://cdn.example.test/media/card.jpg/1600.webp";
    const worst: Array<{ width: number; dpr: number; ratio: number }> = [];
    for (let width = 120; width <= 480; width += 1) {
      for (const dpr of [1, 2, 3]) {
        // What a browser asks for: the slot width times its density, DPR
        // 2.5+ screens through the capSizesDensity entries.
        const density = dpr >= 2.5 ? dpr * Number(DENSITY_CAP_SCALE) : dpr;
        const needed = width * density;
        const fetched = Number(/\/(\d+)\.webp$/.exec(mediaImageUrl(master, needed))![1]);
        expect(fetched, `${width}px at DPR ${dpr}`).toBeGreaterThanOrEqual(needed);
        if (fetched / needed > 1.2) worst.push({ width, dpr, ratio: fetched / needed });
        if (dpr === 3) expect(fetched / width, `${width}px at DPR 3`).toBeLessThanOrEqual(2 * 1.2);
      }
    }
    expect(worst).toEqual([]);
  });
});

const MASTER = "https://cdn.example.test/media/bag.jpg/1600.webp";
const at = (width: number) => `https://cdn.example.test/media/bag.jpg/${width}.webp`;
const slot = { width: 960, sizes: "(max-width: 1023px) 384px, 468px" };

describe("responsiveImageSources", () => {
  it("serves renditions with the slot's srcset and sizes", () => {
    expect(responsiveImageSources(MASTER, slot)).toEqual({
      src: at(960),
      srcset: [144, 172, 206, 247, 296, 355, 426, 511, 613, 735, 882, 960, 1600]
        .map((width) => `${at(width)} ${width}w`)
        .join(", "),
      sizes: slot.sizes,
    });
  });

  it("drops candidates a small slot can never use", () => {
    expect(
      responsiveImageSources(MASTER, { width: 160, sizes: "80px", maxWidth: 320 }),
    ).toEqual({
      src: at(172),
      srcset: [144, 172, 206, 247, 296, 355].map((width) => `${at(width)} ${width}w`).join(", "),
      sizes: "80px",
    });
  });

  it("keeps the master when it is narrower than the slot's cap", () => {
    const small = "https://cdn.example.test/media/icon.png/300.webp";
    expect(
      responsiveImageSources(small, { width: 480, sizes: "80px", maxWidth: 320 }),
    ).toEqual({
      src: small,
      srcset: [144, 172, 206, 247, 296].map((width) => `https://cdn.example.test/media/icon.png/${width}.webp ${width}w`).concat(`${small} 300w`).join(", "),
      sizes: "80px",
    });
  });

  it("leaves images without renditions as a plain src", () => {
    const legacy = "https://cdn.example.test/media/legacy.jpg";
    expect(responsiveImageSources(legacy, slot)).toEqual({ src: legacy });
    expect(responsiveImageSources("/placeholder-product.svg", slot)).toEqual({
      src: "/placeholder-product.svg",
    });
  });
});

describe("productImageSources", () => {
  it("resolves the product image against the CDN before picking renditions", () => {
    const sources = requestRuntime.run(
      { CDN_DOMAIN_URL: "cdn.example.test" },
      () => productImageSources("media/bag.jpg/1600.webp", slot),
    );
    expect(sources.src).toBe(at(960));
    expect(sources.srcset).toContain(`${at(1600)} 1600w`);
    expect(sources.sizes).toBe(slot.sizes);
  });

  it("uses the placeholder when the product has no image", () => {
    expect(productImageSources(null, slot)).toEqual({ src: PRODUCT_IMAGE_FALLBACK });
    expect(productImageSources("  ", slot)).toEqual({ src: PRODUCT_IMAGE_FALLBACK });
  });
});

describe("scaleSizes", () => {
  it("shrinks every entry to the share of the slot the photo fills, conditions kept", () => {
    expect(scaleSizes("(max-width: 639px) calc(50vw - 20px), 246px", 0.8)).toBe(
      "(max-width: 639px) calc((50vw - 20px) * 0.8), calc((246px) * 0.8)",
    );
  });

  it("leaves a photo that fills its slot alone", () => {
    expect(scaleSizes("(max-width: 639px) 44vw, 19vw", 1)).toBe("(max-width: 639px) 44vw, 19vw");
    expect(scaleSizes("19vw", 0)).toBe("19vw");
  });
});
