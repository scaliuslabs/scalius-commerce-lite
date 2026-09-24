// @vitest-environment node

import { describe, expect, it } from "vitest";

import { requestRuntime } from "./api/runtime";
import { productImageSources, PRODUCT_IMAGE_FALLBACK } from "./product-media";
import { capSizesDensity, responsiveImageSources } from "./responsive-image";

describe("capSizesDensity", () => {
  it("repeats every entry first for DPR 2.5+ screens at 2/3 of the width", () => {
    expect(capSizesDensity("calc(100vw - 2rem)")).toBe(
      "(min-resolution: 2.5dppx) calc((100vw - 2rem) * 0.667), calc(100vw - 2rem)",
    );
    expect(capSizesDensity("(max-width: 407px) calc(100vw - 24px), (max-width: 1023px) 384px, 468px")).toBe([
      "(min-resolution: 2.5dppx) and (max-width: 407px) calc((100vw - 24px) * 0.667)",
      "(min-resolution: 2.5dppx) and (max-width: 1023px) calc((384px) * 0.667)",
      "(min-resolution: 2.5dppx) calc((468px) * 0.667)",
      "(max-width: 407px) calc(100vw - 24px)",
      "(max-width: 1023px) 384px",
      "468px",
    ].join(", "));
  });

  it("keeps compound conditions and nested math intact", () => {
    expect(capSizesDensity("(min-width: 64rem) and (max-width: 80rem) calc(100vw - 4rem), min(50vw, 30rem)")).toBe([
      "(min-resolution: 2.5dppx) and (min-width: 64rem) and (max-width: 80rem) calc((100vw - 4rem) * 0.667)",
      "(min-resolution: 2.5dppx) calc((min(50vw, 30rem)) * 0.667)",
      "(min-width: 64rem) and (max-width: 80rem) calc(100vw - 4rem)",
      "min(50vw, 30rem)",
    ].join(", "));
  });
});

const MASTER = "https://cdn.example.test/media/bag.jpg/1600.webp";
const at = (width: number) => `https://cdn.example.test/media/bag.jpg/${width}.webp`;
const slot = { width: 960, sizes: "(max-width: 1023px) 384px, 468px" };

describe("responsiveImageSources", () => {
  it("serves renditions with the slot's srcset and sizes", () => {
    expect(responsiveImageSources(MASTER, slot)).toEqual({
      src: at(960),
      srcset: [160, 320, 480, 640, 960, 1600]
        .map((width) => `${at(width)} ${width}w`)
        .join(", "),
      sizes: slot.sizes,
    });
  });

  it("drops candidates a small slot can never use", () => {
    expect(
      responsiveImageSources(MASTER, { width: 160, sizes: "80px", maxWidth: 320 }),
    ).toEqual({
      src: at(160),
      srcset: `${at(160)} 160w, ${at(320)} 320w`,
      sizes: "80px",
    });
  });

  it("keeps the master when it is narrower than the slot's cap", () => {
    const small = "https://cdn.example.test/media/icon.png/300.webp";
    expect(
      responsiveImageSources(small, { width: 480, sizes: "80px", maxWidth: 320 }),
    ).toEqual({
      src: small,
      srcset: `https://cdn.example.test/media/icon.png/160.webp 160w, ${small} 300w`,
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
