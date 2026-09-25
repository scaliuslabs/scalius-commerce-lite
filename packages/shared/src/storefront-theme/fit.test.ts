import { describe, expect, it } from "vitest";
import {
  DEFAULT_STOREFRONT_THEME,
  EMPTY_STORE_SHAPE,
  STOREFRONT_BLOCK_SLOTS,
  STOREFRONT_TEMPLATES,
  failedFitConditions,
  resolveStorefrontTheme,
  storeShapeFromFacts,
  storeShapeSchema,
  storefrontBlockValue,
  storefrontTemplateTheme,
  storefrontVariantSpec,
  type ResolvedStorefrontTheme,
  type StoreShape,
  type StorefrontThemeDocument,
} from "../storefront-theme";

/** GAP-AND-PLAN 2.2 fixtures: a 20-product shop and a 50,000-SKU catalogue. */
const TINY: StoreShape = storeShapeFromFacts({
  productCount: 20,
  skuCount: 26,
  topCategoryCount: 2,
  categoryDepth: 1,
  menu: [{ subMenu: [] }, { subMenu: [] }, {}],
  hasCollections: false,
  hasDeliveryMethods: true,
});

const menu = (top: number, children: number, grandchildren: number) =>
  Array.from({ length: top }, () => ({
    subMenu: Array.from({ length: children }, () => ({ subMenu: Array.from({ length: grandchildren }, () => ({})) })),
  }));

const DEEP: StoreShape = storeShapeFromFacts({
  productCount: 12_000,
  skuCount: 50_000,
  topCategoryCount: 18,
  categoryDepth: 3,
  categoryGroups: 6,
  menu: menu(12, 6, 8),
  brandCount: 300,
  hasCollections: true,
  hasDeliveryMethods: true,
  hasKeySpecs: true,
  hasEmiPlans: true,
  hasDigitalLines: true,
  hasReviews: true,
  hasQuestions: true,
  hasContentBlocks: true,
});

const SHAPES = { empty: EMPTY_STORE_SHAPE, tiny: TINY, deep: DEEP };

function withBlock(theme: StorefrontThemeDocument, path: (blocks: StorefrontThemeDocument["blocks"]) => void) {
  const next = structuredClone(theme);
  path(next.blocks);
  return next;
}

/** Every block that renders fits the store it renders on (judged on the resolver's own facts). */
function assertEverythingFits(resolved: ResolvedStorefrontTheme, shape: StoreShape) {
  expect(resolved.facts).toMatchObject(shape);
  const blocks: Record<string, string> = {};
  const values = {
    topBar: resolved.blocks.topBar,
    header: resolved.blocks.header,
    desktopNav: resolved.blocks.desktopNav,
    mobileNav: resolved.blocks.mobileNav,
    card: resolved.blocks.card,
    listing: resolved.blocks.listing.layout,
    gallery: resolved.blocks.product.gallery,
    buyBox: resolved.blocks.product.buyBox,
    footer: resolved.blocks.footer,
  };
  for (const slot of STOREFRONT_BLOCK_SLOTS) {
    const block = values[slot];
    expect(failedFitConditions(storefrontVariantSpec(slot, block.variant).requires, { facts: resolved.facts, blocks }), `${slot}=${block.variant}`).toEqual([]);
    expect(storefrontVariantSpec(slot, block.variant).settings.safeParse(block.settings).success).toBe(true);
    blocks[slot] = block.variant;
  }
}

describe("store shape", () => {
  it("summarises the menu tree and caps counts", () => {
    expect(TINY).toMatchObject({ productCount: 20, menuTopItems: 3, menuDepth: 1, menuGroups: 0 });
    expect(DEEP).toMatchObject({ productCount: 1000, skuCount: 1000, menuTopItems: 12, menuDepth: 3, menuGroups: 6, brandCount: 300 });
    expect(storeShapeFromFacts({ ...TINY, menu: [], hasCollections: false, hasDeliveryMethods: false })).toMatchObject({ menuDepth: 0, menuGroups: 0 });
    // One group needs two links under it.
    expect(storeShapeFromFacts({ ...TINY, menu: menu(2, 3, 1), hasCollections: false, hasDeliveryMethods: false }).menuGroups).toBe(0);
    expect(storeShapeSchema.safeParse({ ...EMPTY_STORE_SHAPE, skuCount: 1001 }).success).toBe(false);
    expect(storeShapeSchema.safeParse({ ...EMPTY_STORE_SHAPE, extra: 1 }).success).toBe(false);
  });
});

