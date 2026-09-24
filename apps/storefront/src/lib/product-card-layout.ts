import type { ResolvedStorefrontThemeLayout, StorefrontImageRatio } from "@scalius/shared/storefront-theme";

/**
 * The fluid product grid (theme-foundation.css `.product-grid`), modelled in
 * px so image `sizes`, eager-loading and tests use the same numbers as CSS.
 *
 * Columns are `repeat(auto-fill, minmax(min(var(--card-min), 100%), 1fr))`
 * inside a `.product-grid-frame` inline-size container. The density's
 * minimum card width steps phone -> tablet -> desktop with the container
 * width. Hard steps would drop a column at each step (a wider minimum fits
 * fewer cards), so between the steps the minimum and the gap grow linearly
 * with the container (`cqi`): it equals the phone value up to 36rem, the
 * tablet value at 48rem and the desktop value from 60rem. Any minimum of the
 * form `a + b * width` with a >= 0 and b < 1 keeps the column count
 * monotonic with width (tested from 320px to 2560px).
 */

type ThemeGrid = ResolvedStorefrontThemeLayout["grid"];

/**
 * Portrait photos make tall cards: their grid keeps wider minimum cards from
 * the tablet step, so a dense density never packs six portrait cards across
 * a laptop (mix rule 7). Phones keep the density's two columns.
 */
const PORTRAIT_CARD_MIN = { tablet: "12rem", desktop: "15rem" } as const;

/** The grid a store's cards use: the density's, widened for portrait photos. */
export function productGridSpec<Grid extends ThemeGrid>(grid: Grid, imageRatio: StorefrontImageRatio): Grid {
  if (imageRatio !== "portrait") return grid;
  const wider = (value: string, min: string) => (remToPx(value) >= remToPx(min) ? value : min);
  return {
    ...grid,
    cardMin: {
      phone: grid.cardMin.phone,
      tablet: wider(grid.cardMin.tablet, PORTRAIT_CARD_MIN.tablet),
      desktop: wider(grid.cardMin.desktop, PORTRAIT_CARD_MIN.desktop),
    },
  };
}

const PX_PER_REM = 16;
/** Container widths (rem) where the grid's minimum card width steps. */
export const PRODUCT_GRID_STEPS_REM = { tablet: 36, tabletFull: 48, desktop: 60 } as const;
/** The Tailwind page gutters around grids: px-4, sm:px-6, lg:px-8. */
const PAGE_GUTTER_PX = [
  { from: 0, px: 16 },
  { from: 640, px: 24 },
  { from: 1024, px: 32 },
] as const;
/** The catalog filter sidebar (lg:w-80) and its gap (gap-6), from 1024px. */
const FILTER_SIDEBAR_PX = 320 + 24;

function remToPx(value: string): number {
  const match = /^(\d+(?:\.\d+)?)rem$/.exec(value);
  if (!match) throw new Error(`Expected a rem length, got ${value}`);
  return Number(match[1]) * PX_PER_REM;
}

interface Line {
  /** px at container width 0. */
  intercept: number;
  /** px per px of container width. */
  slope: number;
}

function lineThrough(x1: number, y1: number, x2: number, y2: number): Line {
  const slope = (y2 - y1) / (x2 - x1);
  return { intercept: y1 - slope * x1, slope };
}

function gridLines(grid: ThemeGrid) {
  const steps = {
    tablet: PRODUCT_GRID_STEPS_REM.tablet * PX_PER_REM,
    tabletFull: PRODUCT_GRID_STEPS_REM.tabletFull * PX_PER_REM,
    desktop: PRODUCT_GRID_STEPS_REM.desktop * PX_PER_REM,
  };
  const card = {
    phone: remToPx(grid.cardMin.phone),
    tablet: remToPx(grid.cardMin.tablet),
    desktop: remToPx(grid.cardMin.desktop),
  };
  const gap = { phone: remToPx(grid.gap.phone), desktop: remToPx(grid.gap.desktop) };
  const cardLow = lineThrough(steps.tablet, card.phone, steps.tabletFull, card.tablet);
  const cardHigh = lineThrough(steps.tabletFull, card.tablet, steps.desktop, card.desktop);
  return {
    card,
    gap,
    cardLow,
    cardHigh,
    // Concave (slope falls): the lower line wins; convex: the higher one.
    concave: cardLow.slope >= cardHigh.slope,
    gapLine: lineThrough(steps.tablet, gap.phone, steps.desktop, gap.desktop),
  };
}

