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
import { DEFAULT_STOREFRONT_THEME_BRAND } from "./brand";
import { emptyStorefrontPageTemplates } from "./pages";
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

type Listing = StorefrontThemeBlocks["listing"];

/** What most templates' listings share; each template states only where it departs. */
const LISTING_DEFAULTS = {
  searchLayout: "same",
  descriptionPlacement: "below",
  surface: "muted",
  gutter: "inset",
  band: "standard",
  phoneBar: "standard",
  links: "chips",
  phoneBanner: true,
  maxColumns: null,
} as const satisfies Partial<Listing>;
const FILTER_DEFAULTS = { searchPlacement: "same", ruled: false } as const satisfies Partial<StorefrontListingFilters>;

function blocks(spec: {
  topBar: string;
  header: [string, Record<string, unknown>?];
  navigation: Omit<StorefrontNavigation, "linkBudget"> & { linkBudget?: number };
  desktopNav: [string, Record<string, unknown>?];
  mobileNav: [string, Record<string, unknown>?];
  card: [string, Record<string, unknown>?];
  listing: Partial<Omit<Listing, "layout" | "filters" | "toolbar" | "phoneLayout" | "paging">> & {
    layout: [string, Record<string, unknown>?];
    filters: Omit<StorefrontListingFilters, keyof typeof FILTER_DEFAULTS> & Partial<Pick<StorefrontListingFilters, keyof typeof FILTER_DEFAULTS>>;
    toolbar: StorefrontListingToolbarPiece[];
    phoneLayout: "grid" | "list-row";
    paging: "numbered" | "load-more" | "infinite";
  };
  product: {
    gallery: string | [string, Record<string, unknown>];
    buyBox: [string, Record<string, unknown>?];
    below: StorefrontProductModule[];
    sticky: StorefrontThemeBlocks["product"]["sticky"];
  };
  footer: [string, Record<string, unknown>?];
}): StorefrontThemeBlocks {
  return {
    topBar: pick("topBar", spec.topBar),
    header: pick("header", ...spec.header),
    navigation: { linkBudget: STOREFRONT_NAVIGATION_LINK_BUDGET, ...spec.navigation },
    desktopNav: pick("desktopNav", ...spec.desktopNav),
    mobileNav: pick("mobileNav", ...spec.mobileNav),
    card: pick("card", ...spec.card),
    listing: {
      ...LISTING_DEFAULTS,
      ...spec.listing,
      layout: pick("listing", ...spec.listing.layout),
      filters: { ...FILTER_DEFAULTS, ...spec.listing.filters },
    },
    product: {
      gallery: typeof spec.product.gallery === "string"
        ? pick("gallery", spec.product.gallery)
        : pick("gallery", ...spec.product.gallery),
      buyBox: pick("buyBox", ...spec.product.buyBox),
      below: spec.product.below,
      sticky: spec.product.sticky,
    },
    footer: pick("footer", ...spec.footer),
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
      // Dawn: the page colour behind the grid, the title alone, then the
      // count and sort on one line over the facet bar.
      listing: {
        layout: ["grid"], filters: { style: "bar-dropdowns", openByDefault: false },
        toolbar: ["breadcrumb", "result-count", "sort", "applied-chips"], phoneLayout: "grid", paging: "numbered",
        surface: "page", band: "inline",
      },
      // The stacked gallery keeps its details column sticky (Dawn's sticky info column).
      product: {
        gallery: "stacked",
        buyBox: ["boutique"],
        below: ["description", "content-blocks", "policies", "reviews", "related"],
        sticky: NO_STICKY,
      },
      footer: ["minimal-columns"],
    }),
    // Dawn ends with an email signup: the newsletter section (phone first,
    // the e-mail optional, as everywhere in this market).
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
      header: ["heritage-nav"],
      navigation: { source: "tree+menu", maxTopItems: 11 },
      desktopNav: ["mega-panel"],
      mobileNav: ["accordion-drawer"],
      card: ["portrait"],
      // Aarong: shelves on an airy track, results flush to the container.
      listing: {
        layout: ["shelves", { spacing: "airy" }], filters: { style: "bar-dropdowns", openByDefault: false },
        toolbar: ["breadcrumb", "sort", "applied-chips"], phoneLayout: "grid", paging: "numbered",
        gutter: "flush",
      },
      product: { gallery: "portrait", buyBox: ["heritage"], below: ["description", "reviews", "related", "recently-viewed"], sticky: NO_STICKY },
      footer: ["newsletter-grey"],
    }),
    home: [
      home("hero", "hero", { layout: "full-screen", phoneHeight: "compact" }),
      home("category-tiles", "categories", { style: "photo-grid" }),
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
      // Fabrilife: a flat, ruled department rail and the phone's Filter and
      // Sort row pinned to the bottom of the screen.
      listing: {
        layout: ["grid"], filters: { style: "sidebar-comfortable", openByDefault: true, ruled: true },
        toolbar: ["breadcrumb", "subcategory-pills", "result-count", "sort", "applied-chips"], phoneLayout: "grid", paging: "infinite",
        phoneBar: "bottom",
      },
      product: {
        gallery: "thumbs-below",
        buyBox: ["fashion"],
        below: ["frequently-bought-together", "description", "reviews", "related"],
        sticky: NO_STICKY,
      },
      footer: ["newsletter-grey"],
    }),
    // Fabrilife ends the page with its newsletter band above the footer.
    home: [
      home("hero", "hero", { layout: "full-bleed" }),
      home("usp-strip", "usp"),
      home("product-grid", "new-arrival", { columns: 6, rows: 4 }),
      home("banner", "promos", { layout: "two-up" }),
      home("category-tiles", "categories", { style: "photo" }),
      home("lookbook", "lookbook", { photo: "square" }),
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
      mobileNav: ["bottom-tabs", { tabs: ["home", "categories", "offers", "compare", "account"], drawer: "accordion" }],
      card: ["spec"],
      // Star Tech: price first in a dense rail, the title band beside it,
      // and searches spending the full width on results.
      listing: {
        layout: ["grid"],
        filters: {
          style: "sidebar-dense", openByDefault: true, column: 225, rowPitch: 32, label: 14,
          order: ["price", "availability", "rating", "brand", "other", "category"], searchPlacement: "drawer",
        },
        toolbar: ["breadcrumb", "subcategory-pills", "result-count", "sort", "per-page", "applied-chips"],
        phoneLayout: "grid",
        paging: "numbered",
        band: "beside-filters",
      },
      product: {
        gallery: "thumbs-below",
        buyBox: ["spec"],
        below: ["spec-table", "description", "warranty", "reviews", "related"],
        sticky: { phoneTop: "anchor-bar", phoneBottom: "none", desktop: "anchor-bar" },
      },
      footer: ["support-dark"],
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
    palette: "retail",
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
      mobileNav: ["bottom-tabs", { tabs: ["home", "categories", "offers", "account"], drawer: "accordion" }],
      card: ["tech-rounded"],
      // Apple Gadgets: price first, the category banner on computers only.
      listing: {
        layout: ["grid"],
        filters: {
          style: "sidebar-comfortable", openByDefault: true, column: 316, rowPitch: 28, label: 16,
          order: ["price", "availability", "rating", "brand", "other", "category"],
        },
        toolbar: ["breadcrumb", "category-banner", "result-count", "sort", "applied-chips"], phoneLayout: "grid", paging: "numbered",
        phoneBanner: false,
      },
      product: {
        gallery: "thumbs-below",
        buyBox: ["tech"],
        below: ["spec-table", "description", "warranty", "policies", "reviews", "related", "recently-viewed"],
        sticky: { phoneTop: "none", phoneBottom: "buy-bar", desktop: "none" },
      },
      footer: ["brand-black"],
    }),
    home: [
      home("hero", "hero", { layout: "contained-banners" }),
      home("usp-strip", "usp"),
      home("category-tiles", "categories", { style: "round-small" }),
      home("collections", "rails", { carousel: "compact" }),
      home("banner", "banner"),
      home("brand-wall", "brands", { style: "rail" }),
      home("recently-viewed", "recently-viewed"),
      home("seo-text", "about"),
    ],
  },
  {
    // Large mixed catalogues: category grids, search rows, scoped search.
    id: "marketplace",
    palette: "marketplaceAmazon",
    tokens: {
      typography: "market", typeScale: "flat", headingCase: "sentence", density: "compact",
      radius: "subtle", buttonShape: "radius", surface: "flat", imageRatio: "square", imageFit: "contain",
      headerTone: "dark", container: "full",
    },
    blocks: blocks({
      topBar: "utility",
      header: ["marketplace-search"],
      navigation: { source: "tree+menu", maxTopItems: 18 },
      desktopNav: ["drill-in-drawer"],
      mobileNav: ["drill-in-drawer", { rows: "tall" }],
      card: ["detailed"],
      // Amazon: searches as rows, the phone's chip row with a split facet sheet.
      listing: {
        layout: ["grid"], searchLayout: "list", filters: { style: "sidebar-dense", openByDefault: true, column: 262, rowPitch: 22, label: 14 },
        toolbar: ["aspect-chips", "result-count", "sort", "applied-chips", "grid-list-toggle"],
        phoneLayout: "grid",
        paging: "numbered",
        phoneBar: "split-sheet",
      },
      product: {
        gallery: "thumbs-left",
        buyBox: ["marketplace-3col"],
        below: ["about-bullets", "key-attributes", "spec-table", "description", "warranty", "reviews", "related"],
        sticky: { phoneTop: "anchor-bar", phoneBottom: "buy-bar", desktop: "none" },
      },
      footer: ["directory", { style: "bands" }],
    }),
    home: [
      home("hero", "hero", { layout: "story-cards" }),
      home("category-tiles", "categories", { style: "quad" }),
      home("deal-block", "flash-sale"),
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
      // Target: the phone's pill row of filters and chips, four roomy columns.
      listing: {
        layout: ["grid"], searchLayout: "list", filters: { style: "drawer", openByDefault: false },
        toolbar: ["breadcrumb", "popular-filter-chips", "result-count", "sort", "grid-list-toggle", "applied-chips"],
        phoneLayout: "grid",
        paging: "numbered",
        phoneBar: "pill-row",
        maxColumns: 4,
      },
      product: {
        gallery: "image-grid",
        buyBox: ["retail"],
        below: ["about-bullets", "description", "spec-table", "warranty", "compare-similar", "reviews", "related"],
        sticky: { ...NO_STICKY, desktop: "product-bar" },
      },
      footer: ["minimal-columns"],
    }),
    home: [
      home("hero", "hero", { layout: "full-bleed" }),
      home("banner", "promos", { layout: "four-up" }),
      home("category-tiles", "categories", { style: "round-row" }),
      home("collections", "rails"),
      home("banner", "banner"),
    ],
  },
  {
    // Game Ghor, the common BD WooCommerce shape: 50-3,000 SKUs across departments.
    // The default template keeps the classic product page but gives the store
    // a department-scoped search and a browsable departments rail.
    id: "department-mall",
    palette: "retail",
    tokens: {
      typography: "retail", typeScale: "retail", headingCase: "sentence", density: "compact",
      radius: "subtle", buttonShape: "radius", surface: "hairline", imageRatio: "square", imageFit: "cover",
      headerTone: "light", container: "1200",
    },
    blocks: blocks({
      topBar: "utility",
      header: ["mall-search"],
      navigation: { source: "tree+menu", maxTopItems: 8 },
      desktopNav: ["departments-rail", { open: "home" }],
      mobileNav: ["accordion-drawer"],
      card: ["mall"],
      // No per-page: the default listing stays compact, without extra crawl variants.
      listing: { layout: ["grid"], filters: { style: "sidebar-dense", openByDefault: true, column: 262, rowPitch: 21, label: 14 }, toolbar: ["breadcrumb", "result-count", "sort", "applied-chips"], phoneLayout: "grid", paging: "numbered" },
      product: { gallery: "classic", buyBox: ["mall"], below: ["description", "reviews", "related"], sticky: BUY_BAR },
      footer: ["product-widgets"],
    }),
    home: [
      home("hero", "hero", { layout: "contained-banners" }),
      home("collections", "collections"),
      home("category-tiles", "categories", { style: "photo" }),
      home("usp-strip", "delivery"),
    ],
  },
  {
    // Ghorer Bazar: pantry goods, nested category navigation, filtered product grids.
    id: "daily-essentials",
    palette: "fresh",
    tokens: {
      typography: "fresh", typeScale: "retail", headingCase: "sentence", density: "compact",
      radius: "rounded", buttonShape: "radius", surface: "flat", imageRatio: "square", imageFit: "contain",
      headerTone: "light", container: "1360",
    },
    blocks: blocks({
      topBar: "utility",
      header: ["mall-search", { cartTotal: true }],
      navigation: { source: "tree+menu", maxTopItems: 16 },
      desktopNav: ["sticky-category-bar", { flyouts: "cascading" }],
      mobileNav: ["bottom-tabs", { tabs: ["home", "categories", "cart", "search", "account"], drawer: "drill-in" }],
      card: ["quick-add", { fullAction: true }],
      listing: { layout: ["grid"], filters: { style: "sidebar-comfortable", openByDefault: true }, toolbar: ["breadcrumb", "result-count", "sort", "applied-chips"], phoneLayout: "grid", paging: "numbered" },
      product: { gallery: ["thumbs-left", { phoneSideThumbnails: false }], buyBox: ["essentials"], below: ["description", "related"], sticky: NO_STICKY },
      footer: ["directory"],
    }),
    home: [
      home("hero", "hero", { layout: "full-bleed" }),
      home("category-tiles", "categories", { style: "photo" }),
      home("product-grid", "popular", { title: "Top selling products", source: { kind: "popular" }, columns: 4, rows: 1 }),
      home("brand-wall", "brands", { style: "rail" }),
      home("product-grid", "offers", { source: { kind: "on-sale" }, columns: 4, rows: 2 }),
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
      header: ["showcase-simple"],
      navigation: { source: "menu", maxTopItems: 6 },
      desktopNav: ["dropdown"],
      mobileNav: ["accordion-drawer"],
      card: ["showcase"],
      // A launch store's collection links read as one tab strip starting with "All".
      listing: {
        layout: ["grid"], filters: { style: "drawer", openByDefault: false },
        toolbar: ["subcategory-pills", "facet-value-chips", "result-count", "sort", "applied-chips"], phoneLayout: "grid", paging: "numbered",
        links: "tabs",
      },
      product: { gallery: "stacked", buyBox: ["showcase"], below: ["content-blocks", "description", "reviews"], sticky: BUY_BAR },
      footer: ["minimal-columns"],
    }),
    // A landing page opens on its offer: the hero, the store's own delivery
    // and payment facts, then the products themselves, before the story,
    // proof and questions the merchant writes.
    home: [
      home("hero", "hero", { layout: "full-bleed" }),
      home("usp-strip", "promise"),
      home("product-grid", "featured", { columns: 3, rows: 2 }),
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
    brand: { ...DEFAULT_STOREFRONT_THEME_BRAND },
    blocks: structuredClone(template.blocks) as StorefrontThemeBlocks,
    pages: { home: structuredClone(template.home) as StorefrontSection[], homeMode: { kind: "sections" }, landing: {}, templates: emptyStorefrontPageTemplates() },
  };
}

/**
 * Every store without a saved theme renders this: Department mall, with a
 * department search and the owner-protected classic product page.
 */
export const DEFAULT_STOREFRONT_TEMPLATE: StorefrontTemplateId = "department-mall";
export const DEFAULT_STOREFRONT_THEME: StorefrontThemeDocument = deepFreeze(storefrontTemplateTheme(DEFAULT_STOREFRONT_TEMPLATE));
