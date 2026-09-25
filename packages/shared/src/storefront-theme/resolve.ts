// One resolver for the storefront and the dashboard: a document plus the
// store's shape give the variants that actually render (after fit
// fallbacks), the navigation source and filter style that apply, each
// card's concrete look, the sections that have data to show, and the facts
// today's storefront components read. The dashboard preview and the live
// store run this same function on the same inputs, so they always agree.
import {
  STOREFRONT_BLOCK_SLOTS,
  STOREFRONT_FILTER_MIN_RESULTS,
  storefrontListingFilterSpec,
  STOREFRONT_LISTING_TOOLBAR,
  STOREFRONT_PRODUCT_MODULES,
  storefrontBlockDefault,
  storefrontBlockValue,
  storefrontVariantSpec,
  type StorefrontBlockSlot,
  type StorefrontCardLook,
  type StorefrontCardRenderer,
  type StorefrontFooterRenderer,
  type StorefrontBuyBoxRenderer,
  type StorefrontGalleryRenderer,
  type StorefrontHeaderRenderer,
  type StorefrontListingFilterSpec,
  type StorefrontListingFilterStyle,
  type StorefrontListingToolbarPiece,
  type StorefrontMobileNavigationRenderer,
  type StorefrontNavigation,
  type StorefrontNavigationRenderer,
  type StorefrontProductModule,
  type StorefrontThemeBlocks,
} from "./blocks";
import type { StorefrontTemplateId, StorefrontThemeDocument } from "./document";
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
import { STOREFRONT_SECTION_REGISTRY, type StorefrontSection } from "./sections";
import {
  STOREFRONT_DENSITY_SPECS,
  STOREFRONT_IMAGE_RATIO_VALUES,
  STOREFRONT_RADIUS_PX,
  storefrontNearestImageRatio,
  type StorefrontDensity,
  type StorefrontDensitySpec,
  type StorefrontImageRatio,
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
 * A card's look with every value concrete. The standard card follows the
 * template's tokens (photo ratio and fit, radius, surface) and keeps its
 * type on the theme's type scale (`title` and `price` null), so today's card
 * stays pixel-identical; every other card carries its own measured look.
 */
export interface ResolvedStorefrontCardLook {
  image: StorefrontCardLook["image"];
  radius: number;
  surface: StorefrontThemeSurface;
  title: StorefrontCardLook["title"] | null;
  price: StorefrontCardLook["price"] | null;
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
  productCard: Omit<StorefrontCardRenderer, "look"> & {
    /** The ratio token nearest the card's own photo ratio (today's grid code reads it). */
    imageRatio: StorefrontImageRatio;
    look: ResolvedStorefrontCardLook;
  };
  /** The card's surface as today's card CSS names it. */
  cardSurface: "flat" | "bordered" | "elevated";
  density: StorefrontDensity;
  grid: StorefrontDensitySpec;
  productPage: StorefrontGalleryRenderer;
  /** The buy box's look (null: today's classic) and its EMI and WhatsApp strips. */
  buyBox: StorefrontBuyBoxRenderer;
}

/** The card as renderers read it: its anatomy, the nearest ratio token and its concrete look. */
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
    listing: {
      layout: ResolvedStorefrontBlock;
      filters: ResolvedStorefrontListingFilters;
      toolbar: StorefrontListingToolbarPiece[];
      phoneLayout: StorefrontThemeBlocks["listing"]["phoneLayout"];
      paging: StorefrontThemeBlocks["listing"]["paging"];
    };
    product: {
      gallery: ResolvedStorefrontBlock;
      buyBox: ResolvedStorefrontBlock;
      below: StorefrontProductModule[];
      sticky: StorefrontThemeBlocks["product"]["sticky"];
    };
    footer: ResolvedStorefrontBlock;
  };
  pages: { home: StorefrontSection[] };
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
    current = storefrontBlockDefault(slot, spec.fallback);
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
  return { style: filters.style, openByDefault: filters.openByDefault, spec: storefrontListingFilterSpec(filters), shown: failed.length === 0 };
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
    const failed = failedFitConditions(STOREFRONT_SECTION_REGISTRY[each.type].requires, context);
    if (failed.length > 0) fallbacks.push({ kind: "section", key: each.id, requested: each.type, resolved: null, failed });
    return failed.length === 0;
  });
}

const SURFACE_RENDERERS = { flat: "flat", hairline: "bordered", raised: "elevated" } as const;

function renders<Render>(slot: StorefrontBlockSlot, block: ResolvedStorefrontBlock): Render {
  return (storefrontVariantSpec(slot, block.variant).renders as (settings: unknown) => Render)(block.settings);
}

/** A card's concrete look: its own, or the template's tokens for the standard card. */
export function resolveStorefrontCardLook(
  look: StorefrontCardLook | null,
  tokens: Pick<StorefrontThemeTokens, "imageRatio" | "imageFit" | "radius" | "surface">,
): ResolvedStorefrontCardLook {
  if (look) return structuredClone(look) as ResolvedStorefrontCardLook;
  return {
    image: { ratio: STOREFRONT_IMAGE_RATIO_VALUES[tokens.imageRatio], fit: tokens.imageFit },
    radius: STOREFRONT_RADIUS_PX[tokens.radius],
    surface: tokens.surface,
    title: null,
    price: null,
  };
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
  const { look: ownLook, ...card } = renders<StorefrontCardRenderer>("card", resolved.card);
  const look = resolveStorefrontCardLook(ownLook, tokens);
  return {
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
      listing: { layout: resolved.listing, filters, toolbar, phoneLayout: listing.phoneLayout, paging: listing.paging },
      product: { gallery: resolved.gallery, buyBox: resolved.buyBox, below, sticky: product.sticky },
      footer: resolved.footer,
    },
    pages: { home },
    fallbacks,
    layout: {
      topBar: renders<boolean>("topBar", resolved.topBar),
      header: renders<StorefrontHeaderRenderer>("header", resolved.header),
      navigation: renders<StorefrontNavigationRenderer>("desktopNav", resolved.desktopNav),
      mobileNavigation: renders<StorefrontMobileNavigationRenderer>("mobileNav", resolved.mobileNav),
      footer: renders<StorefrontFooterRenderer>("footer", resolved.footer),
      productCard: {
        ...card,
        imageRatio: ownLook ? storefrontNearestImageRatio(look.image.ratio) : tokens.imageRatio,
        look,
      },
      cardSurface: SURFACE_RENDERERS[look.surface],
      density: tokens.density,
      grid: STOREFRONT_DENSITY_SPECS[tokens.density],
      productPage: renders<StorefrontGalleryRenderer>("gallery", resolved.gallery),
      buyBox: renders<StorefrontBuyBoxRenderer>("buyBox", resolved.buyBox),
    },
  };
}
