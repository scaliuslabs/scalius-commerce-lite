// One resolver for the storefront and the dashboard: a document plus the
// store's shape give the variants that actually render (after fit
// fallbacks), the navigation source and filter style that apply, the
// card's settings, the sections that have data to show, and the facts
// today's storefront components read. The dashboard preview and the live
// store run this same function on the same inputs, so they always agree.
import {
  STOREFRONT_BLOCK_SLOTS,
  STOREFRONT_FILTER_MIN_RESULTS,
  storefrontListingFilterSpec,
  STOREFRONT_LISTING_TOOLBAR,
  STOREFRONT_PRODUCT_MODULES,
  storefrontBlockSwitch,
  storefrontBlockValue,
  storefrontVariantSpec,
  type StorefrontBlockSlot,
  type StorefrontCardRenderer,
  type StorefrontFooterRenderer,
  type StorefrontBuyBoxRenderer,
  type StorefrontGalleryRenderer,
  type StorefrontHeaderRenderer,
  type StorefrontListingFilterSpec,
  type StorefrontListingFilterStyle,
  type StorefrontListingFilters,
  type StorefrontListingToolbarPiece,
  type StorefrontMobileNavigationRenderer,
  type StorefrontNavigation,
  type StorefrontNavigationRenderer,
  type StorefrontProductModule,
  type StorefrontThemeBlocks,
} from "./blocks";
import type { StorefrontThemeBrand } from "./brand";
import type { StorefrontTemplateId, StorefrontThemeDocument, StorefrontThemePages } from "./document";
import {
  atLeast,
  failedFitConditions,
  storefrontFitFacts,
  type FitCondition,
  type FitContext,
  type StoreShape,
  type StorefrontFitFacts,
  type StorefrontNavigationSource,
} from "./fit";
import { STOREFRONT_SECTION_REGISTRY, storefrontVisibleSection, type StorefrontSection } from "./sections";
import { STOREFRONT_PAGE_TEMPLATES, type StorefrontPageTemplateValue } from "./pages";
import {
  STOREFRONT_DENSITY_SPECS,
  type StorefrontDensity,
  type StorefrontDensitySpec,
  type StorefrontImageRatio,
  type StorefrontImageFit,
  type StorefrontThemeSurface,
  type StorefrontThemeTokens,
} from "./tokens";

export interface ResolvedStorefrontBlock {
  /** The variant that renders for this store. */
  variant: string;
  settings: Record<string, unknown>;
  /** The variant the document chose (differs when it did not fit). */
  requested: string;
}

/** A choice that does not render as chosen on this store, and why. */
export interface StorefrontThemeFallback {
  kind: "block" | "toolbar" | "module" | "section" | "navigation" | "filters";
  /** Block slot, toolbar piece, module, section id, "source" or "listing". */
  key: string;
  requested: string;
  /** What renders instead; null when it is left out. */
  resolved: string | null;
  /** The conditions the store did not meet. */
  failed: FitCondition[];
}

/** The navigation every header surface renders. */
export interface ResolvedStorefrontNavigation extends StorefrontNavigation {
  /** The source the document chose (differs when the store has nothing there). */
  requested: StorefrontNavigationSource;
}

/** The listing's filters as they render on this store. */
export interface ResolvedStorefrontListingFilters {
  style: StorefrontListingFilterStyle;
  openByDefault: boolean;
  /** A search's facets with a sidebar style: the column (`same`) or a drawer. */
  searchPlacement: StorefrontListingFilters["searchPlacement"];
  /** A sidebar's groups as one flat, ruled list. */
  ruled: boolean;
  /** Merchant order, when it replaces the template's original arrangement. */
  order?: StorefrontListingFilters["order"];
  /** The measured facet UI: the style's, with the template's own column, row pitch and label. */
  spec: StorefrontListingFilterSpec;
  /**
   * False when the whole store has fewer products than the small-catalogue
   * threshold, so no listing can show filters; each listing still applies
   * `storefrontListingFiltersShown` to its own results.
   */
  shown: boolean;
}

