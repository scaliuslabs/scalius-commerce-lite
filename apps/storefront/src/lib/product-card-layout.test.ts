// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_STOREFRONT_THEME,
  STOREFRONT_CONTAINERS,
  STOREFRONT_DENSITY_SPECS,
  buildStorefrontThemeTokens,
} from "@scalius/shared/storefront-theme";
import {
  PRODUCT_GRID_STEPS_REM,
  productCardImageLoading,
  productCardImageSizes,
  productGridCardMin,
  productGridColumnCount,
  productGridFluidCss,
  productGridGap,
  productGridWidth,
} from "./product-card-layout";

const css = readFileSync(new URL("../styles/theme-foundation.css", import.meta.url), "utf8");
const DENSITIES = Object.entries(STOREFRONT_DENSITY_SPECS);
const CONTAINER_WIDTHS = STOREFRONT_CONTAINERS.map((container) =>
  buildStorefrontThemeTokens({ tokens: { ...DEFAULT_STOREFRONT_THEME.tokens, container } })["theme-container-width"]!);
const px = (rem: string) => Number.parseFloat(rem) * 16;

describe("fluid product grid", () => {
  it("steps the minimum card width at the container widths the CSS queries", () => {
    expect(css).toContain(`@container product-grid (min-width: ${PRODUCT_GRID_STEPS_REM.tablet}rem)`);
    expect(css).toContain(`@container product-grid (min-width: ${PRODUCT_GRID_STEPS_REM.desktop}rem)`);
    expect(css).toContain("repeat(auto-fill, minmax(min(var(--card-min), 100%), 1fr))");
    expect(css).toContain("container: product-grid / inline-size");
  });

  it.each(DENSITIES)("%s: reaches each density step value at its container width", (_density, grid) => {
    const { tablet, tabletFull, desktop } = PRODUCT_GRID_STEPS_REM;
    expect(productGridCardMin(grid, 360)).toBe(px(grid.cardMin.phone));
    expect(productGridCardMin(grid, tablet * 16)).toBeCloseTo(px(grid.cardMin.phone));
    expect(productGridCardMin(grid, tabletFull * 16)).toBeCloseTo(px(grid.cardMin.tablet));
    expect(productGridCardMin(grid, desktop * 16)).toBeCloseTo(px(grid.cardMin.desktop));
    expect(productGridCardMin(grid, 1800)).toBe(px(grid.cardMin.desktop));
    expect(productGridGap(grid, 360)).toBe(px(grid.gap.phone));
    expect(productGridGap(grid, 1800)).toBe(px(grid.gap.desktop));
  });

  it.each(DENSITIES)("%s: two columns on every phone, more columns only ever with more width", (_density, grid) => {
    for (const containerWidth of CONTAINER_WIDTHS) {
      for (const context of ["grid", "beside-filters"] as const) {
        let previous = 0;
        for (let viewport = 320; viewport <= 2560; viewport += 1) {
          // The filter sidebar taking 22rem at 1024px is the one place a
          // catalog grid loses room; it grows monotonically again from there.
          if (context === "beside-filters" && viewport === 1024) previous = 0;
          const columns = productGridColumnCount(grid, productGridWidth(viewport, px(containerWidth), context));
          expect(columns, `${viewport}px ${containerWidth} ${context}`).toBeGreaterThanOrEqual(previous);
          if (viewport >= 360 && viewport <= 430) expect(columns, `${viewport}px`).toBe(2);
          previous = columns;
        }
      }
    }
  });

  it("emits the fluid steps as CSS built only from the density constants", () => {
    expect(productGridFluidCss(STOREFRONT_DENSITY_SPECS.compact)).toEqual({
      cardMin: "clamp(9.25rem, min(4rem + 14.5833cqi, 5rem + 12.5cqi), 12.5rem)",
      gap: "clamp(0.5rem, -0.25rem + 2.0833cqi, 1rem)",
    });
    expect(productGridFluidCss(STOREFRONT_DENSITY_SPECS.comfortable)).toEqual({
      cardMin: "clamp(9.75rem, min(0rem + 27.0833cqi, 5rem + 16.6667cqi), 15rem)",
      gap: "clamp(0.75rem, -0.375rem + 3.125cqi, 1.5rem)",
    });
  });
});

