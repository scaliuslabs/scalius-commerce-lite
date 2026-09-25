// The ten templates: frozen data, one variant per block plus token values
// and a default homepage, each copying the layout grammar (structure,
// density and ratios) of measured sites, never their brand identity
// (SYNTHESIS.md section 4). Choosing a template copies it into the
// document; changing a block keeps `template` as the "based on" label.
import {
  STOREFRONT_NAVIGATION_LINK_BUDGET,
  storefrontBlockDefault,
  type StorefrontBlockSlot,
  type StorefrontListingFilters,
  type StorefrontListingToolbarPiece,
  type StorefrontNavigation,
  type StorefrontProductModule,
  type StorefrontThemeBlocks,
} from "./blocks";
import {
  STOREFRONT_THEME_DOCUMENT_VERSION,
  STOREFRONT_TEMPLATE_IDS,
  type StorefrontTemplateId,
  type StorefrontThemeDocument,
} from "./document";
import {
  STOREFRONT_SECTION_REGISTRY,
  type StorefrontSection,
  type StorefrontSectionType,
} from "./sections";
import {
  STOREFRONT_THEME_PALETTES,
  type StorefrontThemePaletteKey,
  type StorefrontThemeTokens,
} from "./tokens";

export interface StorefrontTemplate {
  readonly id: StorefrontTemplateId;
  readonly palette: StorefrontThemePaletteKey;
  readonly tokens: Readonly<Omit<StorefrontThemeTokens, "colors">>;
  readonly blocks: StorefrontThemeBlocks;
  readonly home: readonly StorefrontSection[];
}

/** A block value: the variant's defaults with these settings on top. */
function pick(slot: StorefrontBlockSlot, id: string, settings: Record<string, unknown> = {}) {
  const block = storefrontBlockDefault(slot, id);
  return { variant: id, settings: { ...block.settings, ...settings } };
}

/** A section with its default settings and these on top. */
function home(type: StorefrontSectionType, id: string, settings: Record<string, unknown> = {}): StorefrontSection {
  const defaults = STOREFRONT_SECTION_REGISTRY[type].defaults as Record<string, unknown>;
  // Editorial settings are one shape per layout: another layout replaces them whole.
  const whole = "layout" in settings && type === "editorial";
  return { id, type, version: 1, settings: whole ? settings : { ...structuredClone(defaults), ...settings } } as StorefrontSection;
}

function blocks(spec: {
  topBar: string;
  header: [string, Record<string, unknown>?];
  navigation: Omit<StorefrontNavigation, "linkBudget"> & { linkBudget?: number };
  desktopNav: [string, Record<string, unknown>?];
  mobileNav: [string, Record<string, unknown>?];
  card: [string, Record<string, unknown>?];
  listing: {
    layout: [string, Record<string, unknown>?];
    filters: StorefrontListingFilters;
    toolbar: StorefrontListingToolbarPiece[];
    phoneLayout: "grid" | "list-row";
    paging: "numbered" | "load-more" | "infinite";
  };
  product: {
    gallery: string;
    buyBox: [string, Record<string, unknown>?];
    below: StorefrontProductModule[];
    sticky: StorefrontThemeBlocks["product"]["sticky"];
  };
  footer: string;
}): StorefrontThemeBlocks {
  return {
    topBar: pick("topBar", spec.topBar),
    header: pick("header", ...spec.header),
    navigation: { linkBudget: STOREFRONT_NAVIGATION_LINK_BUDGET, ...spec.navigation },
    desktopNav: pick("desktopNav", ...spec.desktopNav),
    mobileNav: pick("mobileNav", ...spec.mobileNav),
    card: pick("card", ...spec.card),
    listing: { ...spec.listing, layout: pick("listing", ...spec.listing.layout) },
    product: {
      gallery: pick("gallery", spec.product.gallery),
      buyBox: pick("buyBox", ...spec.product.buyBox),
      below: spec.product.below,
      sticky: spec.product.sticky,
    },
    footer: pick("footer", spec.footer),
  } as StorefrontThemeBlocks;
}

