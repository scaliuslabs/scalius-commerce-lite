// The fidelity contract: the listing filter style, the shared navigation
// source, the product page per preset, and the resolver on true store
// shapes. Matrix: every preset x card setting x filter style x navigation
// source, on empty, tiny, live-small and 30k-seed stores.
import { describe, expect, it } from "vitest";
import {
  EMPTY_STORE_SHAPE,
  STOREFRONT_BUY_BOX_LOOKS,
  STOREFRONT_CARD_ACTIONS,
  STOREFRONT_CARD_FACTS,
  STOREFRONT_FILTER_MIN_RESULTS,
  STOREFRONT_LISTING_FILTER_SPECS,
  STOREFRONT_LISTING_FILTER_GROUPS,
  STOREFRONT_LISTING_FILTER_STYLES,
  STOREFRONT_NAVIGATION_LINK_BUDGET,
  STOREFRONT_NAVIGATION_SOURCES,
  STOREFRONT_TEMPLATE_IDS,
  STOREFRONT_THEME_DOCUMENT_VERSION,
  failedFitConditions,
  listStorefrontThemeDocumentContrastProblems,
  resolveStorefrontTheme,
  storeShapeFromFacts,
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
  hasDigitalLines: true, hasReviews: true, hasContentBlocks: true,
});

const SHAPES = { empty: EMPTY_STORE_SHAPE, tiny: TINY, liveSmall: LIVE_SMALL, seed30k: SEED_30K, huge: HUGE };

it("keeps the marketplace preset while saving a lighter-header marketplace combination", () => {
  const base = storefrontTemplateTheme("marketplace");
  expect(base.blocks.header.variant).toBe("marketplace-search");
  expect(base.pages.home.find((section) => section.type === "hero")?.settings.layout).toBe("full-bleed");

  const light = structuredClone(base);
  light.blocks.topBar = { variant: "utility", settings: { text: "Free delivery over ৳2,000", link: "/delivery" } };
  light.blocks.header = { variant: "marketplace-light", settings: {} };
  const hero = light.pages.home.find((section) => section.type === "hero");
  const categories = light.pages.home.find((section) => section.type === "category-tiles");
  if (hero?.type !== "hero" || categories?.type !== "category-tiles") throw new Error("Marketplace sections missing");
  hero.settings.layout = "wide-editorial";
  categories.settings.style = "square";

  const saved = storefrontThemeDocumentSchema.parse(JSON.parse(JSON.stringify(light)));
  const resolved = resolveStorefrontTheme(saved, SEED_30K);
  expect(resolved.blocks.topBar.variant).toBe("utility");
  expect(resolved.blocks.header.variant).toBe("marketplace-light");
  expect(resolved.pages.home.find((section) => section.type === "hero")?.settings.layout).toBe("wide-editorial");
  expect(resolved.pages.home.find((section) => section.type === "category-tiles")?.settings.style).toBe("square");
  expect(storefrontTemplateTheme("marketplace").blocks.header.variant).toBe("marketplace-search");
});

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

