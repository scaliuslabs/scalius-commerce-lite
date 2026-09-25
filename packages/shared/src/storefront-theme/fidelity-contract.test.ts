// The slice 0 fidelity contract (audit/rewrite-2026-09-23/fidelity/AUDIT.md
// section 8): card looks per variant, the listing filter style, the shared
// navigation source, and the resolver on true store shapes. Matrix: every
// template x card variant x filter style x navigation source, on empty,
// tiny, live-small and 30k-seed stores.
import { describe, expect, it } from "vitest";
import {
  EMPTY_STORE_SHAPE,
  STOREFRONT_CARD_LOOKS,
  STOREFRONT_FILTER_MIN_RESULTS,
  STOREFRONT_LISTING_FILTER_SPECS,
  STOREFRONT_LISTING_FILTER_STYLES,
  STOREFRONT_NAVIGATION_LINK_BUDGET,
  STOREFRONT_NAVIGATION_SOURCES,
  STOREFRONT_TEMPLATE_IDS,
  STOREFRONT_THEME_DOCUMENT_VERSION,
  failedFitConditions,
  listStorefrontThemeDocumentContrastProblems,
  resolveStorefrontTheme,
  storeShapeFromFacts,
  storefrontBlockVariants,
  storefrontFitFacts,
  storefrontListingFiltersShown,
  storefrontTemplateTheme,
  storefrontThemeDocumentSchema,
  storefrontVariantSpec,
  type ResolvedStorefrontTheme,
  type StoreShape,
  type StorefrontBlockSlot,
  type StorefrontTemplateId,
  type StorefrontThemeDocument,
} from "../storefront-theme";

const flatMenu = (items: number) => Array.from({ length: items }, () => ({}));

/** A new shop: 6 products, one category, a 3-link menu. */
const TINY: StoreShape = storeShapeFromFacts({
  productCount: 6, skuCount: 9, topCategoryCount: 1, categoryDepth: 1, menu: flatMenu(3),
  hasCollections: false, hasDeliveryMethods: true,
});

/**
 * The live store's shape (AUDIT.md section 3.3 and section 7): 20 products,
 * 79 SKUs, a handful of flat categories and the live 12-link flat menu.
 */
const LIVE_SMALL: StoreShape = storeShapeFromFacts({
  productCount: 20, skuCount: 79, topCategoryCount: 5, categoryDepth: 1, menu: flatMenu(12),
  hasCollections: true, hasDeliveryMethods: true,
});

/** The 30k catalogue seed read by store-shape.ts: 25 roots, 4 levels, 300 brands, key specs. */
const SEED_30K: StoreShape = storeShapeFromFacts({
  productCount: 30_000, skuCount: 83_749, topCategoryCount: 25, categoryDepth: 4, categoryGroups: 0,
  menu: [], brandCount: 300, hasCollections: true, hasDeliveryMethods: true, hasKeySpecs: true,
});

/** A huge store with a rich menu and tree groups. */
const HUGE: StoreShape = storeShapeFromFacts({
  productCount: 100_000, skuCount: 250_000, topCategoryCount: 40, categoryDepth: 4, categoryGroups: 9,
  menu: Array.from({ length: 30 }, () => ({ subMenu: [{ subMenu: [{}, {}, {}] }, { subMenu: [{}, {}] }] })),
  brandCount: 1000, hasCollections: true, hasDeliveryMethods: true, hasKeySpecs: true, hasEmiPlans: true,
  hasDigitalLines: true, hasReviews: true, hasQuestions: true, hasContentBlocks: true,
});

const SHAPES = { empty: EMPTY_STORE_SHAPE, tiny: TINY, liveSmall: LIVE_SMALL, seed30k: SEED_30K, huge: HUGE };

const SLOTS: StorefrontBlockSlot[] = ["topBar", "header", "desktopNav", "mobileNav", "card", "listing", "gallery", "buyBox", "footer"];