const NO_STICKY = { phoneTop: "none", phoneBottom: "none", desktop: "none" } as const;
const BUY_BAR = { phoneTop: "none", phoneBottom: "buy-bar", desktop: "none" } as const;

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const TEMPLATES: readonly StorefrontTemplate[] = [
  {
    // Dawn: 5-200 products, one brand. Airy, display type, square corners.
    id: "boutique",
    palette: "boutique",
    tokens: {
      typography: "editorial", typeScale: "display", headingCase: "sentence", density: "airy",
      radius: "square", buttonShape: "radius", surface: "flat", imageRatio: "square", imageFit: "cover",
      headerTone: "light", container: "1200",
    },
    blocks: blocks({
      topBar: "announcement",
      header: ["boutique-inline"],
      navigation: { source: "menu", maxTopItems: 6 },
      desktopNav: ["dropdown"],
      mobileNav: ["accordion-drawer"],
      card: ["boutique"],
      listing: { layout: ["grid"], filters: { style: "bar-dropdowns", openByDefault: false }, toolbar: ["breadcrumb", "result-count", "sort", "applied-chips"], phoneLayout: "grid", paging: "numbered" },
      product: {
        gallery: "stacked",
        buyBox: ["boutique"],
        below: ["description", "policies", "content-blocks", "related"],
        sticky: { ...NO_STICKY, desktop: "info-column" },
      },
      footer: "minimal-columns",
    }),
    home: [
      home("hero", "hero", { layout: "split" }),
      home("editorial", "intro"),
      home("product-grid", "featured", { columns: 4, rows: 2 }),
      home("editorial", "values", { layout: "multicolumn", heading: "", columns: [] }),
      home("editorial", "testimonials", { layout: "testimonial", quotes: [] }),
      home("newsletter", "newsletter"),
    ],
  },
  {
    // Aarong: fashion, crafts, sarees. Portrait photos, uppercase headings, shelves.
    id: "heritage-editorial",
    palette: "heritage",
    tokens: {
      typography: "heritage", typeScale: "display", headingCase: "uppercase", density: "airy",
      radius: "square", buttonShape: "radius", surface: "flat", imageRatio: "portrait", imageFit: "cover",
      headerTone: "light", container: "1360",
    },
    blocks: blocks({
      topBar: "none",
      header: ["fashion-department", { subBrandRow: true }],
      navigation: { source: "tree+menu", maxTopItems: 11 },
      desktopNav: ["mega-panel"],
      mobileNav: ["accordion-drawer"],
      card: ["portrait"],
      listing: { layout: ["shelves"], filters: { style: "bar-dropdowns", openByDefault: false }, toolbar: ["breadcrumb", "sort", "applied-chips"], phoneLayout: "grid", paging: "numbered" },
      product: { gallery: "portrait", buyBox: ["fashion"], below: ["description", "related", "recently-viewed"], sticky: NO_STICKY },
      footer: "newsletter-grey",
    }),
    home: [
      home("hero", "hero", { layout: "full-screen" }),
      home("category-tiles", "categories", { style: "photo" }),
      home("banner", "campaign"),
      home("product-rail", "whats-new", { source: { kind: "newest" } }),
      home("banner", "campaign-2"),
    ],
  },
  {
    // Fabrilife: apparel, 200-5,000 SKUs. Mega panel with promo images, lookbooks.
    id: "fashion-value",
    palette: "beauty",
    tokens: {
      typography: "retail", typeScale: "retail", headingCase: "uppercase", density: "compact",
      radius: "square", buttonShape: "radius", surface: "flat", imageRatio: "square", imageFit: "cover",
      headerTone: "light", container: "1360",
    },
    blocks: blocks({
      topBar: "announcement",
      header: ["fashion-department"],
      navigation: { source: "tree+menu", maxTopItems: 6 },
      desktopNav: ["mega-panel", { promoImages: true }],
      mobileNav: ["bottom-tabs"],
      card: ["fashion-value"],
      listing: { layout: ["grid"], filters: { style: "sidebar-comfortable", openByDefault: true }, toolbar: ["breadcrumb", "result-count", "sort", "applied-chips"], phoneLayout: "grid", paging: "infinite" },
      product: {
        gallery: "thumbs-below",
        buyBox: ["fashion"],
        below: ["frequently-bought-together", "description", "related"],
        sticky: NO_STICKY,
      },
      footer: "newsletter-grey",
    }),
    home: [
      home("hero", "hero", { layout: "full-bleed" }),
      home("usp-strip", "usp"),
      home("product-grid", "new-arrival", { columns: 6, rows: 4 }),
      home("banner", "promos", { layout: "two-up" }),
      home("category-tiles", "categories", { style: "photo" }),
      home("lookbook", "lookbook"),
      home("newsletter", "newsletter"),
    ],
  },
  {
    // Star Tech: electronics and components, 5k-50k SKUs. Dense, flat type, dark header.
    id: "spec-catalogue",
    palette: "marketplace",
    tokens: {
      typography: "market", typeScale: "flat", headingCase: "sentence", density: "dense",
      radius: "subtle", buttonShape: "radius", surface: "flat", imageRatio: "square", imageFit: "contain",
      headerTone: "dark", container: "1290",
    },
    blocks: blocks({
      topBar: "none",
      header: ["spec-two-row"],
      navigation: { source: "category-tree", maxTopItems: 18 },
      desktopNav: ["sticky-category-bar", { flyouts: "cascading" }],
      mobileNav: ["bottom-tabs", { tabs: ["home", "categories", "compare", "cart", "account"], drawer: "accordion" }],
      card: ["spec"],
      listing: {
        layout: ["grid"], filters: { style: "sidebar-dense", openByDefault: true, column: 225, rowPitch: 32, label: 14 }, // Star Tech
        toolbar: ["breadcrumb", "subcategory-pills", "result-count", "sort", "per-page"],
        phoneLayout: "list-row",
        paging: "numbered",
      },
      product: {
        gallery: "thumbs-below",
        buyBox: ["spec"],
        below: ["spec-table", "description", "questions", "reviews", "related"],
        sticky: { phoneTop: "anchor-bar", phoneBottom: "none", desktop: "anchor-bar" },
      },
      footer: "support-dark",
    }),
    home: [
      home("hero", "hero", { layout: "contained-banners" }),
      home("usp-strip", "notice", { style: "ticker" }),
      home("utility-cards", "finders"),
      home("category-tiles", "categories", { style: "icons" }),
      home("product-grid", "featured", { columns: 5, rows: 4 }),
      home("seo-text", "about"),
    ],
  },
  {
    // Apple Gadgets: premium gadgets and phones. Soft corners, pills, raised cards, rails.
    id: "rounded-tech",
    palette: "midnight",
    tokens: {
      typography: "tech", typeScale: "retail", headingCase: "sentence", density: "comfortable",
      radius: "soft", buttonShape: "pill", surface: "raised", imageRatio: "square", imageFit: "contain",
      headerTone: "dark", container: "1360",
    },
    blocks: blocks({
      topBar: "none",
      header: ["tech-rounded"],
      navigation: { source: "category-tree", maxTopItems: 9 },
      desktopNav: ["dropdown"],
      mobileNav: ["bottom-tabs"],
      card: ["tech-rounded"],
      listing: { layout: ["grid"], filters: { style: "sidebar-comfortable", openByDefault: true, column: 316, rowPitch: 28, label: 16 }, toolbar: ["breadcrumb", "category-banner", "result-count", "sort"], phoneLayout: "grid", paging: "numbered" },
      product: {
        gallery: "thumbs-below",
        buyBox: ["tech"],
        below: ["spec-table", "description", "policies", "related", "recently-viewed"],
        sticky: { phoneTop: "none", phoneBottom: "buy-bar", desktop: "side-rail" },
      },
      footer: "brand-black",
    }),
    home: [
      home("hero", "hero", { layout: "contained-banners" }),
      home("usp-strip", "usp"),
      home("category-tiles", "categories", { style: "round" }),
      home("collections", "rails"),
      home("banner", "banner"),
      home("seo-text", "about"),
    ],
  },
  {
    // Daraz and Amazon: very large mixed catalogues. Brand header, drill-in menus.
    id: "marketplace",
    palette: "marketplace",
    tokens: {
      typography: "market", typeScale: "flat", headingCase: "sentence", density: "dense",
      radius: "subtle", buttonShape: "radius", surface: "flat", imageRatio: "square", imageFit: "contain",
      headerTone: "brand", container: "full",
    },
    blocks: blocks({
      topBar: "utility",
      header: ["marketplace-search"],
      navigation: { source: "tree+menu", maxTopItems: 18 },
      desktopNav: ["drill-in-drawer"],
      mobileNav: ["drill-in-drawer"],
      card: ["marketplace"],
      listing: {
        layout: ["grid"], filters: { style: "sidebar-dense", openByDefault: true, column: 190, rowPitch: 18, label: 13 }, // Daraz
        toolbar: ["breadcrumb", "aspect-chips", "result-count", "sort", "grid-list-toggle"],
        phoneLayout: "grid",
        paging: "numbered",
      },
      product: {
        gallery: "thumbs-below",
        buyBox: ["marketplace-3col"],
        below: ["key-attributes", "spec-table", "reviews", "questions", "related"],
        sticky: { phoneTop: "anchor-bar", phoneBottom: "buy-bar", desktop: "none" },
      },
      footer: "directory",
    }),
    home: [
      home("hero", "hero", { layout: "app-panel" }),
      home("deal-block", "flash-sale"),
      home("category-tiles", "categories", { style: "icons" }),
      home("endless-grid", "for-you"),
    ],
  },
  {
    // Target and Walmart: household and general merchandise. Pills, filter bar, fulfilment.
    id: "mass-retail",
    palette: "marketplace",
    tokens: {
      typography: "retail", typeScale: "retail", headingCase: "sentence", density: "comfortable",
      radius: "rounded", buttonShape: "pill", surface: "flat", imageRatio: "square", imageFit: "contain",
      headerTone: "brand", container: "1440",
    },
    blocks: blocks({
      topBar: "utility",
      header: ["retail-pill"],
      navigation: { source: "tree+menu", maxTopItems: 17 },
      desktopNav: ["drill-in-drawer"],
      mobileNav: ["drill-in-drawer"],
      card: ["retail"],
      listing: {
        layout: ["grid"], filters: { style: "sidebar-dense", openByDefault: true },
        toolbar: ["breadcrumb", "popular-filter-chips", "result-count", "sort", "applied-chips"],
        phoneLayout: "list-row",
        paging: "numbered",
      },
      product: {
        gallery: "image-grid",
        buyBox: ["retail"],
        below: ["key-attributes", "description", "spec-table", "questions", "compare-similar", "reviews", "related"],
        sticky: { ...NO_STICKY, desktop: "product-bar" },
      },
      footer: "minimal-columns",
    }),
    home: [
      home("hero", "hero", { layout: "full-bleed" }),
      home("banner", "promos", { layout: "four-up" }),
      home("category-tiles", "categories", { style: "round" }),
      home("collections", "rails"),
      home("banner", "banner"),
    ],
  },
  {
    // Game Ghor, the common BD WooCommerce shape: 50-3,000 SKUs across departments.
    // The default template: it renders today's classic store and product page.
    id: "department-mall",
    palette: "retail",
    tokens: {
      typography: "retail", typeScale: "retail", headingCase: "sentence", density: "compact",
      radius: "subtle", buttonShape: "radius", surface: "hairline", imageRatio: "square", imageFit: "cover",
      headerTone: "light", container: "1440",
    },
    blocks: blocks({
      topBar: "announcement",
      header: ["mall-departments"],
      navigation: { source: "tree+menu", maxTopItems: 8 },
      desktopNav: ["dropdown"],
      mobileNav: ["accordion-drawer"],
      card: ["standard"],
      // No per-page: the default listing stays today's (pixel-identical), and
      // most stores get no extra crawl variant.
      listing: { layout: ["grid"], filters: { style: "sidebar-dense", openByDefault: true, column: 262, rowPitch: 22, label: 14 }, toolbar: ["breadcrumb", "result-count", "sort"], phoneLayout: "grid", paging: "numbered" },
      product: { gallery: "classic", buyBox: ["classic"], below: ["description", "related"], sticky: BUY_BAR },
      footer: "product-widgets",
    }),
    home: [
      home("hero", "hero", { layout: "contained-banners" }),
      home("collections", "collections"),
      home("category-tiles", "categories", { style: "photo" }),
      home("usp-strip", "delivery"),
    ],
  },
  {
    // Chaldal: grocery, pharmacy, repeat buys. Always-open rail, quick-add grid.
    id: "daily-essentials",
    palette: "fresh",
    tokens: {
      typography: "fresh", typeScale: "retail", headingCase: "sentence", density: "compact",
      radius: "rounded", buttonShape: "pill", surface: "flat", imageRatio: "square", imageFit: "contain",
      headerTone: "light", container: "full",
    },
    blocks: blocks({
      topBar: "none",
      header: ["grocery-shell"],
      navigation: { source: "tree+menu", maxTopItems: 16 },
      desktopNav: ["departments-rail", { open: "always" }],
      mobileNav: ["accordion-drawer"],
      card: ["quick-add"],
      listing: { layout: ["quick-grid"], filters: { style: "drawer", openByDefault: false }, toolbar: ["breadcrumb", "sort"], phoneLayout: "grid", paging: "load-more" },
      product: { gallery: "thumbs-below", buyBox: ["classic"], below: ["description", "related"], sticky: BUY_BAR },
      footer: "minimal-columns",
    }),
    home: [
      home("hero", "hero", { layout: "full-bleed" }),
      home("category-tiles", "categories", { style: "icons" }),
      home("product-grid", "popular", { source: { kind: "popular" }, columns: 6, rows: 2 }),
      home("product-grid", "offers", { source: { kind: "on-sale" }, columns: 6, rows: 1 }),
    ],
  },
  {
    // Launch and F-commerce stores with 1-20 hero products: long content, repeated buy CTA.
    id: "showcase-landing",
    palette: "retail",
    tokens: {
      typography: "retail", typeScale: "display", headingCase: "sentence", density: "comfortable",
      radius: "rounded", buttonShape: "pill", surface: "flat", imageRatio: "square", imageFit: "cover",
      headerTone: "light", container: "1200",
    },
    blocks: blocks({
      topBar: "announcement",
      header: ["boutique-inline"],
      navigation: { source: "menu", maxTopItems: 6 },
      desktopNav: ["dropdown"],
      mobileNav: ["accordion-drawer"],
      card: ["boutique", { hoverImage: false }],
      listing: { layout: ["grid"], filters: { style: "drawer", openByDefault: false }, toolbar: ["result-count", "sort"], phoneLayout: "grid", paging: "numbered" },
      product: { gallery: "stacked", buyBox: ["boutique"], below: ["content-blocks", "description", "reviews"], sticky: BUY_BAR },
      footer: "minimal-columns",
    }),
    home: [
      home("hero", "hero", { layout: "full-bleed" }),
      home("editorial", "feature", { layout: "image-with-text", heading: "", body: "", mediaId: null, imageSide: "end" }),
      home("editorial", "highlights", { layout: "multicolumn", heading: "", columns: [] }),
      home("editorial", "testimonials", { layout: "testimonial", quotes: [] }),
      home("faq", "faq"),
      home("banner", "order"),
    ],
  },
];