describe("contract matrix: preset x card x filters x navigation source", () => {
  it("accepts a merchant's card settings on any preset", () => {
    const theme = storefrontTemplateTheme("showcase-landing");
    expect(resolveStorefrontTheme(theme, EMPTY_STORE_SHAPE).blocks.card).toMatchObject({ variant: "standard", settings: { facts: "none", action: "full" } });
    theme.blocks.card = { variant: "standard", settings: { facts: "swatches", action: "quick-add", hoverImage: true } };
    expect(resolveStorefrontTheme(theme, EMPTY_STORE_SHAPE).layout.productCard).toMatchObject({ facts: "swatches", action: "quick-add", hoverImage: true });
  });

  it("parses, passes AA, resolves to fitting blocks and keeps each choice's identity on every store", () => {
    let documents = 0;
    const cards = STOREFRONT_CARD_FACTS.flatMap((facts) => STOREFRONT_CARD_ACTIONS.map((action) => ({ facts, action })));
    for (const template of STOREFRONT_TEMPLATE_IDS) {
      for (const card of cards) {
        for (const style of STOREFRONT_LISTING_FILTER_STYLES) {
          for (const source of STOREFRONT_NAVIGATION_SOURCES) {
            const hoverImage = card.action === "full";
            const theme = variantOf(template, (next) => {
              next.blocks.card = { variant: "standard", settings: { ...card, hoverImage } };
              next.blocks.listing.filters = { style, openByDefault: style !== "bar-dropdowns", searchPlacement: "same", ruled: false };
              next.blocks.navigation = { ...next.blocks.navigation, source };
            });
            const label = `${template}/${card.facts}-${card.action}/${style}/${source}`;
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
                searchPlacement: "same",
                ruled: false,
                spec: STOREFRONT_LISTING_FILTER_SPECS[style],
                shown: shape.productCount >= STOREFRONT_FILTER_MIN_RESULTS,
              });
              // The card keeps its settings and the preset's photo tokens on every store.
              expect(resolved.layout.productCard, at).toEqual({
                ...card,
                hoverImage,
                imageRatio: theme.tokens.imageRatio,
                imageFit: theme.tokens.imageFit,
                surface: theme.tokens.surface,
              });
            }
            documents += 1;
          }
        }
      }
    }
    expect(documents).toBe(STOREFRONT_TEMPLATE_IDS.length * cards.length * STOREFRONT_LISTING_FILTER_STYLES.length * STOREFRONT_NAVIGATION_SOURCES.length);
  });
});

