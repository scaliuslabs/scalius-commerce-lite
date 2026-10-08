// @vitest-environment node

import { describe, expect, it } from "vitest";

import { requestRuntime } from "./api/runtime";
import { productImageSources, PRODUCT_IMAGE_FALLBACK } from "./product-media";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { STOREFRONT_DENSITY_SPECS } from "@scalius/shared/storefront-theme";
import { productCardImageSizes } from "./product-card-layout";
import {
  DENSITY_CAP_SCALE,
  PHONE_DENSITY_CAP_MAX_VIEWPORT_PX,
  capImageSrcSet,
  capPhoneSizesDensity,
  capSizesDensity,
  hoverImageSources,
  responsiveImageSources,
  scaleSizes,
} from "./responsive-image";

describe("capSizesDensity", () => {
  it("repeats every entry first for DPR 2.5+ screens at 2/3 of the width", () => {
    expect(capSizesDensity("calc(100vw - 2rem)")).toBe(
      "(min-resolution: 2.5dppx) calc(66.6vw - 1.332rem), calc(100vw - 2rem)",
    );
    expect(capSizesDensity("(max-width: 407px) calc(100vw - 24px), (max-width: 1023px) 384px, 468px")).toBe([
      "(min-resolution: 2.5dppx) and (max-width: 407px) calc(66.6vw - 15.984px)",
      "(min-resolution: 2.5dppx) and (max-width: 1023px) 255.744px",
      "(min-resolution: 2.5dppx) 311.688px",
      "(max-width: 407px) calc(100vw - 24px)",
      "(max-width: 1023px) 384px",
      "468px",
    ].join(", "));
  });

  it("keeps compound conditions and nested math intact", () => {
    expect(capSizesDensity("(min-width: 64rem) and (max-width: 80rem) calc(100vw - 4rem), min(50vw, 30rem)")).toBe([
      "(min-resolution: 2.5dppx) and (min-width: 64rem) and (max-width: 80rem) calc(66.6vw - 2.664rem)",
      "(min-resolution: 2.5dppx) calc((min(50vw, 30rem)) * 0.666)",
      "(min-width: 64rem) and (max-width: 80rem) calc(100vw - 4rem)",
      "min(50vw, 30rem)",
    ].join(", "));
  });

  it("keeps a contained card photo's rendition at every width, with DPR 3 phones capped", () => {
    const base = productCardImageSizes(STOREFRONT_DENSITY_SPECS.compact, "160rem", "beside-filters", "grid", Infinity, 262);
    // What ProductCard asks for with a contained photo: 88% of the slot, phones capped.
    const card = capPhoneSizesDensity(scaleSizes(base, 0.88));
    // The repeated string stays short: the capped copies stop at phones
    // instead of repeating every desktop step.
    const cappedEntries = card.split(", ").filter((entry) => entry.startsWith("(min-resolution: 2.5dppx)"));
    expect(cappedEntries.length).toBeLessThanOrEqual(3);
    expect(cappedEntries.at(-1)).toContain("(max-width: 639px)");
    const widthAt = (sizes: string, viewport: number, dpr: number) => {
      for (const entry of sizes.split(", ")) {
        if (entry.includes("min-resolution: 2.5dppx") && dpr < 2.5) continue;
        const max = /\(max-width: (\d+)px\)/.exec(entry);
        if (max && viewport > Number(max[1])) continue;
        const length = entry.replace(/^(?:\(min-resolution: 2\.5dppx\)(?: and )?)?(?:\(max-width: \d+px\) )?/, "");
        const linear = /^calc\(([\d.]+)vw - ([\d.]+)px\)$/.exec(length);
        return linear ? Number(linear[1]) * viewport / 100 - Number(linear[2]) : Number.parseFloat(length);
      }
      throw new Error("Missing card image size");
    };
    const ladder = [144, 172, 206, 247, 296, 355, 426, 511, 613];
    const step = (width: number) => {
      const index = ladder.findIndex((candidate) => candidate >= width - 1e-6);
      return index < 0 ? ladder.length - 1 : index;
    };
    for (let viewport = 320; viewport <= 2560; viewport++) {
      for (const dpr of [1, 1.25, 1.5, 2, 2.5, 3]) {
        // Phones (to 639px) at DPR 2.5+ ask for about 2x; everything else at its density.
        const capped = dpr >= 2.5 && viewport <= PHONE_DENSITY_CAP_MAX_VIEWPORT_PX;
        const exact = widthAt(base, viewport, dpr) * 0.88 * (capped ? Number(DENSITY_CAP_SCALE) : 1);
        const actual = widthAt(card, viewport, dpr);
        // Never narrower than drawn.
        expect(actual, `${viewport}px at ${dpr} DPR`).toBeGreaterThanOrEqual(exact - 1e-6);
        expect(actual, `${viewport}px at ${dpr} DPR`).toBeCloseTo(exact, 5);
        expect(step(actual * dpr), `${viewport}px at ${dpr} DPR`).toBe(step(exact * dpr));
      }
    }
  });
});

describe("capPhoneSizesDensity", () => {
  it("caps phone density only below the tablet step", () => {
    expect(capPhoneSizesDensity("(max-width: 335px) calc(100vw - 32px), (max-width: 1023px) calc(25vw - 30px), 230px")).toBe([
      "(min-resolution: 2.5dppx) and (max-width: 335px) calc(66.6vw - 21.312px)",
      "(min-resolution: 2.5dppx) and (max-width: 639px) calc(16.65vw - 19.98px)",
      "(max-width: 335px) calc(100vw - 32px)",
      "(max-width: 1023px) calc(25vw - 30px)",
      "230px",
    ].join(", "));
    expect(capPhoneSizesDensity("170px")).toBe("(min-resolution: 2.5dppx) and (max-width: 639px) 113.22px, 170px");
  });

  it("derives a hover photo's sources from its URL and the card's cap", () => {
    const url = "https://cdn.example.test/media/back.jpg/1600.webp";
    const hover = hoverImageSources(url, 400);
    expect(hover.src).toBe("https://cdn.example.test/media/back.jpg/511.webp");
    expect(hover.srcset!.endsWith("https://cdn.example.test/media/back.jpg/426.webp 426w")).toBe(true);
    expect(hoverImageSources("https://images.example.test/back.jpg")).toEqual({ src: "https://images.example.test/back.jpg", srcset: undefined });
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
  it("keeps the first rendition that covers a card's largest source width", () => {
    const full = responsiveImageSources(MASTER, slot).srcset!;
    const capped = capImageSrcSet(full, 820)!;
    expect(capped.endsWith(`${at(882)} 882w`)).toBe(true);
    expect(capped).not.toContain(at(960));
    expect(capImageSrcSet(undefined, 820)).toBeUndefined();
  });

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
      "(max-width: 639px) calc(40vw - 16px), 196.8px",
    );
  });

  it("leaves a photo that fills its slot alone", () => {
    expect(scaleSizes("(max-width: 639px) 44vw, 19vw", 1)).toBe("(max-width: 639px) 44vw, 19vw");
    expect(scaleSizes("19vw", 0)).toBe("19vw");
  });
});
