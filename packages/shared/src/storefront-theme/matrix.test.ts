// The combination matrix (GAP-AND-PLAN 2.1 row 0 and 2.2 point 1): every
// pair of block variants, with every palette and every density, is a valid
// document whose every text pair reaches AA, and resolves to blocks that
// fit on empty, tiny and deep stores.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_STOREFRONT_THEME,
  EMPTY_STORE_SHAPE,
  STOREFRONT_DENSITIES,
  STOREFRONT_HEADER_TONES,
  STOREFRONT_LISTING_FILTER_STYLES,
  STOREFRONT_NAVIGATION_SOURCES,
  STOREFRONT_PRODUCT_STICKY,
  STOREFRONT_THEME_PALETTES,
  STOREFRONT_THEME_PALETTE_KEYS,
  failedFitConditions,
  listStorefrontThemeDocumentContrastProblems,
  resolveStorefrontTheme,
  storeShapeFromFacts,
  storefrontBlockDefault,
  storefrontBlockVariants,
  storefrontThemeDocumentSchema,
  storefrontVariantSpec,
  type StorefrontBlockSlot,
  type StorefrontThemeDocument,
} from "../storefront-theme";

const BLOCK_FACTORS: StorefrontBlockSlot[] = ["topBar", "header", "desktopNav", "mobileNav", "card", "listing", "gallery", "buyBox", "footer"];

/** Each factor and its values: every block slot, each sticky slot, and the header tone. */
const FACTORS: Array<{ name: string; values: readonly string[] }> = [
  ...BLOCK_FACTORS.map((slot) => ({ name: slot, values: storefrontBlockVariants(slot) as string[] })),
  { name: "sticky.phoneTop", values: STOREFRONT_PRODUCT_STICKY.phoneTop },
  { name: "sticky.phoneBottom", values: STOREFRONT_PRODUCT_STICKY.phoneBottom },
  { name: "sticky.desktop", values: STOREFRONT_PRODUCT_STICKY.desktop },
  { name: "headerTone", values: STOREFRONT_HEADER_TONES },
  { name: "filters", values: STOREFRONT_LISTING_FILTER_STYLES },
  { name: "navigation.source", values: STOREFRONT_NAVIGATION_SOURCES },
  { name: "navigation.maxTopItems", values: ["1", "6", "18"] },
];

const pairKey = (a: number, va: string, b: number, vb: string) => `${a}=${va}|${b}=${vb}`;

/**
 * A pairwise covering array, built greedily: each row picks, factor by
 * factor, the value that covers the most pairs not yet covered. Seeded, so
 * the rows are the same on every run.
 */
function pairwiseRows(): string[][] {
  const uncovered = new Set<string>();
  FACTORS.forEach((first, a) => FACTORS.forEach((second, b) => {
    if (b <= a) return;
    for (const va of first.values) for (const vb of second.values) uncovered.add(pairKey(a, va, b, vb));
  }));
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const rows: string[][] = [];
  while (uncovered.size > 0) {
    // Seed the row with one uncovered pair so every row makes progress.
    const [first] = uncovered;
    const [left, right] = first!.split("|") as [string, string];
    const row: Array<string | undefined> = new Array(FACTORS.length).fill(undefined);
    for (const part of [left, right]) {
      const [index, value] = part.split("=") as [string, string];
      row[Number(index)] = value;
    }
    const order = FACTORS.map((_, index) => index).sort(() => random() - 0.5);
    for (const factor of order) {
      if (row[factor] !== undefined) continue;
      let best = FACTORS[factor]!.values[0]!;
      let bestGain = -1;
      for (const value of FACTORS[factor]!.values) {
        let gain = 0;
        row.forEach((other, index) => {
          if (other === undefined || index === factor) return;
          const key = index < factor ? pairKey(index, other, factor, value) : pairKey(factor, value, index, other);
          if (uncovered.has(key)) gain += 1;
        });
        if (gain > bestGain || (gain === bestGain && random() < 0.3)) {
          best = value;
          bestGain = gain;
        }
      }
      row[factor] = best;
    }
    const complete = row as string[];
    complete.forEach((va, a) => complete.forEach((vb, b) => {
      if (b > a) uncovered.delete(pairKey(a, va, b, vb));
    }));
    rows.push(complete);
  }
  return rows;
}