describe("listing filters", () => {
  const filtersOf = (template: StorefrontTemplateId) => storefrontTemplateTheme(template).blocks.listing.filters;

  it("states the description placement and accepts a saved above-products choice", () => {
    const theme = storefrontTemplateTheme("marketplace");
    expect(theme.blocks.listing.descriptionPlacement).toBe("below");
    expect(resolveStorefrontTheme(theme, LIVE_SMALL).blocks.listing.descriptionPlacement).toBe("below");
    // Version 6 states every listing choice: nothing falls back to a template's default.
    const { descriptionPlacement: _placement, ...unstated } = theme.blocks.listing;
    expect(storefrontThemeDocumentSchema.safeParse({ ...theme, blocks: { ...theme.blocks, listing: unstated } }).success).toBe(false);
    theme.blocks.listing.descriptionPlacement = "above";
    expect(storefrontThemeDocumentSchema.safeParse(theme).success).toBe(true);
    expect(resolveStorefrontTheme(theme, LIVE_SMALL).blocks.listing.descriptionPlacement).toBe("above");
  });

  it("gives the marketplace phone cards, searches as rows and a shopper view choice", () => {
    const listing = storefrontTemplateTheme("marketplace").blocks.listing;
    expect(listing.phoneLayout).toBe("grid");
    expect(listing.searchLayout).toBe("list");
    expect(listing.toolbar).toContain("grid-list-toggle");
  });

  it("includes child-category pills in the landing preset's listing toolbar", () => {
    expect(storefrontTemplateTheme("showcase-landing").blocks.listing.toolbar).toContain("subcategory-pills");
  });

  it("maps each preset to a filter style; large catalogues get the open dense column", () => {
    const plain = { searchPlacement: "same", ruled: false } as const;
    expect(Object.fromEntries(STOREFRONT_TEMPLATE_IDS.map((id) => [id, filtersOf(id)]))).toEqual({
      boutique: { style: "bar-dropdowns", openByDefault: false, ...plain },
      marketplace: { style: "sidebar-dense", openByDefault: true, column: 262, rowPitch: 24, label: 14, ...plain },
      "department-mall": { style: "sidebar-dense", openByDefault: true, column: 262, rowPitch: 24, label: 14, ...plain },
      "daily-essentials": { style: "sidebar-comfortable", openByDefault: true, ...plain },
      "showcase-landing": { style: "drawer", openByDefault: false, ...plain },
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

  it("resolves a template's own column, row pitch and label over its style's, within bounds", () => {
    const spec = (template: StorefrontTemplateId) => resolveStorefrontTheme(storefrontTemplateTheme(template), LIVE_SMALL).blocks.listing.filters.spec;
    expect(spec("marketplace")).toEqual({ ...STOREFRONT_LISTING_FILTER_SPECS["sidebar-dense"], column: 262, rowPitch: 24, label: 14 });
    expect(spec("department-mall")).toMatchObject({ placement: "sidebar", column: 262, rowPitch: 24, label: 14 });
    // No override: the style's own numbers.
    expect(spec("showcase-landing")).toEqual(STOREFRONT_LISTING_FILTER_SPECS.drawer);
    expect(spec("daily-essentials")).toEqual(STOREFRONT_LISTING_FILTER_SPECS["sidebar-comfortable"]);
    const theme = storefrontTemplateTheme("marketplace");
    for (const [key, value] of [["column", 179], ["column", 341], ["rowPitch", 15], ["rowPitch", 37], ["label", 11], ["label", 19], ["rowPitch", 18.5]] as const) {
      const next = structuredClone(theme);
      next.blocks.listing.filters = { ...next.blocks.listing.filters, [key]: value };
      expect(storefrontThemeDocumentSchema.safeParse(next).success, `${key}=${value}`).toBe(false);
    }
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
    theme.blocks.listing.filters = { style: "bar-dropdowns", openByDefault: true, searchPlacement: "same", ruled: false };
    expect(storefrontThemeDocumentSchema.safeParse(theme).success).toBe(false);
    theme.blocks.listing.filters = { style: "sidebar", openByDefault: true, searchPlacement: "same", ruled: false } as never;
    expect(storefrontThemeDocumentSchema.safeParse(theme).success).toBe(false);
    theme.blocks.listing.filters = { style: "drawer", openByDefault: true, extra: 1 } as never;
    expect(storefrontThemeDocumentSchema.safeParse(theme).success).toBe(false);
  });

  it("accepts one saved position per filter group and resolves it without changing template defaults", () => {
    const theme = storefrontTemplateTheme("marketplace");
    const original = resolveStorefrontTheme(theme, LIVE_SMALL).blocks.listing.filters;
    expect(original.order).toBeUndefined();
    const order = [...STOREFRONT_LISTING_FILTER_GROUPS].reverse();
    theme.blocks.listing.filters.order = order;
    expect(storefrontThemeDocumentSchema.safeParse(theme).success).toBe(true);
    expect(resolveStorefrontTheme(theme, LIVE_SMALL).blocks.listing.filters.order).toEqual(order);
    theme.blocks.listing.filters.order = ["category", "category", ...order.slice(2)];
    expect(storefrontThemeDocumentSchema.safeParse(theme).success).toBe(false);
    theme.blocks.listing.filters.order = order.slice(1);
    expect(storefrontThemeDocumentSchema.safeParse(theme).success).toBe(false);
  });
});

describe("navigation source", () => {
  it("names a source, a top-item cap and the shared link budget per preset", () => {
    const navigation = Object.fromEntries(STOREFRONT_TEMPLATE_IDS.map((id) => [id, storefrontTemplateTheme(id).blocks.navigation]));
    expect(navigation).toEqual({
      boutique: { source: "menu", maxTopItems: 6, linkBudget: 150 },
      marketplace: { source: "tree+menu", maxTopItems: 18, linkBudget: 150 },
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
    const tree = variantOf("department-mall", (theme) => { theme.blocks.navigation.source = "category-tree"; });
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
    const mega = variantOf("department-mall", (theme) => { theme.blocks.navigation.source = "category-tree"; });
    expect(resolveStorefrontTheme(mega, HUGE).blocks.desktopNav.variant).toBe("mega-panel");
    expect(resolveStorefrontTheme(mega, SEED_30K).blocks.desktopNav).toMatchObject({ variant: "dropdown", requested: "mega-panel" });
    // The cap keeps a 25-root tree inside the Essentials bar's 16 items.
    const essentials = resolveStorefrontTheme(storefrontTemplateTheme("daily-essentials"), SEED_30K);
    expect(essentials.facts.navTopItems).toBe(16);
    expect(essentials.blocks.desktopNav.variant).toBe("sticky-category-bar");
    // Cascading needs two levels in the rendered source.
    expect(essentials.facts.navDepth).toBe(3);
    expect(storefrontFitFacts(SEED_30K, { source: "menu", maxTopItems: 18 })).toMatchObject({ navTopItems: 0, navDepth: 0 });
    expect(storefrontFitFacts(LIVE_SMALL, { source: "tree+menu", maxTopItems: 8 }).navTopItems).toBe(8);
  });
});

describe("resolver on true store shapes", () => {
  it("keeps boutique's own header on the real small store", () => {
    const boutique = resolveStorefrontTheme(storefrontTemplateTheme("boutique"), LIVE_SMALL);
    expect(boutique.blocks.header.variant).toBe("boutique-inline");
    expect(boutique.facts.navTopItems).toBe(6);
    expect(boutique.fallbacks.filter((each) => each.kind === "block")).toEqual([]);
    // The menu keeps its overflow pattern even for many roots and SKUs.
    const oldShape = storeShapeFromFacts({ ...LIVE_SMALL, topCategoryCount: 382, menu: flatMenu(12) });
    expect(resolveStorefrontTheme(storefrontTemplateTheme("boutique"), oldShape).blocks.header.variant).toBe("boutique-inline");
    expect(resolveStorefrontTheme(storefrontTemplateTheme("boutique"), SEED_30K).blocks.header.variant).toBe("boutique-inline");
  });

  it("brings shelves, sub-category pills and popular-filter chips alive on the 30k tree", () => {
    const shelves = variantOf("boutique", (theme) => {
      theme.blocks.listing.layout = { variant: "shelves", settings: { maxShelves: 8, spacing: "airy" } };
      theme.blocks.listing.toolbar = [...theme.blocks.listing.toolbar, "subcategory-pills", "popular-filter-chips"];
    });
    const big = resolveStorefrontTheme(shelves, SEED_30K);
    expect(big.blocks.listing.layout.variant).toBe("shelves");
    expect(big.blocks.listing.toolbar).toContain("subcategory-pills");
    expect(big.blocks.listing.toolbar).toContain("popular-filter-chips");
    const showcase = resolveStorefrontTheme(storefrontTemplateTheme("showcase-landing"), SEED_30K);
    expect(showcase.blocks.listing.toolbar).toContain("subcategory-pills");
    expect(showcase.blocks.listing.toolbar).toContain("facet-value-chips");
    // A flat store without collections has no shelves: the grid renders, and the dashboard says why.
    const flat = resolveStorefrontTheme(shelves, TINY);
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
          // Reviews, EMI and content blocks are not in the seed.
          && !(shape === SEED_30K && (each.kind === "module" || each.kind === "section")));
        expect(fallbacks, id).toEqual([]);
      }
    }
  });

  it("hides filters store-wide below the small-catalogue threshold, and says why", () => {
    const resolved = resolveStorefrontTheme(storefrontTemplateTheme("department-mall"), TINY);
    expect(resolved.blocks.listing.filters).toMatchObject({ style: "sidebar-dense", shown: false });
    expect(resolved.fallbacks).toContainEqual(expect.objectContaining({ kind: "filters", key: "listing", resolved: null, failed: [{ fact: "productCount", min: 8 }] }));
    expect(resolveStorefrontTheme(storefrontTemplateTheme("department-mall"), LIVE_SMALL).blocks.listing.filters.shown).toBe(true);
  });

  it("is version 9 and writes no older document", () => {
    expect(STOREFRONT_THEME_DOCUMENT_VERSION).toBe(9);
    const theme = storefrontTemplateTheme("department-mall");
    expect(storefrontThemeDocumentSchema.safeParse({ ...theme, version: 5 }).success).toBe(false);
    const oldLayout = structuredClone(theme);
    oldLayout.blocks.listing.layout = { variant: "sidebar-grid", settings: {} } as never;
    expect(storefrontThemeDocumentSchema.safeParse(oldLayout).success).toBe(false);
    const { navigation: _navigation, ...withoutNavigation } = theme.blocks;
    expect(storefrontThemeDocumentSchema.safeParse({ ...theme, blocks: withoutNavigation }).success).toBe(false);
  });
});

describe("product page per preset", () => {
  const resolved = (id: StorefrontTemplateId) => resolveStorefrontTheme(storefrontTemplateTheme(id), EMPTY_STORE_SHAPE);

  it("gives each preset its buy box while keeping the department gallery", () => {
    const mall = resolved("department-mall");
    expect(mall.layout.productPage).toEqual({ gallery: "beside", thumbnails: "beside", stageRatio: 1, thumbnailSize: null });
    expect(mall.layout.buyBox).toEqual({ look: STOREFRONT_BUY_BOX_LOOKS.mall, emi: false, whatsapp: false });
    expect(resolved("boutique").layout.buyBox.look).toEqual(STOREFRONT_BUY_BOX_LOOKS.boutique);
    expect(resolved("showcase-landing").layout.buyBox.look?.title).toEqual({ size: { desktop: 48, phone: 31 }, weight: 700 });
    expect(resolved("marketplace").layout.buyBox.look?.facts).toBe("column");
    expect(resolved("daily-essentials").layout.buyBox.look).toMatchObject({
      title: { size: { phone: 20 } }, price: { size: { phone: 20 }, tone: "primary" },
      cta: { layout: "row", first: "add-to-cart" },
    });
  });

  it("starts the fashion buy box with one purchase action and accepts a merchant's Buy now choice", () => {
    const theme = storefrontTemplateTheme("boutique");
    theme.blocks.product.buyBox = { variant: "fashion", settings: { showBuyNow: false } };
    expect(resolveStorefrontTheme(theme, EMPTY_STORE_SHAPE).layout.buyBox.look?.cta.showBuyNow).toBe(false);
    theme.blocks.product.buyBox.settings = { showBuyNow: true };
    expect(resolveStorefrontTheme(theme, EMPTY_STORE_SHAPE).layout.buyBox.look?.cta.showBuyNow).toBe(true);
  });

  it("renders real gallery variants: stacked, a narrow thumbnail strip and the classic stage", () => {
    expect(resolved("boutique").layout.productPage.gallery).toBe("stacked");
    expect(resolved("showcase-landing").layout.productPage.gallery).toBe("stacked");
    expect(resolved("marketplace").layout.productPage).toMatchObject({ thumbnails: "beside" });
    expect(resolved("daily-essentials").layout.productPage).toMatchObject({ thumbnails: "beside", phoneSideThumbnails: false });
    expect(resolved("daily-essentials").blocks.product.sticky.phoneBottom).toBe("none");
    const theme = storefrontTemplateTheme("marketplace");
    theme.blocks.product.gallery = { variant: "thumbs-left", settings: {} };
    expect(resolveStorefrontTheme(theme, EMPTY_STORE_SHAPE).layout.productPage).toMatchObject({ thumbnails: "beside", thumbnailSize: 48 });
  });

  it("lists reviews on every preset that shows them and warranty on the marketplace", () => {
    expect(resolved("marketplace").blocks.product.below).toEqual(expect.arrayContaining(["warranty", "reviews"]));
    expect(resolved("department-mall").blocks.product.below).toEqual(["description", "reviews", "related"]);
    expect(resolved("daily-essentials").blocks.product.below).not.toContain("reviews");
  });
});