describe("fallback resolution", () => {
  it("renders every template on empty, tiny and deep stores with blocks that fit", () => {
    for (const template of STOREFRONT_TEMPLATES) {
      for (const [name, shape] of Object.entries(SHAPES)) {
        const resolved = resolveStorefrontTheme(storefrontTemplateTheme(template.id), shape);
        assertEverythingFits(resolved, shape);
        expect(resolved.template, `${template.id}/${name}`).toBe(template.id);
      }
    }
  });

  it("falls back per the mix rules on an empty store", () => {
    const base = DEFAULT_STOREFRONT_THEME;
    const resolve = (theme: StorefrontThemeDocument) => resolveStorefrontTheme(theme, EMPTY_STORE_SHAPE);
    // The navigation must fit the tree: every pattern but the drill-in drawer falls back to the dropdown.
    for (const nav of ["mega-panel", "cascading", "departments-rail", "sticky-category-bar"]) {
      const theme = withBlock(base, (blocks) => { blocks.desktopNav = { variant: nav, settings: storefrontVariantSpec("desktopNav", nav).defaults } as never; });
      const resolved = resolve(theme);
      expect(resolved.blocks.desktopNav).toMatchObject({ variant: "dropdown", requested: nav });
      expect(resolved.fallbacks).toContainEqual(expect.objectContaining({ kind: "block", key: "desktopNav", requested: nav, resolved: "dropdown" }));
    }
    const drill = withBlock(base, (blocks) => { blocks.desktopNav = { variant: "drill-in-drawer", settings: {} }; });
    expect(resolve(drill).blocks.desktopNav.variant).toBe("drill-in-drawer");
    // Shelves need a tree or collections; quick-grid needs the quick-add card.
    const shelves = withBlock(base, (blocks) => { blocks.listing.layout = { variant: "shelves", settings: { maxShelves: 8 } }; });
    expect(resolve(shelves).blocks.listing.layout.variant).toBe("grid");
    const quickGrid = withBlock(base, (blocks) => { blocks.listing.layout = { variant: "quick-grid", settings: {} }; });
    expect(resolve(quickGrid).blocks.listing.layout.variant).toBe("grid");
    const quickGridQuickAdd = withBlock(quickGrid, (blocks) => { blocks.card = { variant: "quick-add", settings: {} }; });
    expect(resolve(quickGridQuickAdd).blocks.listing.layout.variant).toBe("quick-grid");
    // The digital buy box needs digital lines; the directory footer needs categories.
    const digital = withBlock(base, (blocks) => { blocks.product.buyBox = { variant: "digital", settings: {} }; blocks.footer = { variant: "directory", settings: {} }; });
    expect(resolve(digital).blocks.product.buyBox.variant).toBe("classic");
    expect(resolve(digital).blocks.footer.variant).toBe("minimal-columns");
    // Modules and toolbar pieces without data are left out; nothing renders an empty box.
    const spec = storefrontTemplateTheme("spec-catalogue");
    const resolvedSpec = resolve(spec);
    expect(resolvedSpec.blocks.product.below).toEqual(["description", "related"]);
    expect(resolvedSpec.blocks.listing.toolbar).not.toContain("subcategory-pills");
    // Aspect chips read today's facets (the storefront omits them without a
    // multi-value facet); the default listing has no per-page control.
    expect(resolve(storefrontTemplateTheme("marketplace")).blocks.listing.toolbar).toContain("aspect-chips");
    expect(resolve(base).blocks.listing.toolbar).toEqual(["breadcrumb", "result-count", "sort"]);
    // Sections whose data is missing are dropped (category tiles need two categories).
    expect(resolvedSpec.pages.home.map((section) => section.type)).not.toContain("category-tiles");
    expect(resolve(storefrontTemplateTheme("marketplace")).pages.home.map((section) => section.type)).toEqual(["hero", "deal-block"]);
  });

  it("keeps small-catalogue choices on a tiny store", () => {
    const boutique = resolveStorefrontTheme(storefrontTemplateTheme("boutique"), TINY);
    expect(boutique.blocks.header.variant).toBe("boutique-inline");
    expect(boutique.fallbacks.filter((each) => each.kind === "block")).toEqual([]);
    // Landing content blocks wait for the merchant to write some.
    expect(boutique.fallbacks).toEqual([expect.objectContaining({ kind: "module", key: "content-blocks" })]);
    const heritage = resolveStorefrontTheme(storefrontTemplateTheme("heritage-editorial"), TINY);
    expect(heritage.blocks.desktopNav.variant).toBe("dropdown");
    expect(heritage.blocks.listing.layout.variant).toBe("grid");
    expect(heritage.pages.home.map((section) => section.type)).toContain("category-tiles");
    expect(resolveStorefrontTheme(DEFAULT_STOREFRONT_THEME, TINY).blocks.footer.variant).toBe("product-widgets");
  });

  it("moves a big catalogue to a header with a visible search and keeps every rich block", () => {
    const boutique = resolveStorefrontTheme(storefrontTemplateTheme("boutique"), DEEP);
    expect(boutique.blocks.header).toMatchObject({ variant: "fashion-department", requested: "boutique-inline", settings: { subBrandRow: false } });
    expect(boutique.fallbacks).toEqual([
      expect.objectContaining({ key: "header", failed: expect.arrayContaining([{ fact: "skuCount", max: 500 }]) }),
    ]);
    for (const template of STOREFRONT_TEMPLATES) {
      if (template.id === "boutique" || template.id === "showcase-landing") continue;
      const resolved = resolveStorefrontTheme(storefrontTemplateTheme(template.id), DEEP);
      expect(resolved.fallbacks, template.id).toEqual([]);
      expect(resolved.blocks.product.below).toEqual(template.blocks.product.below);
      expect(resolved.pages.home).toHaveLength(template.home.length);
    }
  });

  it("gives the same answer in storefront and dashboard use", () => {
    // The storefront resolves the document it reads from the API (JSON);
    // the dashboard resolves the document it edits in memory.
    for (const template of STOREFRONT_TEMPLATES) {
      for (const shape of Object.values(SHAPES)) {
        const inMemory = storefrontTemplateTheme(template.id);
        const fromApi = JSON.parse(JSON.stringify(inMemory)) as StorefrontThemeDocument;
        const shapeFromApi = storeShapeSchema.parse(JSON.parse(JSON.stringify(shape)));
        const before = JSON.stringify(inMemory);
        expect(resolveStorefrontTheme(fromApi, shapeFromApi)).toEqual(resolveStorefrontTheme(inMemory, shape));
        // Resolving never changes the document.
        expect(JSON.stringify(inMemory)).toBe(before);
        for (const slot of STOREFRONT_BLOCK_SLOTS) expect(storefrontBlockValue(inMemory.blocks, slot).variant).toBeTypeOf("string");
      }
    }
  });
});
