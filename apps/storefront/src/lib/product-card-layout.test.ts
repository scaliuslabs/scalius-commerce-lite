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
  FILTER_COLUMN_GAP_PX,
  LIST_ROW_MEDIA_PX,
  listingFilterColumnPx,
  PRODUCT_GRID_STEPS_REM,
  productGridSpec,
  productCardImageLoading,
  productCardImageMaxCssWidth,
  productCardImageSizes,
  productGridCardMin,
  productGridColumnCount,
  productGridFluidCss,
  productGridGap,
  productGridWidth,
} from "./product-card-layout";

const css = readFileSync(new URL("../styles/theme-foundation.css", import.meta.url), "utf8");
const cardCss = readFileSync(new URL("../components/cards/product-card.css", import.meta.url), "utf8");
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
    // List rows switch at the same step, with the photo column sizes use.
    expect(cardCss).toContain(`@container product-grid (width < ${PRODUCT_GRID_STEPS_REM.tablet}rem)`);
    expect(cardCss).toContain(`--card-row-media: ${LIST_ROW_MEDIA_PX / 16}rem`);
  });

  it("keeps card styles out of the shared foundation", () => {
    expect(css).not.toMatch(/\.product-card-|card-row-media|\[data-theme-card-style/);
    const card = readFileSync(new URL("../components/cards/ProductCard.astro", import.meta.url), "utf8");
    expect(card).toContain('import "./product-card.css";');
  });

  it("keeps cards stable and touchable from CSS alone", () => {
    // The photo box has the token ratio before any photo loads (CLS 0), and
    // a missing photo fills that same box.
    expect(cardCss).toMatch(/\.product-card-media \{[^}]*aspect-ratio: var\(--theme-image-ratio, 1 \/ 1\);/);
    expect(cardCss).toMatch(/\.product-card-placeholder \{\s*position: absolute;\s*inset: 0;/);
    // Quick add keeps a 44px target; the full action is the system button (44px on touch screens).
    expect(cardCss).toMatch(/\.product-card-quick \{[^}]*inline-size: 2\.75rem;\s*block-size: 2\.75rem;/);
    // Card corners follow the radius token.
    expect(cardCss).toMatch(/\.site-root \.product-card \{[^}]*border-radius: var\(--radius\);/);
    // Titles are two lines with both reserved, and long words break inside the card.
    expect(cardCss).toMatch(/\.product-card-name \{[^}]*min-block-size: calc\(2em \* 1\.35\);/);
    expect(cardCss).toMatch(/\.product-card-name \{[^}]*-webkit-line-clamp: 2;/);
    expect(cardCss).toMatch(/\.product-card-link \{[^}]*overflow-wrap: anywhere;/);
    // Equal heights: the card fills its grid cell and the price and action sit at the bottom.
    expect(cardCss).toMatch(/\.site-root \.product-card \{[^}]*block-size: 100%;/);
    expect(cardCss).toMatch(/\.product-card-foot \{[^}]*margin-block-start: auto;/);
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

  it.each(DENSITIES)("%s: a grid capped at N columns asks for its wider cards", (_density, grid) => {
    for (const containerWidth of CONTAINER_WIDTHS) {
      for (const maxColumns of [2, 3, 4, 5]) {
        const sizes = productCardImageSizes(grid, containerWidth, "grid", "grid", maxColumns);
        for (let viewport = 360; viewport <= 1920; viewport += 7) {
          const width = productGridWidth(viewport, px(containerWidth), "grid");
          const columns = productGridColumnCount(grid, width, maxColumns);
          expect(columns).toBeLessThanOrEqual(maxColumns);
          const card = (width - productGridGap(grid, width) * (columns - 1)) / columns;
          const declared = evaluateSizes(sizes, viewport);
          expect(declared, `${viewport}px ${containerWidth} max ${maxColumns}`).toBeGreaterThanOrEqual(card - 0.5);
          expect(declared, `${viewport}px ${containerWidth} max ${maxColumns}`).toBeLessThanOrEqual(card * 1.35 + 1);
        }
      }
    }
    // Uncapped grids keep their sizes.
    expect(productCardImageSizes(grid, "90rem", "grid", "grid", 12)).toBe(productCardImageSizes(grid, "90rem"));
  });

  it.each(DENSITIES)("%s: list rows ask for the row photo on phones and the grid card above", (_density, grid) => {
    for (const containerWidth of CONTAINER_WIDTHS) {
      const sizes = productCardImageSizes(grid, containerWidth, "beside-filters", "list-row");
      expect(sizes).toMatch(new RegExp(`^\\(max-width: \\d+px\\) ${LIST_ROW_MEDIA_PX}px, `));
      for (let viewport = 320; viewport <= 1920; viewport += 7) {
        const width = productGridWidth(viewport, px(containerWidth), "beside-filters");
        const declared = evaluateSizes(sizes, viewport);
        if (width < PRODUCT_GRID_STEPS_REM.tablet * 16) {
          expect(declared, `${viewport}px`).toBe(LIST_ROW_MEDIA_PX);
        } else {
          expect(declared, `${viewport}px`).toBe(evaluateSizes(productCardImageSizes(grid, containerWidth, "beside-filters"), viewport));
        }
      }
    }
  });

  it("takes the filter column from the listing's filter style", () => {
    expect(listingFilterColumnPx({ style: "sidebar-dense" })).toBe(240);
    expect(listingFilterColumnPx({ style: "sidebar-comfortable" })).toBe(270);
    // A template's own column wins over the style's (Daraz 190, Star Tech 225).
    expect(listingFilterColumnPx({ style: "sidebar-dense", column: 190 })).toBe(190);
    expect(listingFilterColumnPx({ style: "sidebar-dense", column: null })).toBe(240);
    // The resolved spec carries the template override (marketplace 190).
    expect(listingFilterColumnPx({ style: "sidebar-dense", spec: { column: 190 } })).toBe(190);
    expect(listingFilterColumnPx({ style: "sidebar-comfortable", spec: { column: 316 }, column: 999 })).toBe(316);
    expect(listingFilterColumnPx({ style: "bar-dropdowns", column: 300 })).toBe(0);
    expect(listingFilterColumnPx({ style: "drawer" })).toBe(0);
    expect(listingFilterColumnPx(null)).toBe(0);
    const containerMax = px("90rem");
    // From 1024px the grid loses the column and its 24px gap; below, it is page wide.
    expect(productGridWidth(1440, containerMax, "beside-filters", 240)).toBe(productGridWidth(1440, containerMax, "grid") - 240 - FILTER_COLUMN_GAP_PX);
    expect(productGridWidth(1440, containerMax, "beside-filters", 270)).toBe(productGridWidth(1440, containerMax, "grid") - 270 - FILTER_COLUMN_GAP_PX);
    expect(productGridWidth(1000, containerMax, "beside-filters", 240)).toBe(productGridWidth(1000, containerMax, "grid"));
    // Without a sidebar the helper sizes the page-wide grid.
    expect(productGridWidth(1440, containerMax, "beside-filters")).toBe(productGridWidth(1440, containerMax, "grid"));
    const grid = STOREFRONT_DENSITY_SPECS.compact;
    const dense = productCardImageSizes(grid, "90rem", "beside-filters", "grid", Infinity, 240);
    const comfortable = productCardImageSizes(grid, "90rem", "beside-filters", "grid", Infinity, 270);
    expect(dense).not.toBe(comfortable);
    for (let viewport = 1024; viewport <= 1920; viewport += 11) {
      const width = productGridWidth(viewport, containerMax, "beside-filters", 240);
      const columns = productGridColumnCount(grid, width);
      // The declared width is never smaller than the card the browser lays out.
      expect(evaluateSizes(dense, viewport), `${viewport}px`).toBeGreaterThanOrEqual(
        Math.floor((width - productGridGap(grid, width) * (columns - 1)) / columns) - 1,
      );
    }
  });

  it("sizes rail cards by the rail's card width", () => {
    expect(productCardImageSizes(STOREFRONT_DENSITY_SPECS.compact, "90rem", "rail")).toBe(
      "(max-width: 639px) 72vw, (max-width: 1023px) 33vw, (max-width: 1279px) 25vw, min(20vw, 256px)",
    );
  });

  it("caps sources above every declared card width", () => {
    for (const grid of Object.values(STOREFRONT_DENSITY_SPECS)) {
      for (const context of ["grid", "beside-filters", "rail", "shelf"] as const) {
        const sizes = productCardImageSizes(grid, "90rem", context);
        const max = productCardImageMaxCssWidth(grid, "90rem", context);
        for (let viewport = 320; viewport <= 2560; viewport += 7) {
          expect(max, `${context} ${viewport}px`).toBeGreaterThanOrEqual(evaluateSizes(sizes, viewport) - 0.01);
        }
      }
    }
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
    const min = /^min\(([\d.]+)vw, (\d+)px\)$/.exec(value);
    if (min) return Math.min(Number(min[1]) / 100 * viewport, Number(min[2]));
    if (value.endsWith("vw")) return Number.parseFloat(value) / 100 * viewport;
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