function documentFor(row: string[], palette: keyof typeof STOREFRONT_THEME_PALETTES, density: (typeof STOREFRONT_DENSITIES)[number]): StorefrontThemeDocument {
  const theme = structuredClone(DEFAULT_STOREFRONT_THEME) as StorefrontThemeDocument;
  const value = (name: string) => row[FACTORS.findIndex((factor) => factor.name === name)]!;
  const block = (slot: StorefrontBlockSlot) => storefrontBlockDefault(slot, value(slot)) as never;
  theme.blocks.topBar = block("topBar");
  theme.blocks.header = block("header");
  theme.blocks.desktopNav = block("desktopNav");
  theme.blocks.mobileNav = block("mobileNav");
  theme.blocks.card = block("card");
  theme.blocks.listing.layout = block("listing");
  theme.blocks.product.gallery = block("gallery");
  theme.blocks.product.buyBox = block("buyBox");
  theme.blocks.footer = block("footer");
  theme.blocks.product.sticky = {
    phoneTop: value("sticky.phoneTop"),
    phoneBottom: value("sticky.phoneBottom"),
    desktop: value("sticky.desktop"),
  } as never;
  const style = value("filters") as (typeof STOREFRONT_LISTING_FILTER_STYLES)[number];
  theme.blocks.listing.filters = { style, openByDefault: style.startsWith("sidebar") };
  theme.blocks.navigation = {
    ...theme.blocks.navigation,
    source: value("navigation.source") as (typeof STOREFRONT_NAVIGATION_SOURCES)[number],
    maxTopItems: Number(value("navigation.maxTopItems")),
  };
  theme.tokens = { ...theme.tokens, colors: { ...STOREFRONT_THEME_PALETTES[palette] }, density, headerTone: value("headerTone") as never };
  return theme;
}

const SHAPES = [
  EMPTY_STORE_SHAPE,
  storeShapeFromFacts({ productCount: 20, skuCount: 20, topCategoryCount: 2, categoryDepth: 1, menu: [{}, {}], hasCollections: false, hasDeliveryMethods: true }),
  storeShapeFromFacts({
    productCount: 5000, skuCount: 50_000, topCategoryCount: 18, categoryDepth: 4, categoryGroups: 5,
    menu: Array.from({ length: 12 }, () => ({ subMenu: [{ subMenu: [{}, {}] }, { subMenu: [{}, {}] }] })),
    brandCount: 300, hasCollections: true, hasDeliveryMethods: true, hasKeySpecs: true, hasEmiPlans: true,
    hasDigitalLines: true, hasReviews: true, hasQuestions: true, hasContentBlocks: true,
  }),
];

describe("block variant matrix", () => {
  const rows = pairwiseRows();

  it("covers every pair of block variants", () => {
    const covered = new Set<string>();
    for (const row of rows) {
      row.forEach((va, a) => row.forEach((vb, b) => { if (b > a) covered.add(pairKey(a, va, b, vb)); }));
    }
    let expected = 0;
    FACTORS.forEach((first, a) => FACTORS.forEach((second, b) => { if (b > a) expected += first.values.length * second.values.length; }));
    expect(covered.size).toBe(expected);
    // Far fewer than the full product of choices, but at least the largest pair.
    expect(rows.length).toBeGreaterThanOrEqual(9 * 8);
    expect(rows.length).toBeLessThan(200);
  });

  it("parses, passes AA and resolves every pair with every palette and density", () => {
    let documents = 0;
    for (const row of rows) {
      for (const palette of STOREFRONT_THEME_PALETTE_KEYS) {
        for (const density of STOREFRONT_DENSITIES) {
          const theme = documentFor(row, palette, density);
          const label = `${row.join(" / ")} / ${palette} / ${density}`;
          const result = storefrontThemeDocumentSchema.safeParse(theme);
          expect(result.success ? [] : result.error.issues.map((issue) => issue.message), label).toEqual([]);
          expect(listStorefrontThemeDocumentContrastProblems(theme), label).toEqual([]);
          for (const shape of SHAPES) {
            const resolved = resolveStorefrontTheme(theme, shape);
            expect(resolved.blocks.listing.filters.style, label).toBe(theme.blocks.listing.filters.style);
            expect(resolved.facts.navTopItems, label).toBeLessThanOrEqual(theme.blocks.navigation.maxTopItems);
            const blocks: Record<string, string> = {};
            const chosen = {
              topBar: resolved.blocks.topBar, header: resolved.blocks.header, desktopNav: resolved.blocks.desktopNav,
              mobileNav: resolved.blocks.mobileNav, card: resolved.blocks.card, listing: resolved.blocks.listing.layout,
              gallery: resolved.blocks.product.gallery, buyBox: resolved.blocks.product.buyBox, footer: resolved.blocks.footer,
            };
            for (const slot of BLOCK_FACTORS) {
              expect(failedFitConditions(storefrontVariantSpec(slot, chosen[slot].variant).requires, { facts: resolved.facts, blocks }), label).toEqual([]);
              blocks[slot] = chosen[slot].variant;
            }
            // Two cards across a 360px phone at every density.
            const grid = resolved.layout.grid;
            expect(2 * Number.parseFloat(grid.cardMin.phone) * 16 + Number.parseFloat(grid.gap.phone) * 16).toBeLessThanOrEqual(328);
          }
          documents += 1;
        }
      }
    }
    expect(documents).toBe(rows.length * STOREFRONT_THEME_PALETTE_KEYS.length * STOREFRONT_DENSITIES.length);
  });
});
