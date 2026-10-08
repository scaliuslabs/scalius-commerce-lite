// The five presets of one design system ("Scalius Base"): frozen data, one
// variant per block plus token values and a default homepage. A preset is a
// combination of tokens and block choices, never a look of its own: every
// block draws with the same tokens in every preset. Choosing a preset copies
// it into the document; changing a block keeps `template` as the "based on"
// label.
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
    // Department (the default): a general store of 50-3,000 SKUs across
    // departments. Department search, a mega menu, hairline cards with an
    // Add to cart button, and the owner-protected classic product page.
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
      desktopNav: ["mega-panel"],
      mobileNav: ["accordion-drawer"],
      card: ["standard", { facts: "none", action: "full" }],
      // No per-page: the default listing stays compact, without extra crawl variants.
      listing: { layout: ["grid"], filters: { style: "sidebar-dense", openByDefault: true, column: 262, rowPitch: 24, label: 14 }, toolbar: ["breadcrumb", "result-count", "sort", "applied-chips"], phoneLayout: "grid", paging: "numbered" },
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
    // Boutique: 5-200 products, one brand, often fashion. Airy, display type,
    // square corners, flat cards with colour swatches and a second photo.
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
      card: ["standard", { facts: "swatches", action: "none", hoverImage: true }],
      // The page colour behind the grid, the title alone, then the count and
      // sort on one line over the facet bar.
      listing: {
        layout: ["grid"], filters: { style: "bar-dropdowns", openByDefault: false },
        toolbar: ["breadcrumb", "result-count", "sort", "applied-chips"], phoneLayout: "grid", paging: "numbered",
        surface: "page", band: "inline",
      },
      // The stacked gallery keeps its details column sticky.
      product: {
        gallery: "stacked",
        buyBox: ["boutique"],
        below: ["description", "content-blocks", "policies", "reviews", "related"],
        sticky: NO_STICKY,
      },
      footer: ["minimal-columns"],
    }),
    // It ends with the newsletter (phone first, the e-mail optional, as
    // everywhere in this market).
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
    // Marketplace: large mixed catalogues. Category grids, scoped search,
    // dense flat cards with the delivery line, searches as rows.
    id: "marketplace",
    palette: "marketplace",
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
      mobileNav: ["drill-in-drawer"],
      card: ["standard", { facts: "delivery", action: "none" }],
      // Searches as rows, the phone's chip row with a split facet sheet.
      listing: {
        layout: ["grid"], searchLayout: "list", filters: { style: "sidebar-dense", openByDefault: true, column: 262, rowPitch: 24, label: 14 },
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
      footer: ["directory"],
    }),
    home: [
      home("hero", "hero", { layout: "full-bleed" }),
      home("category-tiles", "categories", { style: "quad" }),
      home("deal-block", "flash-sale"),
      home("endless-grid", "for-you"),
    ],
  },
  {
    // Essentials: pantry and daily goods, nested category navigation, a
    // round add button on every simple product's photo.
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
      card: ["standard", { facts: "none", action: "quick-add" }],
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
    // Landing: launch and F-commerce stores with 1-20 hero products. Long
    // content and a repeated buy action.
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
      card: ["standard", { facts: "none", action: "full" }],
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

/** The five presets in gallery order, frozen. */
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
 * Every store without a saved theme renders this: Department, with a
 * department search and the owner-protected classic product page.
 */
export const DEFAULT_STOREFRONT_TEMPLATE: StorefrontTemplateId = "department-mall";
export const DEFAULT_STOREFRONT_THEME: StorefrontThemeDocument = deepFreeze(storefrontTemplateTheme(DEFAULT_STOREFRONT_TEMPLATE));