const at = (line: Line, width: number) => line.intercept + line.slope * width;
const clamp = (min: number, value: number, max: number) => Math.min(Math.max(value, min), max);

/** The minimum card width (px) in a grid container `width` px wide. */
export function productGridCardMin(grid: ThemeGrid, width: number): number {
  const lines = gridLines(grid);
  const between = lines.concave
    ? Math.min(at(lines.cardLow, width), at(lines.cardHigh, width))
    : Math.max(at(lines.cardLow, width), at(lines.cardHigh, width));
  return clamp(lines.card.phone, between, lines.card.desktop);
}

/** The grid gap (px) in a grid container `width` px wide. */
export function productGridGap(grid: ThemeGrid, width: number): number {
  const lines = gridLines(grid);
  return clamp(lines.gap.phone, at(lines.gapLine, width), lines.gap.desktop);
}

/** Columns `auto-fill` creates in a grid container `width` px wide. */
export function productGridColumnCount(grid: ThemeGrid, width: number): number {
  const cardMin = productGridCardMin(grid, width);
  const gap = productGridGap(grid, width);
  return Math.max(1, Math.floor((width + gap) / (cardMin + gap)));
}

const rem = (px: number) => `${Number((px / PX_PER_REM).toFixed(4))}rem`;
const cqi = (slope: number) => `${Number((slope * 100).toFixed(4))}cqi`;
const linear = (line: Line) => `${rem(line.intercept)} + ${cqi(line.slope)}`;

/**
 * The CSS for the fluid minimum card width and gap between the steps
 * (Layout.astro sets these as `--grid-card-min-fluid` / `--grid-gap-fluid`).
 * Built only from the density constants.
 */
export function productGridFluidCss(grid: ThemeGrid): { cardMin: string; gap: string } {
  const lines = gridLines(grid);
  const pick = lines.concave ? "min" : "max";
  return {
    cardMin: `clamp(${grid.cardMin.phone}, ${pick}(${linear(lines.cardLow)}, ${linear(lines.cardHigh)}), ${grid.cardMin.desktop})`,
    gap: `clamp(${grid.gap.phone}, ${linear(lines.gapLine)}, ${grid.gap.desktop})`,
  };
}

export type ProductGridContext = "grid" | "beside-filters" | "rail";
/**
 * How a listing grid lays cards out in a container narrower than the tablet
 * step: the density's columns, or one card per row with the photo beside
 * the text (Amazon, Target, Star Tech phone listings).
 */
export type ProductGridPhoneLayout = "grid" | "list-row";
/** The photo column of a list row (theme-foundation.css `--card-row-media`). */
export const LIST_ROW_MEDIA_PX = 120;

function pageGutter(viewport: number): number {
  return [...PAGE_GUTTER_PX].reverse().find((gutter) => viewport >= gutter.from)!.px;
}

/**
 * The grid container width (px) at a viewport width: the page content (capped
 * by the theme's container width) minus the gutters, minus the filter
 * sidebar beside it from 1024px.
 */
export function productGridWidth(
  viewport: number,
  containerMaxPx: number,
  context: Exclude<ProductGridContext, "rail">,
): number {
  const gutter = pageGutter(viewport);
  const content = Math.min(viewport, containerMaxPx) - 2 * gutter;
  return context === "beside-filters" && viewport >= 1024 ? content - FILTER_SIDEBAR_PX : content;
}