describe("productCardImageSizes", () => {
  it("follows the fluid columns up to the container cap", () => {
    expect(productCardImageSizes(STOREFRONT_DENSITY_SPECS.comfortable, "90rem")).toBe(
      "(max-width: 355px) calc(100vw - 32px), (max-width: 523px) calc(50vw - 22px), " +
        "(max-width: 639px) calc(33.33vw - 18px), (max-width: 1023px) calc(33.33vw - 24px), " +
        "(max-width: 1095px) calc(33.33vw - 37px), (max-width: 1359px) calc(25vw - 34px), " +
        "(max-width: 1439px) calc(20vw - 32px), 256px",
    );
  });

  it.each(DENSITIES)("%s: never undersizes a card image", (_density, grid) => {
    for (const containerWidth of CONTAINER_WIDTHS) {
      for (const context of ["grid", "beside-filters"] as const) {
        const sizes = productCardImageSizes(grid, containerWidth, context);
        for (let viewport = 360; viewport <= 1920; viewport += 7) {
          const width = productGridWidth(viewport, px(containerWidth), context);
          const columns = productGridColumnCount(grid, width);
          const card = (width - productGridGap(grid, width) * (columns - 1)) / columns;
          const declared = evaluateSizes(sizes, viewport);
          expect(declared, `${viewport}px ${containerWidth} ${context}`).toBeGreaterThanOrEqual(card - 0.5);
          // ...and never asks for much more than the card needs.
          expect(declared, `${viewport}px ${containerWidth} ${context}`).toBeLessThanOrEqual(card * 1.35 + 1);
        }
      }
    }
  });

  it("sizes rail cards by the rail's card width", () => {
    expect(productCardImageSizes(STOREFRONT_DENSITY_SPECS.compact, "90rem", "rail")).toBe(
      "(max-width: 639px) 72vw, (max-width: 1023px) 33vw, (max-width: 1279px) 25vw, 20vw",
    );
  });
});

/** The px width a `sizes` value declares at a viewport width. */
function evaluateSizes(sizes: string, viewport: number): number {
  for (const entry of sizes.split(/,\s(?![^()]*\))/)) {
    const match = /^(?:\(max-width: (\d+)px\) )?(.+)$/.exec(entry)!;
    if (match[1] && viewport > Number(match[1])) continue;
    const value = match[2]!;
    const calc = /^calc\(([\d.]+)vw - (\d+)px\)$/.exec(value);
    if (calc) return (Number(calc[1]) / 100) * viewport - Number(calc[2]);
    return Number.parseFloat(value);
  }
  throw new Error(`No sizes entry matched ${viewport}px`);
}

describe("productCardImageLoading", () => {
  it("loads the first row of an above-the-fold list eagerly, a phone row's photos first", () => {
    for (const index of [0, 1]) {
      expect(productCardImageLoading(4, { index, aboveFold: true })).toEqual({
        loading: "eager",
        fetchpriority: "high",
        decoding: "sync",
      });
    }
    expect(productCardImageLoading(4, { index: 3, aboveFold: true })).toEqual({
      loading: "eager",
      fetchpriority: "auto",
      decoding: "async",
    });
    expect(productCardImageLoading(4, { index: 4, aboveFold: true }).loading).toBe("lazy");
  });

  it("keeps lists below the fold lazy", () => {
    expect(productCardImageLoading(4, { index: 0 })).toEqual({
      loading: "lazy",
      fetchpriority: "auto",
      decoding: "async",
    });
    expect(productCardImageLoading(4, { aboveFold: true }).loading).toBe("lazy");
  });
});