/**
 * What today's storefront components render (the v3 renderers), derived
 * from the resolved variants' `renders`. Each block's own renderer replaces
 * its entry in the phase that builds it.
 */
export interface ResolvedStorefrontThemeLayout {
  topBar: boolean;
  header: StorefrontHeaderRenderer;
  navigation: StorefrontNavigationRenderer;
  mobileNavigation: StorefrontMobileNavigationRenderer;
  footer: StorefrontFooterRenderer;
  /** The card's settings with the tokens it draws its photo and surface with. */
  productCard: StorefrontCardRenderer & {
    imageRatio: StorefrontImageRatio;
    imageFit: StorefrontImageFit;
    surface: StorefrontThemeSurface;
  };
  density: StorefrontDensity;
  grid: StorefrontDensitySpec;
  productPage: StorefrontGalleryRenderer;
  /** The buy box's look (null: today's classic) and its EMI and WhatsApp strips. */
  buyBox: StorefrontBuyBoxRenderer;
}

/** The card as renderers read it: its settings and the tokens it draws with. */
export type ResolvedStorefrontCard = ResolvedStorefrontThemeLayout["productCard"];

export interface ResolvedStorefrontTheme {
  template: StorefrontTemplateId;
  tokens: StorefrontThemeTokens;
  /** The facts every fit rule was judged on: the store shape plus the rendered navigation. */
  facts: StorefrontFitFacts;
  blocks: {
    topBar: ResolvedStorefrontBlock;
    header: ResolvedStorefrontBlock;
    navigation: ResolvedStorefrontNavigation;
    desktopNav: ResolvedStorefrontBlock;
    mobileNav: ResolvedStorefrontBlock;
    card: ResolvedStorefrontBlock;
    /** The listing's own choices as the document states them, with the layout, filters and toolbar resolved. */
    listing: Omit<StorefrontThemeBlocks["listing"], "layout" | "filters" | "toolbar"> & {
      layout: ResolvedStorefrontBlock;
      filters: ResolvedStorefrontListingFilters;
      toolbar: StorefrontListingToolbarPiece[];
    };
    product: {
      gallery: ResolvedStorefrontBlock;
      buyBox: ResolvedStorefrontBlock;
      below: StorefrontProductModule[];
      sticky: StorefrontThemeBlocks["product"]["sticky"];
    };
    footer: ResolvedStorefrontBlock;
  };
  /** The logo, footer logo and tab icon (media ids) and the logo width, as the document states them. */
  brand: StorefrontThemeBrand;
  /** The sections that fit the store, and what `/` shows. */
  pages: StorefrontThemePages;
  fallbacks: StorefrontThemeFallback[];
  layout: ResolvedStorefrontThemeLayout;
}

function resolveBlock(
  slot: StorefrontBlockSlot,
  chosen: { variant: string; settings: Record<string, unknown> },
  context: FitContext,
  fallbacks: StorefrontThemeFallback[],
): ResolvedStorefrontBlock {
  let current = chosen;
  const failed: FitCondition[] = [];
  const seen = new Set<string>();
  for (;;) {
    seen.add(current.variant);
    const spec = storefrontVariantSpec(slot, current.variant);
    const failing = failedFitConditions(spec.requires, context);
    if (failing.length === 0 || spec.fallback === null || seen.has(spec.fallback)) break;
    failed.push(...failing);
    // The fallback keeps the settings it shares (a footer's words survive a directory that does not fit).
    current = storefrontBlockSwitch(slot, current, spec.fallback);
  }
  if (current.variant !== chosen.variant) {
    fallbacks.push({ kind: "block", key: slot, requested: chosen.variant, resolved: current.variant, failed });
  }
  return { variant: current.variant, settings: current.settings, requested: chosen.variant };
}

/** What a navigation source needs: the tree needs a public root, the menu a top item. */
export const STOREFRONT_NAVIGATION_SOURCE_REQUIRES: Readonly<Record<StorefrontNavigationSource, readonly FitCondition[]>> = {
  menu: [atLeast("menuTopItems", 1)],
  "category-tree": [atLeast("topCategoryCount", 1)],
  "tree+menu": [atLeast("topCategoryCount", 1)],
};