function renderedBlocks(resolved: ResolvedStorefrontTheme) {
  const { blocks } = resolved;
  return {
    topBar: blocks.topBar, header: blocks.header, desktopNav: blocks.desktopNav, mobileNav: blocks.mobileNav,
    card: blocks.card, listing: blocks.listing.layout, gallery: blocks.product.gallery, buyBox: blocks.product.buyBox,
    footer: blocks.footer,
  };
}

/** Every rendered block fits the facts the resolver judged it on. */
function expectFits(resolved: ResolvedStorefrontTheme, label: string) {
  const blocks: Record<string, string> = {};
  const rendered = renderedBlocks(resolved);
  for (const slot of SLOTS) {
    const { variant } = rendered[slot];
    expect(failedFitConditions(storefrontVariantSpec(slot, variant).requires, { facts: resolved.facts, blocks }), `${label} ${slot}=${variant}`)
      .toEqual([]);
    blocks[slot] = variant;
  }
}

function variantOf(template: StorefrontTemplateId, change: (theme: StorefrontThemeDocument) => void): StorefrontThemeDocument {
  const theme = storefrontTemplateTheme(template);
  change(theme);
  return theme;
}

describe("contract matrix: template x card x filters x navigation source", () => {
  it("parses, passes AA, resolves to fitting blocks and keeps each choice's identity on every store", () => {
    let documents = 0;
    for (const template of STOREFRONT_TEMPLATE_IDS) {
      for (const card of storefrontBlockVariants("card")) {
        for (const style of STOREFRONT_LISTING_FILTER_STYLES) {
          for (const source of STOREFRONT_NAVIGATION_SOURCES) {
            const theme = variantOf(template, (next) => {
              next.blocks.card = { variant: card, settings: structuredClone(storefrontVariantSpec("card", card).defaults) } as never;
              next.blocks.listing.filters = { style, openByDefault: style !== "bar-dropdowns" };
              next.blocks.navigation = { ...next.blocks.navigation, source };
            });
            const label = `${template}/${card}/${style}/${source}`;
            const parsed = storefrontThemeDocumentSchema.safeParse(theme);
            expect(parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`), label).toEqual([]);
            expect(listStorefrontThemeDocumentContrastProblems(theme), label).toEqual([]);
            for (const [name, shape] of Object.entries(SHAPES)) {
              const resolved = resolveStorefrontTheme(theme, shape);
              const at = `${label} on ${name}`;
              expectFits(resolved, at);
              // The facts are the shape plus the navigation actually rendered.
              expect(resolved.facts, at).toEqual(storefrontFitFacts(shape, resolved.blocks.navigation));
              expect(resolved.facts.navTopItems, at).toBeLessThanOrEqual(theme.blocks.navigation.maxTopItems);
              // Filters: the chosen style always, shown only on a store big enough for one listing to reach the threshold.
              expect(resolved.blocks.listing.filters, at).toEqual({
                style,
                openByDefault: style !== "bar-dropdowns",
                spec: STOREFRONT_LISTING_FILTER_SPECS[style],
                shown: shape.productCount >= STOREFRONT_FILTER_MIN_RESULTS,
              });
              // A card keeps its measured look in every template.
              const look = resolved.layout.productCard.look;
              if (card === "standard") expect(look.title, at).toBeNull();
              else expect(look, at).toEqual(STOREFRONT_CARD_LOOKS[card as keyof typeof STOREFRONT_CARD_LOOKS]);
            }
            documents += 1;
          }
        }
      }
    }
    expect(documents).toBe(10 * 9 * 4 * 3);
  });
});

describe("listing filters", () => {
  const filtersOf = (template: StorefrontTemplateId) => storefrontTemplateTheme(template).blocks.listing.filters;

  it("maps each template to its reference's filter style; large catalogues get the open dense column", () => {
    expect(Object.fromEntries(STOREFRONT_TEMPLATE_IDS.map((id) => [id, filtersOf(id)]))).toEqual({
      boutique: { style: "bar-dropdowns", openByDefault: false }, // Dawn
      "heritage-editorial": { style: "bar-dropdowns", openByDefault: false }, // Aarong
      "fashion-value": { style: "sidebar-comfortable", openByDefault: true }, // Fabrilife
      "spec-catalogue": { style: "sidebar-dense", openByDefault: true }, // Star Tech
      "rounded-tech": { style: "sidebar-comfortable", openByDefault: true }, // Apple Gadgets
      marketplace: { style: "sidebar-dense", openByDefault: true }, // Daraz, Amazon
      "mass-retail": { style: "sidebar-dense", openByDefault: true }, // large catalogue (owner rule)
      "department-mall": { style: "sidebar-comfortable", openByDefault: true }, // Game Ghor
      "daily-essentials": { style: "drawer", openByDefault: false }, // Chaldal
      "showcase-landing": { style: "drawer", openByDefault: false },
    });
  });

  it("measures the dense column inside the references' band", () => {
    const dense = STOREFRONT_LISTING_FILTER_SPECS["sidebar-dense"];
    expect(dense.column).toBeGreaterThanOrEqual(200);
    expect(dense.column).toBeLessThanOrEqual(265);
    expect(dense.rowPitch).toBeGreaterThanOrEqual(18);
    expect(dense.rowPitch).toBeLessThanOrEqual(24);
    // Within 10% of Amazon (262) and Star Tech (225-265) widths.
    for (const reference of [262, 225, 265]) expect(Math.abs(dense.column - reference) / reference).toBeLessThanOrEqual(0.1);
    const comfortable = STOREFRONT_LISTING_FILTER_SPECS["sidebar-comfortable"];
    expect(comfortable.column).toBeGreaterThan(dense.column);
    expect(comfortable.rowPitch).toBeGreaterThan(dense.rowPitch);
    expect(STOREFRONT_LISTING_FILTER_SPECS["bar-dropdowns"]).toMatchObject({ placement: "bar", barFacets: 4 });
    expect(STOREFRONT_LISTING_FILTER_SPECS.drawer.placement).toBe("drawer");
  });

  it("applies the small-catalogue rule per listing", () => {
    const shown = (total: number, facetValueCounts: number[], refinementCount = 0) =>
      storefrontListingFiltersShown({ total, refinementCount, facetValueCounts });
    expect(shown(7, [3, 4])).toBe(false);
    expect(shown(8, [3, 4])).toBe(true);
    expect(shown(3780, [1, 1, 1])).toBe(false); // every facet has one value
    expect(shown(3780, [])).toBe(false);
    expect(shown(3780, [1, 2])).toBe(true);
    expect(shown(0, [], 1)).toBe(true); // a refinement stays undoable
  });

  it("rejects open dropdowns and unknown styles", () => {
    const theme = storefrontTemplateTheme("boutique");
    theme.blocks.listing.filters = { style: "bar-dropdowns", openByDefault: true };
    expect(storefrontThemeDocumentSchema.safeParse(theme).success).toBe(false);
    theme.blocks.listing.filters = { style: "sidebar", openByDefault: true } as never;
    expect(storefrontThemeDocumentSchema.safeParse(theme).success).toBe(false);
    theme.blocks.listing.filters = { style: "drawer", openByDefault: true, extra: 1 } as never;
    expect(storefrontThemeDocumentSchema.safeParse(theme).success).toBe(false);
  });
});

describe("navigation source", () => {
  it("names a source, a top-item cap and the shared link budget per template", () => {
    const navigation = Object.fromEntries(STOREFRONT_TEMPLATE_IDS.map((id) => [id, storefrontTemplateTheme(id).blocks.navigation]));
    expect(navigation).toEqual({
      boutique: { source: "menu", maxTopItems: 6, linkBudget: 150 },
      "heritage-editorial": { source: "tree+menu", maxTopItems: 11, linkBudget: 150 },
      "fashion-value": { source: "tree+menu", maxTopItems: 6, linkBudget: 150 },
      "spec-catalogue": { source: "category-tree", maxTopItems: 18, linkBudget: 150 },
      "rounded-tech": { source: "category-tree", maxTopItems: 9, linkBudget: 150 },
      marketplace: { source: "tree+menu", maxTopItems: 18, linkBudget: 150 },
      "mass-retail": { source: "tree+menu", maxTopItems: 17, linkBudget: 150 },
      "department-mall": { source: "tree+menu", maxTopItems: 8, linkBudget: 150 },
      "daily-essentials": { source: "tree+menu", maxTopItems: 16, linkBudget: 150 },
      "showcase-landing": { source: "menu", maxTopItems: 6, linkBudget: 150 },
    });
    const theme = storefrontTemplateTheme("marketplace");
    for (const bad of [
      { ...theme.blocks.navigation, linkBudget: STOREFRONT_NAVIGATION_LINK_BUDGET + 1 },
      { ...theme.blocks.navigation, maxTopItems: 0 },
      { ...theme.blocks.navigation, maxTopItems: 19 },
      { ...theme.blocks.navigation, source: "collections" },
      { ...theme.blocks.navigation, extra: true },
    ]) {
      expect(storefrontThemeDocumentSchema.safeParse({ ...theme, blocks: { ...theme.blocks, navigation: bad } }).success).toBe(false);
    }
  });

  it("falls back to whichever source has links, and says so", () => {
    const tree = variantOf("spec-catalogue", () => undefined);
    // A tree template on a store without categories uses the menu.
    const menuOnly = storeShapeFromFacts({ ...TINY, topCategoryCount: 0, categoryDepth: 0, menu: flatMenu(4) });
    const onMenu = resolveStorefrontTheme(tree, menuOnly);
    expect(onMenu.blocks.navigation).toMatchObject({ source: "menu", requested: "category-tree" });
    expect(onMenu.fallbacks).toContainEqual(expect.objectContaining({ kind: "navigation", key: "source", requested: "category-tree", resolved: "menu" }));
    expect(onMenu.facts.navTopItems).toBe(4);
    // A menu template on a store without a menu uses the tree.
    const boutique = resolveStorefrontTheme(storefrontTemplateTheme("boutique"), storeShapeFromFacts({ ...TINY, menu: [] }));
    expect(boutique.blocks.navigation).toMatchObject({ source: "category-tree", requested: "menu" });
    expect(boutique.facts.navTopItems).toBe(1);
    // With neither, the choice stands and nothing falls back.
    const empty = resolveStorefrontTheme(tree, EMPTY_STORE_SHAPE);
    expect(empty.blocks.navigation.source).toBe("category-tree");
    expect(empty.fallbacks.filter((each) => each.kind === "navigation")).toEqual([]);
  });

  it("judges menu patterns by the source that renders", () => {
    // Tree groups make a tree-driven mega panel fit without any menu.
    const mega = variantOf("fashion-value", (theme) => { theme.blocks.navigation.source = "category-tree"; });
    expect(resolveStorefrontTheme(mega, HUGE).blocks.desktopNav.variant).toBe("mega-panel");
    expect(resolveStorefrontTheme(mega, SEED_30K).blocks.desktopNav).toMatchObject({ variant: "dropdown", requested: "mega-panel" });
    // The cap keeps a 25-root tree inside Star Tech's 18-item bar.
    const spec = resolveStorefrontTheme(storefrontTemplateTheme("spec-catalogue"), SEED_30K);
    expect(spec.facts.navTopItems).toBe(18);
    expect(spec.blocks.desktopNav.variant).toBe("sticky-category-bar");
    // Cascading needs two levels in the rendered source.
    expect(spec.facts.navDepth).toBe(3);
    expect(storefrontFitFacts(SEED_30K, { source: "menu", maxTopItems: 18 })).toMatchObject({ navTopItems: 0, navDepth: 0 });
    expect(storefrontFitFacts(LIVE_SMALL, { source: "tree+menu", maxTopItems: 8 }).navTopItems).toBe(8);
  });
});

describe("resolver on true store shapes (AUDIT.md sections 3.3 and 8)", () => {
  it("keeps boutique's own header on the real small store", () => {
    const boutique = resolveStorefrontTheme(storefrontTemplateTheme("boutique"), LIVE_SMALL);
    expect(boutique.blocks.header.variant).toBe("boutique-inline");
    expect(boutique.facts.navTopItems).toBe(6);
    expect(boutique.fallbacks.filter((each) => each.kind === "block")).toEqual([]);
    // The old shape (every published category counted as a root) pushed it out.
    const oldShape = storeShapeFromFacts({ ...LIVE_SMALL, topCategoryCount: 382, menu: flatMenu(12) });
    expect(resolveStorefrontTheme(storefrontTemplateTheme("boutique"), oldShape).blocks.header.variant).toBe("fashion-department");
    // A big catalogue still moves to a header with a visible search.
    expect(resolveStorefrontTheme(storefrontTemplateTheme("boutique"), SEED_30K).blocks.header.variant).toBe("fashion-department");
  });

  it("brings shelves, sub-category pills and popular-filter chips alive on the 30k tree", () => {
    const heritage = resolveStorefrontTheme(storefrontTemplateTheme("heritage-editorial"), SEED_30K);
    expect(heritage.blocks.listing.layout.variant).toBe("shelves");
    const spec = resolveStorefrontTheme(storefrontTemplateTheme("spec-catalogue"), SEED_30K);
    expect(spec.blocks.listing.toolbar).toContain("subcategory-pills");
    expect(spec.blocks.product.below).toContain("spec-table");
    const retail = resolveStorefrontTheme(storefrontTemplateTheme("mass-retail"), SEED_30K);
    expect(retail.blocks.listing.toolbar).toContain("popular-filter-chips");
    // A flat store without collections has no shelves: the grid renders, and the dashboard says why.
    const flat = resolveStorefrontTheme(storefrontTemplateTheme("heritage-editorial"), TINY);
    expect(flat.blocks.listing.layout).toMatchObject({ variant: "grid", requested: "shelves" });
    expect(flat.blocks.listing.toolbar).not.toContain("subcategory-pills");
  });

  it("renders every template on the 30k seed and a huge store with no fallback", () => {
    for (const shape of [SEED_30K, HUGE]) {
      for (const id of STOREFRONT_TEMPLATE_IDS) {
        if (id === "boutique" || id === "showcase-landing") continue;
        const resolved = resolveStorefrontTheme(storefrontTemplateTheme(id), shape);
        const fallbacks = resolved.fallbacks.filter((each) =>
          // The 30k seed has no menu groups or tree groups (a 5 x 1 x 1 tree): mega panels fall back there.
          !(shape === SEED_30K && each.key === "desktopNav" && each.requested === "mega-panel")
          // Reviews, questions, EMI and content blocks are not in the seed.
          && !(shape === SEED_30K && (each.kind === "module" || each.kind === "section")));
        expect(fallbacks, id).toEqual([]);
      }
    }
  });

  it("hides filters store-wide below the small-catalogue threshold, and says why", () => {
    const resolved = resolveStorefrontTheme(storefrontTemplateTheme("spec-catalogue"), TINY);
    expect(resolved.blocks.listing.filters).toMatchObject({ style: "sidebar-dense", shown: false });
    expect(resolved.fallbacks).toContainEqual(expect.objectContaining({ kind: "filters", key: "listing", resolved: null, failed: [{ fact: "productCount", min: 8 }] }));
    expect(resolveStorefrontTheme(storefrontTemplateTheme("spec-catalogue"), LIVE_SMALL).blocks.listing.filters.shown).toBe(true);
  });

  it("is version 5 and reads nothing older", () => {
    expect(STOREFRONT_THEME_DOCUMENT_VERSION).toBe(5);
    const theme = storefrontTemplateTheme("department-mall");
    expect(storefrontThemeDocumentSchema.safeParse({ ...theme, version: 4 }).success).toBe(false);
    const oldLayout = structuredClone(theme);
    oldLayout.blocks.listing.layout = { variant: "sidebar-grid", settings: {} } as never;
    expect(storefrontThemeDocumentSchema.safeParse(oldLayout).success).toBe(false);
    const { navigation: _navigation, ...withoutNavigation } = theme.blocks;
    expect(storefrontThemeDocumentSchema.safeParse({ ...theme, blocks: withoutNavigation }).success).toBe(false);
  });
});
