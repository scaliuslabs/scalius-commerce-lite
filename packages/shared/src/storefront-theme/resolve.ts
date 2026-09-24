// One resolver for the storefront and the dashboard: a document plus the
// store's shape give the variants that actually render (after fit
// fallbacks), the sections that have data to show, and the facts today's
// storefront components read. The dashboard preview and the live store run
// this same function on the same inputs, so they always agree.
import {
  STOREFRONT_BLOCK_SLOTS,
  STOREFRONT_LISTING_TOOLBAR,
  STOREFRONT_PRODUCT_MODULES,
  storefrontBlockDefault,
  storefrontBlockValue,
  storefrontVariantSpec,
  type StorefrontBlockSlot,
  type StorefrontCardRenderer,
  type StorefrontFooterRenderer,
  type StorefrontGalleryRenderer,
  type StorefrontHeaderRenderer,
  type StorefrontListingToolbarPiece,
  type StorefrontMobileNavigationRenderer,
  type StorefrontNavigationRenderer,
  type StorefrontProductModule,
  type StorefrontThemeBlocks,
} from "./blocks";
import type { StorefrontTemplateId, StorefrontThemeDocument } from "./document";
import { failedFitConditions, type FitCondition, type FitContext, type StoreShape } from "./fit";
import { STOREFRONT_SECTION_REGISTRY, type StorefrontSection } from "./sections";
import {
  STOREFRONT_DENSITY_SPECS,
  type StorefrontDensity,
  type StorefrontDensitySpec,
  type StorefrontImageRatio,
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
  kind: "block" | "toolbar" | "module" | "section";
  /** Block slot, toolbar piece, module, or section id. */
  key: string;
  requested: string;
  /** What renders instead; null when it is left out. */
  resolved: string | null;
  /** The conditions the store did not meet. */
  failed: FitCondition[];
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
  productCard: StorefrontCardRenderer & { imageRatio: StorefrontImageRatio };
  cardSurface: "flat" | "bordered" | "elevated";
  density: StorefrontDensity;
  grid: StorefrontDensitySpec;
  productPage: StorefrontGalleryRenderer;
}

export interface ResolvedStorefrontTheme {
  template: StorefrontTemplateId;
  tokens: StorefrontThemeTokens;
  blocks: {
    topBar: ResolvedStorefrontBlock;
    header: ResolvedStorefrontBlock;
    desktopNav: ResolvedStorefrontBlock;
    mobileNav: ResolvedStorefrontBlock;
    card: ResolvedStorefrontBlock;
    listing: {
      layout: ResolvedStorefrontBlock;
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

/** Resolve a valid document against the store's shape. */
export function resolveStorefrontTheme(document: StorefrontThemeDocument, shape: StoreShape): ResolvedStorefrontTheme {
  const fallbacks: StorefrontThemeFallback[] = [];
  const context: FitContext & { blocks: Record<string, string> } = { shape, blocks: {} };
  const resolved = {} as Record<StorefrontBlockSlot, ResolvedStorefrontBlock>;
  // Registry order resolves the card before the listing that depends on it.
  for (const slot of STOREFRONT_BLOCK_SLOTS) {
    resolved[slot] = resolveBlock(slot, storefrontBlockValue(document.blocks, slot), context, fallbacks);
    context.blocks[slot] = resolved[slot].variant;
  }
  const { listing, product } = document.blocks;
  const toolbar = keepFitting("toolbar", listing.toolbar, STOREFRONT_LISTING_TOOLBAR, context, fallbacks);
  const below = keepFitting("module", product.below, STOREFRONT_PRODUCT_MODULES, context, fallbacks);
  const home = fittingSections(document.pages.home, context, fallbacks);

  const { tokens } = document;
  const card = renders<StorefrontCardRenderer>("card", resolved.card);
  return {
    template: document.template,
    tokens,
    blocks: {
      topBar: resolved.topBar,
      header: resolved.header,
      desktopNav: resolved.desktopNav,
      mobileNav: resolved.mobileNav,
      card: resolved.card,
      listing: { layout: resolved.listing, toolbar, phoneLayout: listing.phoneLayout, paging: listing.paging },
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
      productCard: { ...card, imageRatio: tokens.imageRatio },
      cardSurface: SURFACE_RENDERERS[tokens.surface],
      density: tokens.density,
      grid: STOREFRONT_DENSITY_SPECS[tokens.density],
      productPage: renders<StorefrontGalleryRenderer>("gallery", resolved.gallery),
    },
  };
}