/**
 * The source that renders: a tree source without a public root falls back
 * to the menu, and a menu source without a menu to the tree, so a store
 * with either never shows an empty header. With neither, the choice stands
 * (there is nothing to show either way).
 */
function resolveNavigation(
  navigation: StorefrontNavigation,
  shape: StoreShape,
  fallbacks: StorefrontThemeFallback[],
): ResolvedStorefrontNavigation {
  const context = { facts: storefrontFitFacts(shape, navigation), blocks: {} };
  const failed = failedFitConditions(STOREFRONT_NAVIGATION_SOURCE_REQUIRES[navigation.source], context);
  const alternative: StorefrontNavigationSource = navigation.source === "menu" ? "category-tree" : "menu";
  const usable = failed.length > 0
    && failedFitConditions(STOREFRONT_NAVIGATION_SOURCE_REQUIRES[alternative], context).length === 0;
  const source = usable ? alternative : navigation.source;
  if (source !== navigation.source) {
    fallbacks.push({ kind: "navigation", key: "source", requested: navigation.source, resolved: source, failed });
  }
  return { ...navigation, source, requested: navigation.source };
}

/** Filters need a store with enough products for one listing to reach the small-catalogue threshold. */
export const STOREFRONT_FILTERS_REQUIRE: readonly FitCondition[] = [atLeast("productCount", STOREFRONT_FILTER_MIN_RESULTS)];

function resolveFilters(
  filters: StorefrontThemeBlocks["listing"]["filters"],
  context: FitContext,
  fallbacks: StorefrontThemeFallback[],
): ResolvedStorefrontListingFilters {
  const failed = failedFitConditions(STOREFRONT_FILTERS_REQUIRE, context);
  if (failed.length > 0) fallbacks.push({ kind: "filters", key: "listing", requested: filters.style, resolved: null, failed });
  return {
    style: filters.style,
    openByDefault: filters.openByDefault,
    searchPlacement: filters.searchPlacement,
    ruled: filters.ruled,
    ...(filters.order ? { order: filters.order } : {}),
    spec: storefrontListingFilterSpec(filters),
    shown: failed.length === 0,
  };
}

function keepFitting<Item extends string>(
  kind: "toolbar" | "module",
  items: readonly Item[],
  registry: Record<string, { requires: readonly FitCondition[] }>,
  context: FitContext,
  fallbacks: StorefrontThemeFallback[],
): Item[] {
  return items.filter((item) => {
    const failed = failedFitConditions(registry[item]!.requires, context);
    if (failed.length > 0) fallbacks.push({ kind, key: item, requested: item, resolved: null, failed });
    return failed.length === 0;
  });
}

function fittingSections(
  sections: readonly StorefrontSection[],
  context: FitContext,
  fallbacks: StorefrontThemeFallback[],
): StorefrontSection[] {
  return sections.filter((each) => {
    if (each.hidden) return false;
    // An app section fits whenever its app renders it (the API decides).
    if (each.type === "app") return true;
    const failed = failedFitConditions(STOREFRONT_SECTION_REGISTRY[each.type].requires, context);
    if (failed.length > 0) fallbacks.push({ kind: "section", key: each.id, requested: each.type, resolved: null, failed });
    return failed.length === 0;
  }).map(storefrontVisibleSection);
}

/**
 * A template's sections that fit, with its fixed part moved to keep its
 * place among them: `main` counts the shown sections before it.
 */
function resolveTemplate(
  template: StorefrontPageTemplateValue,
  context: FitContext,
  fallbacks: StorefrontThemeFallback[],
): StorefrontPageTemplateValue {
  const before = fittingSections(template.sections.slice(0, template.main), context, fallbacks);
  const after = fittingSections(template.sections.slice(template.main), context, fallbacks);
  return { sections: [...before, ...after], main: before.length };
}

function renders<Render>(slot: StorefrontBlockSlot, block: ResolvedStorefrontBlock): Render {
  return (storefrontVariantSpec(slot, block.variant).renders as (settings: unknown) => Render)(block.settings);
}