const sizesCache = new Map<string, string>();

/**
 * `sizes` for a product card image. For grids it follows the fluid columns:
 * one media condition per viewport range with the same column count and
 * gutter, each `100vw / columns` minus the gutters and gaps (the widest card
 * of the range), then the fixed width once the container cap is reached.
 * `rail` is the horizontal collection rail (collection2.astro). With the
 * `list-row` phone layout, a grid narrower than the tablet step shows one
 * card per row with a fixed-width photo.
 */
export function productCardImageSizes(
  grid: ThemeGrid,
  containerWidth: string,
  context: ProductGridContext = "grid",
  phoneLayout: ProductGridPhoneLayout = "grid",
): string {
  if (context === "rail") {
    return "(max-width: 639px) 72vw, (max-width: 1023px) 33vw, (max-width: 1279px) 25vw, 20vw";
  }
  const key = `${JSON.stringify(grid)}|${containerWidth}|${context}|${phoneLayout}`;
  const cached = sizesCache.get(key);
  if (cached) return cached;

  const containerMaxPx = remToPx(containerWidth);
  const ranges: Array<{ signature: string; until: number; size: string }> = [];
  for (let viewport = 320; viewport <= containerMaxPx; viewport += 1) {
    const width = productGridWidth(viewport, containerMaxPx, context);
    const rows = phoneLayout === "list-row" && width < PRODUCT_GRID_STEPS_REM.tablet * PX_PER_REM;
    const columns = productGridColumnCount(grid, width);
    const fixed = viewport - width;
    const capped = viewport === containerMaxPx;
    const signature = rows ? "rows" : `${columns}|${fixed}|${capped}`;
    const last = ranges.at(-1);
    if (last?.signature === signature) {
      last.until = viewport;
      continue;
    }
    const gap = productGridGap(grid, width);
    // The first viewport of a range has the smallest gap, so the card width
    // below is the range's widest: an image is never undersized.
    const size = rows
      ? `${LIST_ROW_MEDIA_PX}px`
      : capped
        ? `${Math.ceil((width - gap * (columns - 1)) / columns)}px`
        : `calc(${Number((100 / columns).toFixed(2))}vw - ${Math.floor((fixed + gap * (columns - 1)) / columns)}px)`;
    ranges.push({ signature, until: viewport, size });
  }
  const sizes = ranges
    .map((range, index) => (index === ranges.length - 1 ? range.size : `(max-width: ${range.until}px) ${range.size}`))
    .join(", ");
  sizesCache.set(key, sizes);
  return sizes;
}

export interface ProductCardImageLoading {
  loading: "eager" | "lazy";
  fetchpriority: "high" | "auto";
  decoding: "sync" | "async";
}

/** Cards in a first row on a common laptop (1024px), loaded eagerly. */
export function productGridFirstRow(grid: ThemeGrid, containerWidth: string): number {
  return productGridColumnCount(grid, productGridWidth(1024, remToPx(containerWidth), "grid"));
}

/** Cards that share a phone's first row; one of them is the likely LCP image. */
const HIGH_PRIORITY_CARDS = 2;

/**
 * How a card photo loads. In a list that starts above the fold the first row
 * loads eagerly, and the photos of a phone's first row (two cards, either of
 * which can be the LCP element when the other has no photo) get high
 * priority. Everything else is lazy.
 */
export function productCardImageLoading(
  firstRow: number,
  position: { index?: number; aboveFold?: boolean },
): ProductCardImageLoading {
  const { index, aboveFold = false } = position;
  if (!aboveFold || index === undefined || index >= firstRow) {
    return { loading: "lazy", fetchpriority: "auto", decoding: "async" };
  }
  return index < HIGH_PRIORITY_CARDS
    ? { loading: "eager", fetchpriority: "high", decoding: "sync" }
    : { loading: "eager", fetchpriority: "auto", decoding: "async" };
}