/** The ten templates in gallery order, frozen. */
export const STOREFRONT_TEMPLATES: readonly StorefrontTemplate[] = deepFreeze(
  STOREFRONT_TEMPLATE_IDS.map((id) => TEMPLATES.find((template) => template.id === id)!),
);

export function storefrontTemplate(id: StorefrontTemplateId): StorefrontTemplate {
  return STOREFRONT_TEMPLATES.find((template) => template.id === id)!;
}

/** The complete document a template stands for, in the given palette (its own by default). */
export function storefrontTemplateTheme(
  id: StorefrontTemplateId,
  palette: StorefrontThemePaletteKey = storefrontTemplate(id).palette,
): StorefrontThemeDocument {
  const template = storefrontTemplate(id);
  return {
    version: STOREFRONT_THEME_DOCUMENT_VERSION,
    template: id,
    tokens: { ...structuredClone(template.tokens), colors: { ...STOREFRONT_THEME_PALETTES[palette] } } as StorefrontThemeTokens,
    blocks: structuredClone(template.blocks) as StorefrontThemeBlocks,
    pages: { home: structuredClone(template.home) as StorefrontSection[] },
  };
}

/**
 * Every store without a saved theme renders this: Department mall, which
 * renders today's classic store and the owner-protected product page.
 */
export const DEFAULT_STOREFRONT_TEMPLATE: StorefrontTemplateId = "department-mall";
export const DEFAULT_STOREFRONT_THEME: StorefrontThemeDocument = deepFreeze(storefrontTemplateTheme(DEFAULT_STOREFRONT_TEMPLATE));