/** Resolve a valid document against the store's shape. */
export function resolveStorefrontTheme(document: StorefrontThemeDocument, shape: StoreShape): ResolvedStorefrontTheme {
  const fallbacks: StorefrontThemeFallback[] = [];
  // The navigation source first: menu patterns fit against what the header renders.
  const navigation = resolveNavigation(document.blocks.navigation, shape, fallbacks);
  const facts = storefrontFitFacts(shape, navigation);
  const context: FitContext & { blocks: Record<string, string> } = { facts, blocks: {} };
  const resolved = {} as Record<StorefrontBlockSlot, ResolvedStorefrontBlock>;
  // Registry order resolves the card before the listing that depends on it.
  for (const slot of STOREFRONT_BLOCK_SLOTS) {
    resolved[slot] = resolveBlock(slot, storefrontBlockValue(document.blocks, slot), context, fallbacks);
    context.blocks[slot] = resolved[slot].variant;
  }
  const { listing, product } = document.blocks;
  const filters = resolveFilters(listing.filters, context, fallbacks);
  const toolbar = keepFitting("toolbar", listing.toolbar, STOREFRONT_LISTING_TOOLBAR, context, fallbacks);
  const below = keepFitting("module", product.below, STOREFRONT_PRODUCT_MODULES, context, fallbacks);
  const home = fittingSections(document.pages.home, context, fallbacks);

  const { tokens } = document;
  const card = renders<StorefrontCardRenderer>("card", resolved.card);
  const buyBox = renders<StorefrontBuyBoxRenderer>("buyBox", resolved.buyBox);
  return {
    // A label only: what the theme is based on. Nothing below reads it.
    template: document.template,
    tokens,
    facts,
    blocks: {
      topBar: resolved.topBar,
      header: resolved.header,
      navigation,
      desktopNav: resolved.desktopNav,
      mobileNav: resolved.mobileNav,
      card: resolved.card,
      listing: {
        layout: resolved.listing,
        filters,
        toolbar,
        searchLayout: listing.searchLayout,
        descriptionPlacement: listing.descriptionPlacement,
        phoneLayout: listing.phoneLayout,
        paging: listing.paging,
        surface: listing.surface,
        band: listing.band,
        phoneBar: listing.phoneBar,
        links: listing.links,
        phoneBanner: listing.phoneBanner,
        maxColumns: listing.maxColumns,
      },
      product: { gallery: resolved.gallery, buyBox: resolved.buyBox, below, sticky: product.sticky },
      footer: resolved.footer,
    },
    brand: document.brand,
    pages: {
      ...document.pages,
      home,
      landing: Object.fromEntries(Object.entries(document.pages.landing).map(([slug, page]) => [
        slug, { ...page, sections: fittingSections(page.sections, context, fallbacks) },
      ])),
      templates: Object.fromEntries(STOREFRONT_PAGE_TEMPLATES.map((kind) => [
        kind, resolveTemplate(document.pages.templates[kind], context, fallbacks),
      ])) as StorefrontThemePages["templates"],
    },
    fallbacks,
    layout: {
      topBar: renders<boolean>("topBar", resolved.topBar),
      header: renders<StorefrontHeaderRenderer>("header", resolved.header),
      navigation: renders<StorefrontNavigationRenderer>("desktopNav", resolved.desktopNav),
      mobileNavigation: renders<StorefrontMobileNavigationRenderer>("mobileNav", resolved.mobileNav),
      footer: renders<StorefrontFooterRenderer>("footer", resolved.footer),
      productCard: { ...card, imageRatio: tokens.imageRatio, imageFit: tokens.imageFit, surface: tokens.surface },
      density: tokens.density,
      grid: STOREFRONT_DENSITY_SPECS[tokens.density],
      productPage: renders<StorefrontGalleryRenderer>("gallery", resolved.gallery),
      // The EMI line needs the store's EMI plans (Settings -> EMI).
      buyBox: { ...buyBox, emi: buyBox.emi && facts.hasEmiPlans },
    },
  };
}
