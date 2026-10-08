// Block variants: each block of the storefront (top bar, header, menus,
// card, listing, product page, footer) is one variant id plus strict
// settings. Variants choose structure; tokens.ts owns colour, type, space,
// radius and elevation, so no block carries a look of its own.
//
// Each variant declares, as data:
// - `settings` (a strict schema) and `defaults` (valid settings);
// - `requires`: FitConditions over the StoreShape (fit.ts); when one fails
//   the resolver uses `fallback` instead (null: the variant always fits);
// - `contrastPairs`: the text/surface pairs it paints beyond the base set;
// - `renders`: the existing storefront renderer it maps to until the phase
//   that builds its own renderer lands (GAP-AND-PLAN.md section 2.1).
import { z } from "zod";
import type { StorefrontThemeContrastPair } from "./contrast";
import {
  STOREFRONT_NAVIGATION_SOURCES,
  anyOf,
  atLeast,
  between,
  has,
  type FitCondition,
} from "./fit";
import { storefrontProductAppBlocksSchema } from "./apps";
import { storefrontLinkSchema } from "./links";

// ─── Primitives ───────────────────────────────────────────────────────────

export interface StorefrontVariantSpec<Render = unknown> {
  readonly settings: z.ZodType;
  readonly defaults: Readonly<Record<string, unknown>>;
  readonly requires: readonly FitCondition[];
  readonly fallback: string | null;
  readonly contrastPairs: readonly StorefrontThemeContrastPair[];
  readonly renders: (settings: never) => Render;
}

/** One variant: omitted parts mean no settings, no requirement, no extra pairs. */
function variant<Shape extends z.ZodRawShape = Record<never, never>, const Render = unknown>(spec: {
  settings?: Shape;
  defaults?: z.infer<z.ZodObject<Shape>>;
  requires?: readonly FitCondition[];
  fallback?: string;
  contrastPairs?: readonly StorefrontThemeContrastPair[];
  renders: Render | ((settings: z.infer<z.ZodObject<Shape>>) => Render);
}) {
  const renders = spec.renders;
  return {
    settings: z.object(spec.settings ?? ({} as Shape)).strict(),
    defaults: Object.freeze(spec.defaults ?? ({} as z.infer<z.ZodObject<Shape>>)),
    requires: spec.requires ?? [],
    fallback: spec.fallback ?? null,
    contrastPairs: spec.contrastPairs ?? [],
    renders: (typeof renders === "function"
      ? renders
      : () => renders) as (settings: z.infer<z.ZodObject<Shape>>) => Render,
  };
}

const cartTotal = { cartTotal: z.boolean() };

// Existing renderers (the v3 components) the variants map to for now.
export const STOREFRONT_HEADER_RENDERERS = ["classic", "centered", "marketplace"] as const;
/**
 * Where the desktop menu lives: a row of dropdowns or fly-outs (menu), full
 * panels (mega), a flat bar of top links (pills), a column beside the page
 * (sidebar) or a drawer opened from one button (drawer). The storefront
 * renders each variant with its own component; Layout reads this for the
 * sidebar column.
 */
export const STOREFRONT_NAVIGATION_RENDERERS = ["menu", "mega", "pills", "sidebar", "drawer"] as const;
export const STOREFRONT_MOBILE_NAVIGATION_RENDERERS = ["drawer", "tabs"] as const;
export const STOREFRONT_FOOTER_RENDERERS = ["columns", "compact", "contact"] as const;
export type StorefrontHeaderRenderer = (typeof STOREFRONT_HEADER_RENDERERS)[number];
export type StorefrontNavigationRenderer = (typeof STOREFRONT_NAVIGATION_RENDERERS)[number];
export type StorefrontMobileNavigationRenderer = (typeof STOREFRONT_MOBILE_NAVIGATION_RENDERERS)[number];
export type StorefrontFooterRenderer = (typeof STOREFRONT_FOOTER_RENDERERS)[number];
/**
 * The facts a product card shows under its title (each renders only when the
 * product has the data: no zero states): none, up to three key specs, the
 * colour swatches, or the delivery line.
 */
export const STOREFRONT_CARD_FACTS = ["none", "key-specs", "swatches", "delivery"] as const;
export type StorefrontCardFacts = (typeof STOREFRONT_CARD_FACTS)[number];
/**
 * The card's buy action: none (the card is one link), quick-add (a round add
 * button on the photo for products without options) or full (a button at
 * the bottom of every card: Add to cart, Choose options or View product).
 */
export const STOREFRONT_CARD_ACTIONS = ["none", "quick-add", "full"] as const;
export type StorefrontCardAction = (typeof STOREFRONT_CARD_ACTIONS)[number];

/** A buy-box type size in CSS px at 1440 wide (desktop) and 390 wide (phone). */
export interface StorefrontCardTypeSize {
  desktop: number;
  phone: number;
}
export type StorefrontCardWeight = 400 | 500 | 600 | 700;

/**
 * The one product card (ProductCard.astro). Its photo ratio and fit, radius
 * and surface are the theme's tokens; its type is the system's (title 14/500
 * in two lines, price 16/600). These three settings are all it varies by.
 */
export interface StorefrontCardRenderer {
  facts: StorefrontCardFacts;
  action: StorefrontCardAction;
  /** The second photo fades in on hover (pointer devices only). */
  hoverImage: boolean;
}

/**
 * The product page's photos. `beside`: one stage and a thumbnail rail
 * (beside it or below it), the details in the next column. `stacked`
 * (Dawn): every photo full width in one column beside a sticky 345px info
 * column. `grid` (Target): the photos two across beside the info column.
 * On phones `stacked` and `grid` are one swipeable row with an n/N counter;
 * `beside` keeps the stage with a strip under it.
 */
export interface StorefrontGalleryRenderer {
  gallery: "beside" | "stacked" | "grid";
  thumbnails: "beside" | "below";
  /** Keep a narrow thumbnail rail beside the stage on phones. */
  phoneSideThumbnails?: boolean;
  /** The stage photo box, width / height: 1 square, 0.75 the 3:4 portrait. */
  stageRatio: number;
  /** Computer thumbnail edge in px; null keeps classic's 80/100px rail. */
  thumbnailSize: number | null;
}

export type StorefrontBuyBoxFacts = "list" | "column" | "tiles" | "rows";

/**
 * A buy box's reference grammar: type scale (desktop / phone px), the two
 * buttons, where delivery facts sit and how quantity tiers read. Sources in
 * the comments on `STOREFRONT_BUY_BOX_LOOKS`.
 */
export interface StorefrontBuyBoxLook {
  title: { size: StorefrontCardTypeSize; weight: StorefrontCardWeight };
  price: { size: StorefrontCardTypeSize; weight: StorefrontCardWeight; tone: "foreground" | "primary" };
  /**
   * Height in px; `pill` or the theme radius; `row` side by side or `stack`
   * full width up to `maxWidth`; which button comes first.
   */
  cta: { height: number; shape: "pill" | "rect"; layout: "row" | "stack"; phoneLayout?: "row" | "stack"; maxWidth: number | null; first: "add-to-cart" | "buy-now"; inlineQuantity?: boolean; showBuyNow?: boolean };
  /**
   * Delivery, cash on delivery, returns and warranty: a list under the
   * buttons, a 284px column at the right (Daraz, Amazon), tiles (Target) or
   * collapsible rows (Dawn).
   */
  facts: StorefrontBuyBoxFacts;
  /** Price, status, product code and brand as pills over the price (Star Tech). */
  factPills: boolean;
  /** Key features under the title (Star Tech), chips (Target) or none. */
  features: "list" | "chips" | "none";
  /** Quantity tiers as chips (today) or selectable-looking rows with the saving (Daraz, Dawn). */
  bundles: "chips" | "rows";
  /** The buy box sits in a bordered card (Fabrilife). */
  card: boolean;
}

/** Each buy box's measured look; `classic` is null and keeps today's CSS. */
export const STOREFRONT_BUY_BOX_LOOKS = {
  mall: {
    title: { size: { desktop: 25, phone: 20 }, weight: 500 },
    price: { size: { desktop: 24, phone: 20 }, weight: 700, tone: "foreground" },
    cta: { height: 55, shape: "pill", layout: "row", maxWidth: 302, first: "buy-now", inlineQuantity: true },
    facts: "list",
    factPills: false,
    features: "list",
    bundles: "chips",
    card: false,
  },
  // Star Tech product page: h1 22/400, price pills, "Key Features" list,
  // a 200×42 "Buy Now" beside the quantity.
  spec: {
    title: { size: { desktop: 22, phone: 20 }, weight: 400 },
    price: { size: { desktop: 20, phone: 18 }, weight: 700, tone: "primary" },
    cta: { height: 42, shape: "rect", layout: "row", maxWidth: 420, first: "buy-now" },
    facts: "list",
    factPills: true,
    features: "list",
    bundles: "rows",
    card: false,
  },
  // Ghorer Bazar: restrained title and accent price with quantity and cart above direct buy.
  essentials: {
    title: { size: { desktop: 22, phone: 20 }, weight: 600 },
    price: { size: { desktop: 24, phone: 20 }, weight: 700, tone: "primary" },
    cta: { height: 44, shape: "rect", layout: "row", maxWidth: null, first: "add-to-cart" },
    facts: "list",
    factPills: false,
    features: "none",
    bundles: "rows",
    card: false,
  },
  // Apple Gadgets: h1 28/600, price 24/700, twin 380×48 pills stacked, EMI
  // and WhatsApp strips.
  tech: {
    title: { size: { desktop: 32, phone: 24 }, weight: 600 },
    price: { size: { desktop: 24, phone: 20 }, weight: 700, tone: "foreground" },
    cta: { height: 48, shape: "pill", layout: "stack", phoneLayout: "row", maxWidth: 380, first: "buy-now" },
    facts: "list",
    factPills: false,
    features: "none",
    bundles: "rows",
    card: false,
  },
  // Amazon: h1 18/400, price 30/400, stacked Add to Cart and Buy Now; the
  // delivery and purchase facts sit in the right column.
  "marketplace-3col": {
    title: { size: { desktop: 18, phone: 14 }, weight: 400 },
    price: { size: { desktop: 30, phone: 22 }, weight: 400, tone: "primary" },
    cta: { height: 44, shape: "pill", layout: "stack", maxWidth: null, first: "add-to-cart" },
    facts: "column",
    factPills: false,
    features: "none",
    bundles: "rows",
    card: false,
  },
  // Target: h1 24/700, price 28/700, one full-width pill, fulfilment tiles,
  // "at a glance" chips.
  retail: {
    title: { size: { desktop: 24, phone: 20 }, weight: 700 },
    price: { size: { desktop: 28, phone: 24 }, weight: 700, tone: "foreground" },
    cta: { height: 44, shape: "pill", layout: "stack", maxWidth: null, first: "add-to-cart" },
    facts: "tiles",
    factPills: false,
    features: "chips",
    bundles: "chips",
    card: false,
  },
  // Dawn: h1 40/400 (30 on phones), price 18/400, a 345×47 outline "Add to
  // cart" over a solid "Buy it now", collapsible rows.
  boutique: {
    title: { size: { desktop: 40, phone: 30 }, weight: 400 },
    price: { size: { desktop: 18, phone: 16 }, weight: 400, tone: "foreground" },
    cta: { height: 47, shape: "rect", layout: "stack", maxWidth: 345, first: "add-to-cart" },
    facts: "rows",
    factPills: false,
    features: "none",
    bundles: "rows",
    card: false,
  },
  // A focused landing page gives its hero product a stronger title.
  showcase: {
    title: { size: { desktop: 48, phone: 31 }, weight: 700 },
    price: { size: { desktop: 18, phone: 16 }, weight: 400, tone: "foreground" },
    cta: { height: 47, shape: "rect", layout: "stack", maxWidth: 345, first: "add-to-cart" },
    facts: "rows",
    factPills: false,
    features: "none",
    bundles: "rows",
    card: false,
  },
  // Fabrilife: a bordered card, h1 20/700, price 22/700, size boxes, a
  // returns card under the buttons.
  fashion: {
    title: { size: { desktop: 20, phone: 18 }, weight: 700 },
    price: { size: { desktop: 22, phone: 20 }, weight: 700, tone: "foreground" },
    cta: { height: 37, shape: "rect", layout: "row", maxWidth: 115, first: "add-to-cart", inlineQuantity: true, showBuyNow: false },
    facts: "list",
    factPills: false,
    features: "none",
    bundles: "chips",
    card: true,
  },
  // Heritage editorial: a quiet price and one wide primary purchase action.
  heritage: {
    title: { size: { desktop: 30, phone: 24 }, weight: 500 },
    price: { size: { desktop: 20, phone: 18 }, weight: 400, tone: "foreground" },
    cta: { height: 39, shape: "rect", layout: "stack", maxWidth: 492, first: "add-to-cart", showBuyNow: false },
    facts: "rows",
    factPills: false,
    features: "none",
    bundles: "rows",
    card: false,
  },
  // Game Ghor digital codes: h1 24/600, price 24/700, Buy Now first, the
  // delivery promise bullets.
  digital: {
    title: { size: { desktop: 24, phone: 18 }, weight: 600 },
    price: { size: { desktop: 24, phone: 20 }, weight: 700, tone: "foreground" },
    cta: { height: 44, shape: "rect", layout: "row", maxWidth: null, first: "buy-now" },
    facts: "list",
    factPills: false,
    features: "none",
    bundles: "chips",
    card: false,
  },
} as const satisfies Record<string, StorefrontBuyBoxLook>;

export interface StorefrontBuyBoxRenderer {
  /** null renders today's classic buy box, unchanged. */
  look: StorefrontBuyBoxLook | null;
  /** The "EMI from X/month" line under the price (when the product has a quote). */
  emi: boolean;
  /** An "Order on WhatsApp" strip under the buttons (when the store has a WhatsApp number). */
  whatsapp: boolean;
}

function buyBox(look: StorefrontBuyBoxLook | null, settings: { emi?: boolean; whatsapp?: boolean } = {}): StorefrontBuyBoxRenderer {
  return { look, emi: settings.emi === true, whatsapp: settings.whatsapp === true };
}

// ─── Registries ───────────────────────────────────────────────────────────

/** The longest announcement a top bar carries (one line on a phone at 14px is about 45 characters). */
export const STOREFRONT_ANNOUNCEMENT_MAX_LENGTH = 160;

/**
 * The announcement every bar but `none` carries: its words and an optional
 * link (a navigation-safe href). Empty words show no announcement; the
 * utility bar still shows its call, track order and account links.
 */
const announcement = {
  text: z.string().trim().max(STOREFRONT_ANNOUNCEMENT_MAX_LENGTH),
  link: storefrontLinkSchema.nullable(),
};
const NO_ANNOUNCEMENT = { text: "", link: null };

/**
 * Above the header (36-50px). `none` is the off switch: there is no other.
 * `renders` says whether a bar can show at all.
 */
export const STOREFRONT_TOP_BAR_VARIANTS = {
  none: variant({ renders: false }),
  // Dawn, Fabrilife: one centred line.
  announcement: variant({ settings: announcement, defaults: NO_ANNOUNCEMENT, renders: true }),
  // Game Ghor, Target: the announcement at the start; call, track order and
  // account at the end. Computers only (phones reach them in the menu).
  utility: variant({ settings: announcement, defaults: NO_ANNOUNCEMENT, contrastPairs: [["foreground", "muted"]], renders: true }),
};

/**
 * What a header row wears: the page colours, or the header colours (Colours,
 * Header: light, dark or the brand colour, an AA pair either way).
 */
export const STOREFRONT_HEADER_ROW_TONES = ["page", "header"] as const;
export type StorefrontHeaderRowTone = (typeof STOREFRONT_HEADER_ROW_TONES)[number];

const headerSettings = <const Search extends readonly [string, ...string[]]>(searches: Search) => ({
  search: z.enum(searches),
  rowTone: z.enum(STOREFRONT_HEADER_ROW_TONES),
  ...cartTotal,
});

/**
 * Three header layouts; everything else a header can look like is a setting.
 * Phones share one bar in all three (menu, logo, account, cart; the search
 * is an icon, or a row under the bar for `search-first`).
 */
export const STOREFRONT_HEADER_VARIANTS = {
  // The logo, the menu inline, then search and account and cart.
  "inline-nav": variant({
    settings: headerSettings(["icon", "field"]),
    defaults: { search: "icon", rowTone: "page", cartTotal: false },
    contrastPairs: [["foreground", "muted"]],
    renders: "classic",
  }),
  // The logo, a wide search and account and cart over a row for the menu.
  "search-first": variant({
    settings: headerSettings(["field", "scoped"]),
    defaults: { search: "field", rowTone: "page", cartTotal: false },
    contrastPairs: [["foreground", "muted"]],
    renders: "marketplace",
  }),
  // The logo in the middle, search and cart at the sides, the menu centred under it.
  "centered-logo": variant({
    settings: headerSettings(["icon", "field"]),
    defaults: { search: "icon", rowTone: "page", cartTotal: false },
    contrastPairs: [["foreground", "muted"]],
    renders: "centered",
  }),
};

/** How the header menu is browsed on computers (mix rule 4: the pattern must fit the tree). */
export const STOREFRONT_DESKTOP_NAV_VARIANTS = {
  dropdown: variant({ renders: "menu" }),
  cascading: variant({ requires: [atLeast("navDepth", 2)], fallback: "dropdown", renders: "menu" }),
  "mega-panel": variant({
    settings: { promoImages: z.boolean() },
    defaults: { promoImages: false },
    requires: [atLeast("navGroups", 2)],
    fallback: "dropdown",
    renders: "mega",
  }),
  // Amazon, Target: one button opens a drawer that drills in a level at a
  // time. Scales to any depth: always valid.
  "drill-in-drawer": variant({ renders: "drawer" }),
  // `demand`: an "All departments" button whose list opens on a press, over
  // the page, and closes on Escape or a press outside; never open by itself,
  // so it never covers the hero. `always`: a column beside every page.
  "departments-rail": variant({
    settings: { open: z.enum(["demand", "always"]) },
    defaults: { open: "demand" },
    requires: [atLeast("navTopItems", 4)],
    fallback: "dropdown",
    renders: (settings) => (settings.open === "always" ? "sidebar" : "menu"),
  }),
  // Star Tech: a flat bar of top categories that stays when the header
  // scrolls away; each opens a dropdown or cascading fly-outs.
  "sticky-category-bar": variant({
    settings: { flyouts: z.enum(["dropdown", "cascading"]) },
    defaults: { flyouts: "dropdown" },
    requires: [between("navTopItems", 1, 18)],
    fallback: "dropdown",
    renders: "pills",
  }),
};

export const STOREFRONT_MOBILE_TABS = ["home", "categories", "offers", "search", "compare", "cart", "account"] as const;

export const STOREFRONT_MOBILE_NAV_VARIANTS = {
  "accordion-drawer": variant({ renders: "drawer" }),
  // One level at a time.
  "drill-in-drawer": variant({ renders: "drawer" }),
  // 56-61px, 4-5 items; cart and account move from the header to the tabs.
  "bottom-tabs": variant({
    settings: {
      tabs: z.array(z.enum(STOREFRONT_MOBILE_TABS)).min(4).max(5)
        .refine((tabs) => new Set(tabs).size === tabs.length, "Each tab appears once."),
      drawer: z.enum(["accordion", "drill-in"]),
    },
    defaults: { tabs: ["home", "categories", "search", "cart", "account"], drawer: "accordion" },
    renders: "tabs",
  }),
};

/** One card per store: listing, rails, related and search share it (mix rule 2). */
export const STOREFRONT_CARD_VARIANTS = {
  standard: variant({
    settings: {
      facts: z.enum(STOREFRONT_CARD_FACTS),
      action: z.enum(STOREFRONT_CARD_ACTIONS),
      hoverImage: z.boolean(),
    },
    defaults: { facts: "none", action: "none", hoverImage: false },
    // A discounted price is drawn in the sale colour on the card.
    contrastPairs: [["destructive", "card"]],
    renders: (settings): StorefrontCardRenderer => ({ facts: settings.facts, action: settings.action, hoverImage: settings.hoverImage }),
  }),
};

/**
 * How a listing lays out its results (category, search, collection and
 * brand listings share it; mix rule 7). Where the facets live is the
 * listing's `filters` setting, not the layout.
 */
export const STOREFRONT_LISTING_VARIANTS = {
  // Cards in a fluid grid (Star Tech, Daraz, Dawn, Target, Fabrilife).
  grid: variant({ renders: "classic" }),
  // One result per row with its facts (Amazon search, Target and eBay phones).
  list: variant({ renders: "classic" }),
  // Aarong: one shelf per sub-category (or collection), capped at 8 x 10 items.
  // `spacing: airy` is Aarong's own track: two items across on phones and a
  // 40px gap from 640px; `standard` follows the density's gap.
  shelves: variant({
    settings: { maxShelves: z.number().int().min(1).max(8), spacing: z.enum(["standard", "airy"]) },
    defaults: { maxShelves: 8, spacing: "standard" },
    requires: [anyOf(atLeast("categoryDepth", 2), has("hasCollections"))],
    fallback: "grid",
    renders: "classic",
  }),
  // A denser grid: smaller cards, more columns.
  "quick-grid": variant({ renders: "classic" }),
};

// ─── Listing filters ──────────────────────────────────────────────────────

/**
 * Where a listing's facets live on computers. On phones every style opens
 * the facets from a Filter button in a sheet (every reference does).
 * - `sidebar-dense`: Amazon, Daraz, Star Tech; an open column of tight rows.
 * - `sidebar-comfortable`: Apple Gadgets, Fabrilife, Game Ghor; a roomier column.
 * - `bar-dropdowns`: Dawn, Aarong; a one-line bar of facet dropdowns over a full-width grid.
 * - `drawer`: Target, Chaldal; a Filter button (and quick chips) opening a drawer.
 */
export const STOREFRONT_LISTING_FILTER_STYLES = ["sidebar-dense", "sidebar-comfortable", "bar-dropdowns", "drawer"] as const;
export type StorefrontListingFilterStyle = (typeof STOREFRONT_LISTING_FILTER_STYLES)[number];
export const STOREFRONT_LISTING_FILTER_GROUPS = ["category", "availability", "price", "rating", "brand", "other"] as const;
export type StorefrontListingFilterGroup = (typeof STOREFRONT_LISTING_FILTER_GROUPS)[number];

/**
 * A filter style's own arrangement, as the editor's starting order. An unset
 * `order` renders the style's reference arrangement exactly (the dense
 * column puts price after the first two specs, Amazon's interleave, which an
 * order of whole groups cannot say); a template that starts elsewhere sets
 * its `order` (Star Tech and Apple Gadgets put price first).
 */
export function storefrontListingFilterDefaultOrder(style: StorefrontListingFilterStyle): StorefrontListingFilterGroup[] {
  if (style === "sidebar-dense") return ["availability", "rating", "brand", "other", "price", "category"];
  if (style === "bar-dropdowns") return ["availability", "price", "rating", "brand", "other", "category"];
  return ["category", "price", "availability", "rating", "brand", "other"];
}

export interface StorefrontListingFilterSpec {
  placement: "sidebar" | "bar" | "drawer";
  /** Desktop column width in px (sidebars only). */
  column: number | null;
  /** Distance between two facet value rows in px (null: the density's control height). */
  rowPitch: number | null;
  /** Facet value label size in px (null: the density's body text). */
  label: number | null;
  /** Facet dropdowns in the bar before "More filters" opens the drawer (bar only). */
  barFacets: number | null;
}

/**
 * Measured facet UI per style (fidelity AUDIT.md section 0, facet column
 * compactness; storefront-study sites/*.md). A null is a value no
 * reference measured: the renderer uses the density token for it.
 */
export const STOREFRONT_LISTING_FILTER_SPECS = {
  // Amazon 262px / 22px pitch / 14px, Star Tech 225-265 / 32 / 14, Daraz
  // 190 / 18 / 13: 240 sits within 10% of Amazon and Star Tech; 22 is Amazon's pitch.
  "sidebar-dense": { placement: "sidebar", column: 240, rowPitch: 24, label: 14, barFacets: null },
  // Fabrilife 270px, Game Ghor 270px, Apple Gadgets 250px with 28px rows and 16px labels.
  "sidebar-comfortable": { placement: "sidebar", column: 270, rowPitch: 28, label: 16, barFacets: null },
  // Dawn: "Filter: Availability, Price, Color" (3); Aarong: Categories, Colour, Fabric, Price (4).
  "bar-dropdowns": { placement: "bar", column: null, rowPitch: null, label: null, barFacets: 4 },
  // Target: Filter (93×44), Sort and fulfilment chips; every facet in the drawer.
  drawer: { placement: "drawer", column: null, rowPitch: null, label: null, barFacets: null },
} as const satisfies Record<StorefrontListingFilterStyle, StorefrontListingFilterSpec>;

/** The phone filter sheet's width in px (Apple Gadgets 288, Star Tech 280). */
export const STOREFRONT_FILTER_SHEET_WIDTH = 288;
/** Facet values sent in the HTML per facet; "See more" fetches the rest. */
export const STOREFRONT_FILTER_VALUES_IN_HTML = 10;
/** The small-catalogue rule: fewer results than this show no filters. */
export const STOREFRONT_FILTER_MIN_RESULTS = 8;

/**
 * A template's own facet numbers over its style's (optional): each
 * reference is its own spec (Daraz's column is 190px with 18px rows, Star
 * Tech's 225px with 32px rows, Apple Gadgets' 316px). Bounds keep a column
 * readable and every row a 24px target (WCAG 2.5.8: the check box is 14px, so
 * the row pitch is its clear space).
 */
export const STOREFRONT_LISTING_FILTER_BOUNDS = {
  column: { min: 180, max: 340 },
  rowPitch: { min: 24, max: 36 },
  label: { min: 12, max: 18 },
} as const;

const filterNumber = (bounds: { min: number; max: number }) => z.number().int().min(bounds.min).max(bounds.max).optional();

export const storefrontListingFiltersSchema = z.object({
  style: z.enum(STOREFRONT_LISTING_FILTER_STYLES),
  /** Facet groups start open (sidebars and the drawer); bar dropdowns always open on demand. */
  openByDefault: z.boolean(),
  /** Optional merchant order. Unset preserves the reference template, including interleaved facets. */
  order: z.array(z.enum(STOREFRONT_LISTING_FILTER_GROUPS)).length(STOREFRONT_LISTING_FILTER_GROUPS.length)
    .refine((order) => new Set(order).size === STOREFRONT_LISTING_FILTER_GROUPS.length, "Each filter group appears once.").optional(),
  /** Desktop column width in px (sidebars), over the style's. */
  column: filterNumber(STOREFRONT_LISTING_FILTER_BOUNDS.column),
  /** Facet value row pitch in px, over the style's. */
  rowPitch: filterNumber(STOREFRONT_LISTING_FILTER_BOUNDS.rowPitch),
  /** Facet value label size in px, over the style's. */
  label: filterNumber(STOREFRONT_LISTING_FILTER_BOUNDS.label),
  /**
   * Where a search's facets live when the style is a sidebar: `same` keeps
   * the column; `drawer` (Star Tech) gives the results the full width (up to
   * five columns) and opens the facets from a Filters button.
   */
  searchPlacement: z.enum(["same", "drawer"]),
  /**
   * A sidebar's facet groups as one flat list ruled by hairlines that
   * scrolls on its own (Fabrilife), instead of the style's own groups.
   */
  ruled: z.boolean(),
}).strict().refine(
  (filters) => !(filters.style === "bar-dropdowns" && filters.openByDefault),
  { message: "Filter dropdowns open on demand.", path: ["openByDefault"] },
);
export type StorefrontListingFilters = z.infer<typeof storefrontListingFiltersSchema>;

/** A listing's facet numbers: its style's measured spec with the template's own overrides. */
export function storefrontListingFilterSpec(filters: StorefrontListingFilters): StorefrontListingFilterSpec {
  const spec: StorefrontListingFilterSpec = { ...STOREFRONT_LISTING_FILTER_SPECS[filters.style] };
  if (filters.column !== undefined) spec.column = filters.column;
  if (filters.rowPitch !== undefined) spec.rowPitch = filters.rowPitch;
  if (filters.label !== undefined) spec.label = filters.label;
  return spec;
}

/**
 * The small-catalogue rule, for one listing: filters show only with at
 * least STOREFRONT_FILTER_MIN_RESULTS results and a facet (or the price
 * range) with two or more values; a buyer who already refined keeps them to
 * undo it. `facetValueCounts` has one entry per facet, the price range
 * counting 2 when its low and high differ.
 */
export function storefrontListingFiltersShown(listing: {
  total: number;
  refinementCount: number;
  facetValueCounts: readonly number[];
}): boolean {
  if (listing.refinementCount > 0) return true;
  return listing.total >= STOREFRONT_FILTER_MIN_RESULTS && listing.facetValueCounts.some((count) => count >= 2);
}

// ─── Navigation ───────────────────────────────────────────────────────────

/** Links every header surface together may carry (row, dropdowns, clones, drawer): the navigation cap. */
export const STOREFRONT_NAVIGATION_LINK_BUDGET = 150;
/** The most top entries a row can hold (Star Tech's category bar: 18). */
export const STOREFRONT_NAVIGATION_MAX_TOP_ITEMS = 18;

/**
 * Where every header surface (desktop row, mega panel, rail, drawer) takes
 * its links from, shared so the surfaces agree:
 * - `source`: `menu` (the merchant's header menu), `category-tree` (published
 *   roots with public products and their published descendants, at most 4
 *   levels) or `tree+menu` (the tree's roots in tree order, then the menu's
 *   other top items in menu order; an item whose target is already present
 *   is merged into it, keeping the first position and the menu's label).
 * - `maxTopItems`: top entries a surface root shows; the rest go behind
 *   "More" (rows) or "All categories" (drawers and rails, linking /categories).
 * - `linkBudget`: anchors all header surfaces may render together.
 */
export const storefrontNavigationSchema = z.object({
  source: z.enum(STOREFRONT_NAVIGATION_SOURCES),
  maxTopItems: z.number().int().min(1).max(STOREFRONT_NAVIGATION_MAX_TOP_ITEMS),
  linkBudget: z.number().int().min(20).max(STOREFRONT_NAVIGATION_LINK_BUDGET),
}).strict();
export type StorefrontNavigation = z.infer<typeof storefrontNavigationSchema>;

/** Toolbar pieces above a listing; a piece whose data is missing is left out. */
export const STOREFRONT_LISTING_TOOLBAR = {
  breadcrumb: { requires: [] },
  "category-banner": { requires: [] },
  "subcategory-pills": { requires: [atLeast("categoryDepth", 2)] },
  "facet-value-chips": { requires: [] },
  "popular-filter-chips": { requires: [has("hasKeySpecs")] },
  // eBay's phone chips, one per filterable facet (today's attributes and
  // option axes); the storefront leaves them out without a multi-value facet.
  "aspect-chips": { requires: [] },
  "result-count": { requires: [] },
  sort: { requires: [] },
  "per-page": { requires: [] },
  // The buyer's refinements as removable chips over the results (each also
  // undoes from the filter form, so a listing without them stays usable).
  "applied-chips": { requires: [] },
  "grid-list-toggle": { requires: [] },
} as const satisfies Record<string, { requires: readonly FitCondition[] }>;

export const STOREFRONT_LISTING_PHONE_LAYOUTS = ["grid", "list-row"] as const;
/** Load more and infinite paging keep crawlable `?page=n` URLs. */
export const STOREFRONT_LISTING_PAGING = ["numbered", "load-more", "infinite"] as const;
/** What search results start as: the category layout, or their own cards or rows (Amazon's rows). */
export const STOREFRONT_LISTING_SEARCH_LAYOUTS = ["same", "grid", "list"] as const;
/** Where a listing's short description sits: above the results, or with the guide below them. */
export const STOREFRONT_LISTING_DESCRIPTION_PLACEMENTS = ["above", "below"] as const;
/** The listing page's background: the page colour (Dawn) or a muted wash behind the cards. */
export const STOREFRONT_LISTING_SURFACES = ["page", "muted"] as const;
/** Side gutters: inset (16-32px), or Aarong's flush results (8px on phones, the container's edge on computers). */
export const STOREFRONT_LISTING_GUTTERS = ["inset", "flush"] as const;
/**
 * The title band (breadcrumb, h1, count, sort and view): `standard` above
 * the facets and results; `inline` (Dawn) the title alone, then the count
 * and controls on one line over a facet bar; `beside-filters` (Star Tech)
 * the breadcrumb above and the band in the results column beside a filter
 * column. `inline` needs the bar placement and `beside-filters` a sidebar
 * (or a search whose facets moved to the drawer); otherwise `standard`.
 */
export const STOREFRONT_LISTING_BANDS = ["standard", "inline", "beside-filters"] as const;
/**
 * The phone row of Filters, Sort and the view switch:
 * - `standard`: buttons, or one scrolling chip row when facet chips or the view switch join it;
 * - `pill-row` (Target): a Filter pill, sort and the quick and popular filter chips on one scrolling row;
 * - `split-sheet` (Amazon, Daraz): an icon Filters button, sort and quick filters, with the facets
 *   opening as a split sheet (facet names at the left, values at the right);
 * - `bottom` (Fabrilife): the row pinned to the bottom of the screen while the results scroll.
 */
export const STOREFRONT_LISTING_PHONE_BARS = ["standard", "pill-row", "split-sheet", "bottom"] as const;
/** Sub-listing links over the results: chips, or one tab strip that starts with "All" (outside search). */
export const STOREFRONT_LISTING_LINK_STYLES = ["chips", "tabs"] as const;
/** Most result columns on computers; null keeps the density's (the card may cap it too). */
export const STOREFRONT_LISTING_MAX_COLUMNS = { min: 3, max: 6 } as const;

const gallery = (spec: StorefrontGalleryRenderer) => variant({ renders: spec });

export const STOREFRONT_GALLERY_VARIANTS = {
  // Today's product page (owner-protected): thumbnails beside the photo.
  classic: gallery({ gallery: "beside", thumbnails: "beside", stageRatio: 1, thumbnailSize: null }),
  // Star Tech / Apple Gadgets: a square stage over an 88px strip.
  "thumbs-below": gallery({ gallery: "beside", thumbnails: "below", stageRatio: 1, thumbnailSize: 88 }),
  // Amazon on computers; merchants may also keep the rail beside phone photos.
  "thumbs-left": variant({
    settings: { phoneSideThumbnails: z.boolean().optional() },
    defaults: { phoneSideThumbnails: false },
    renders: (settings) => ({ gallery: "beside", thumbnails: "beside", stageRatio: 1, thumbnailSize: 48, phoneSideThumbnails: settings.phoneSideThumbnails }),
  }),
  // Dawn "stacked": every photo full width beside a sticky info column.
  stacked: gallery({ gallery: "stacked", thumbnails: "below", stageRatio: 1, thumbnailSize: null }),
  // Aarong: a 3:4 portrait stage over the strip.
  portrait: gallery({ gallery: "beside", thumbnails: "below", stageRatio: 0.75, thumbnailSize: 88 }),
  // Target: the photos two across beside the info column.
  "image-grid": gallery({ gallery: "grid", thumbnails: "below", stageRatio: 1, thumbnailSize: null }),
};

export const STOREFRONT_BUY_BOX_VARIANTS = {
  // Today's product page (owner-protected).
  classic: variant({ renders: buyBox(null) }),
  // Star Tech: fact pills, key features, the EMI line (hidden without EMI plans).
  spec: variant({
    settings: { emi: z.boolean() },
    defaults: { emi: true },
    contrastPairs: [["accent-foreground", "accent"], ["secondary-foreground", "secondary"]],
    renders: (settings) => buyBox(STOREFRONT_BUY_BOX_LOOKS.spec, settings),
  }),
  // Apple Gadgets: option panels, twin pill CTAs, EMI and WhatsApp strips.
  tech: variant({
    settings: { emi: z.boolean(), whatsapp: z.boolean() },
    defaults: { emi: true, whatsapp: true },
    contrastPairs: [["foreground", "muted"]],
    renders: (settings) => buyBox(STOREFRONT_BUY_BOX_LOOKS.tech, settings),
  }),
  // Daraz/Amazon: delivery, cash on delivery, return and warranty column.
  "marketplace-3col": variant({ contrastPairs: [["foreground", "muted"]], renders: buyBox(STOREFRONT_BUY_BOX_LOOKS["marketplace-3col"]) }),
  // Target: fulfilment tiles, at-a-glance chips.
  retail: variant({ contrastPairs: [["accent-foreground", "accent"]], renders: buyBox(STOREFRONT_BUY_BOX_LOOKS.retail) }),
  mall: variant({ renders: buyBox(STOREFRONT_BUY_BOX_LOOKS.mall) }),
  essentials: variant({ renders: buyBox(STOREFRONT_BUY_BOX_LOOKS.essentials) }),
  // Dawn: outline Add to cart plus solid Buy it now, collapsible rows.
  boutique: variant({ renders: buyBox(STOREFRONT_BUY_BOX_LOOKS.boutique) }),
  showcase: variant({ renders: buyBox(STOREFRONT_BUY_BOX_LOOKS.showcase) }),
  // Fabrilife: bordered card, size boxes, returns card.
  fashion: variant({
    settings: { showBuyNow: z.boolean().optional() },
    defaults: { showBuyNow: false },
    contrastPairs: [["foreground", "muted"]],
    renders: (settings) => buyBox({
      ...STOREFRONT_BUY_BOX_LOOKS.fashion,
      cta: {
        ...STOREFRONT_BUY_BOX_LOOKS.fashion.cta,
        maxWidth: settings.showBuyNow ? null : 115,
        inlineQuantity: !settings.showBuyNow,
        showBuyNow: settings.showBuyNow ?? false,
      },
    }),
  }),
  heritage: variant({
    settings: { showBuyNow: z.boolean().optional() },
    defaults: { showBuyNow: false },
    renders: (settings) => buyBox({
      ...STOREFRONT_BUY_BOX_LOOKS.heritage,
      cta: { ...STOREFRONT_BUY_BOX_LOOKS.heritage.cta, showBuyNow: settings.showBuyNow ?? false },
    }),
  }),
  // Game Ghor: promise bullets (delivery time, where to redeem).
  digital: variant({ requires: [has("hasDigitalLines")], fallback: "classic", renders: buyBox(STOREFRONT_BUY_BOX_LOOKS.digital) }),
};

/**
 * Modules below the product fold, in page order. The fit rule drops a
 * module the store has no data for; the product page then leaves out a
 * module this product has no data for, so nothing renders an empty box.
 * `reviews` needs no published review: its zero state carries "Write a
 * review", so a store's first review can be written. `spec-table` needs no
 * key spec: any attribute value is a specification row. Each module's data
 * is already in the product page's batch (or, for `recently-viewed`, in
 * this browser):
 * - `frequently-bought-together`: the recommendations when they are mostly
 *   real co-purchases (the co-bought products rank first);
 * - `compare-similar`: recommended products of the same category, beside
 *   this one, with a link into `/compare` (key specs side by side);
 * - `policies`: the store's published policy pages;
 * - `recently-viewed`: this browser's list (nothing without JavaScript).
 * Customer questions wait for a question model and are not a module yet.
 */
export const STOREFRONT_PRODUCT_MODULES = {
  "frequently-bought-together": { requires: [] },
  "key-attributes": { requires: [has("hasKeySpecs")] },
  "about-bullets": { requires: [] },
  "spec-table": { requires: [] },
  description: { requires: [] },
  "content-blocks": { requires: [has("hasContentBlocks")] },
  "compare-similar": { requires: [has("hasKeySpecs")] },
  warranty: { requires: [] },
  reviews: { requires: [] },
  policies: { requires: [] },
  related: { requires: [] },
  "recently-viewed": { requires: [] },
} as const satisfies Record<string, { requires: readonly FitCondition[] }>;

/**
 * Content-block types the product page renders (outside the description
 * tabs). Core's store shape counts only these (`hasContentBlocks`), so the
 * `content-blocks` module fits exactly when a public product can show one.
 */
export const STOREFRONT_RENDERED_CONTENT_BLOCK_TYPES = ["rich-text", "feature-list", "faq", "video", "statement"] as const;

/**
 * Sticky bars on the product page; at most one at the top and one at the
 * bottom on phones (mix rule 6):
 * - `phoneTop: anchor-bar` (Amazon, Daraz): Top, Details, Explore and
 *   Reviews links pinned under the header while the sections pass;
 * - `phoneBottom: buy-bar`: the price and Add to cart once the buy buttons
 *   scroll away;
 * - `desktop: anchor-bar` (Star Tech): the same section links pinned under
 *   the header on computers; `product-bar` (Target): the product's name,
 *   price and Add to cart pinned under the header once the buy buttons
 *   scroll away. Stacked and image-grid galleries keep their details column
 *   sticky whatever this says (that is their layout).
 */
export const STOREFRONT_PRODUCT_STICKY = {
  phoneTop: ["none", "anchor-bar"],
  phoneBottom: ["none", "buy-bar"],
  desktop: ["none", "anchor-bar", "product-bar"],
} as const;

/** Footer words: limits of the tagline, the about text and the name after ©. */
export const STOREFRONT_FOOTER_TEXT_LIMITS = { tagline: 160, about: 1_000, copyright: 120 } as const;

/**
 * The words every footer carries, whichever variant draws them: a tagline
 * under the logo, a plain-text about paragraph (blank lines separate
 * paragraphs) and the name after "©" (empty: the store name). Store
 * identity (name, phone, email, address, social profiles) is Settings ->
 * Store, never here.
 */
const footerContent = {
  tagline: z.string().trim().max(STOREFRONT_FOOTER_TEXT_LIMITS.tagline),
  about: z.string().trim().max(STOREFRONT_FOOTER_TEXT_LIMITS.about),
  copyright: z.string().trim().max(STOREFRONT_FOOTER_TEXT_LIMITS.copyright),
};
const NO_FOOTER_CONTENT = { tagline: "", about: "", copyright: "" };

export const STOREFRONT_FOOTER_VARIANTS = {
  // Dawn: quick links, info, email signup, payment icons.
  "minimal-columns": variant({ settings: footerContent, defaults: NO_FOOTER_CONTENT, renders: "columns" }),
  // Star Tech: the header's dark colour, a large phone-number card.
  "support-dark": variant({ settings: footerContent, defaults: NO_FOOTER_CONTENT, renders: "contact" }),
  // Apple Gadgets: branches and policy columns.
  "brand-black": variant({ settings: footerContent, defaults: NO_FOOTER_CONTENT, renders: "contact" }),
  // Fabrilife: policy links, newsletter, hotline, app badges.
  "newsletter-grey": variant({ settings: footerContent, defaults: NO_FOOTER_CONTENT, contrastPairs: [["foreground", "muted"]], renders: "compact" }),
  // Daraz/Amazon: a curated directory of categories (about 60 links).
  // `style: bands` is Amazon's: "Back to top", a narrow centred directory with
  // the store's identity, and a deeper band for the bottom row, all in the
  // header's tone (its AA pair is in the base set; the deeper and raised
  // bands are derived from it with the same or better contrast, tokens.ts).
  directory: variant({
    settings: { style: z.enum(["columns", "bands"]), ...footerContent },
    defaults: { style: "columns", ...NO_FOOTER_CONTENT },
    requires: [atLeast("topCategoryCount", 8)],
    fallback: "minimal-columns",
    renders: "columns",
  }),
  // Game Ghor: three columns of small product lists.
  "product-widgets": variant({
    settings: footerContent,
    defaults: NO_FOOTER_CONTENT,
    requires: [atLeast("productCount", 6)],
    fallback: "minimal-columns",
    renders: "columns",
  }),
};

/**
 * Every single-variant block slot. The listing layout and the product
 * gallery and buy box are slots inside their composite blocks.
 */
export const STOREFRONT_BLOCK_REGISTRY = {
  topBar: STOREFRONT_TOP_BAR_VARIANTS,
  header: STOREFRONT_HEADER_VARIANTS,
  desktopNav: STOREFRONT_DESKTOP_NAV_VARIANTS,
  mobileNav: STOREFRONT_MOBILE_NAV_VARIANTS,
  card: STOREFRONT_CARD_VARIANTS,
  listing: STOREFRONT_LISTING_VARIANTS,
  gallery: STOREFRONT_GALLERY_VARIANTS,
  buyBox: STOREFRONT_BUY_BOX_VARIANTS,
  footer: STOREFRONT_FOOTER_VARIANTS,
};

type Registry = typeof STOREFRONT_BLOCK_REGISTRY;
export type StorefrontBlockSlot = keyof Registry;
export const STOREFRONT_BLOCK_SLOTS = Object.keys(STOREFRONT_BLOCK_REGISTRY) as StorefrontBlockSlot[];
export type StorefrontBlockVariant<Slot extends StorefrontBlockSlot> = keyof Registry[Slot] & string;

/** Variant ids of a slot, in registry order. */
export function storefrontBlockVariants<Slot extends StorefrontBlockSlot>(slot: Slot): StorefrontBlockVariant<Slot>[] {
  return Object.keys(STOREFRONT_BLOCK_REGISTRY[slot]) as StorefrontBlockVariant<Slot>[];
}

export function storefrontVariantSpec(slot: StorefrontBlockSlot, id: string): StorefrontVariantSpec {
  return (STOREFRONT_BLOCK_REGISTRY[slot] as Record<string, StorefrontVariantSpec>)[id]!;
}

// ─── Schemas ──────────────────────────────────────────────────────────────

type BlockValue<Variants> = {
  [Id in keyof Variants & string]: Variants[Id] extends { settings: infer Settings extends z.ZodType }
    ? { variant: Id; settings: z.infer<Settings> }
    : never;
}[keyof Variants & string];

/** `{ variant, settings }` with the settings schema of that variant. */
function blockSchema<Variants extends Record<string, { settings: z.ZodType }>>(variants: Variants) {
  const options = Object.entries(variants).map(([id, spec]) =>
    z.object({ variant: z.literal(id), settings: spec.settings }).strict());
  return z.discriminatedUnion("variant", options as [typeof options[number], ...typeof options]) as unknown as z.ZodType<
    BlockValue<Variants>
  >;
}

const uniqueList = <Item extends string>(values: readonly [Item, ...Item[]], max: number, what: string) =>
  z.array(z.enum(values)).max(max).refine((items) => new Set(items).size === items.length, `Each ${what} appears once.`);

const toolbarIds = Object.keys(STOREFRONT_LISTING_TOOLBAR) as [keyof typeof STOREFRONT_LISTING_TOOLBAR, ...(keyof typeof STOREFRONT_LISTING_TOOLBAR)[]];
const moduleIds = Object.keys(STOREFRONT_PRODUCT_MODULES) as [keyof typeof STOREFRONT_PRODUCT_MODULES, ...(keyof typeof STOREFRONT_PRODUCT_MODULES)[]];

export type StorefrontListingToolbarPiece = keyof typeof STOREFRONT_LISTING_TOOLBAR;
export type StorefrontProductModule = keyof typeof STOREFRONT_PRODUCT_MODULES;

export const storefrontThemeBlocksSchema = z.object({
  topBar: blockSchema(STOREFRONT_TOP_BAR_VARIANTS),
  header: blockSchema(STOREFRONT_HEADER_VARIANTS),
  /** The links every header surface shows (source, top entries, link budget). */
  navigation: storefrontNavigationSchema,
  desktopNav: blockSchema(STOREFRONT_DESKTOP_NAV_VARIANTS),
  mobileNav: blockSchema(STOREFRONT_MOBILE_NAV_VARIANTS),
  card: blockSchema(STOREFRONT_CARD_VARIANTS),
  listing: z.object({
    layout: blockSchema(STOREFRONT_LISTING_VARIANTS),
    /** Search can follow the category layout or start in its own card/list view. */
    searchLayout: z.enum(STOREFRONT_LISTING_SEARCH_LAYOUTS),
    /** Place the short category, collection or brand description around the product results. */
    descriptionPlacement: z.enum(STOREFRONT_LISTING_DESCRIPTION_PLACEMENTS),
    /** Where the facets live and whether their groups start open. */
    filters: storefrontListingFiltersSchema,
    toolbar: uniqueList(toolbarIds, toolbarIds.length, "toolbar piece"),
    /** `list-row` on phones is a listing choice, never a card choice (mix rule 2). */
    phoneLayout: z.enum(STOREFRONT_LISTING_PHONE_LAYOUTS),
    paging: z.enum(STOREFRONT_LISTING_PAGING),
    surface: z.enum(STOREFRONT_LISTING_SURFACES),
    gutter: z.enum(STOREFRONT_LISTING_GUTTERS),
    band: z.enum(STOREFRONT_LISTING_BANDS),
    phoneBar: z.enum(STOREFRONT_LISTING_PHONE_BARS),
    links: z.enum(STOREFRONT_LISTING_LINK_STYLES),
    /** The `category-banner` piece on phones too (Apple Gadgets shows it on computers only). */
    phoneBanner: z.boolean(),
    maxColumns: z.number().int().min(STOREFRONT_LISTING_MAX_COLUMNS.min).max(STOREFRONT_LISTING_MAX_COLUMNS.max).nullable(),
  }).strict(),
  product: z.object({
    gallery: blockSchema(STOREFRONT_GALLERY_VARIANTS),
    buyBox: blockSchema(STOREFRONT_BUY_BOX_VARIANTS),
    below: uniqueList(moduleIds, moduleIds.length, "module"),
    /**
     * Installed apps' product blocks (apps.ts), in the merchant's order;
     * each renders in the buy box or after the modules, as its app declares.
     * Absent means none.
     */
    apps: storefrontProductAppBlocksSchema.optional(),
    sticky: z.object({
      phoneTop: z.enum(STOREFRONT_PRODUCT_STICKY.phoneTop),
      phoneBottom: z.enum(STOREFRONT_PRODUCT_STICKY.phoneBottom),
      desktop: z.enum(STOREFRONT_PRODUCT_STICKY.desktop),
    }).strict(),
  }).strict(),
  footer: blockSchema(STOREFRONT_FOOTER_VARIANTS),
}).strict();

export type StorefrontThemeBlocks = z.infer<typeof storefrontThemeBlocksSchema>;

/** The block value of a slot, wherever it sits in the document. */
export function storefrontBlockValue(
  blocks: StorefrontThemeBlocks,
  slot: StorefrontBlockSlot,
): { variant: string; settings: Record<string, unknown> } {
  if (slot === "listing") return blocks.listing.layout;
  if (slot === "gallery") return blocks.product.gallery;
  if (slot === "buyBox") return blocks.product.buyBox;
  return blocks[slot];
}

/** A slot's variant with its default settings. */
export function storefrontBlockDefault(slot: StorefrontBlockSlot, id: string): { variant: string; settings: Record<string, unknown> } {
  return { variant: id, settings: structuredClone(storefrontVariantSpec(slot, id).defaults) as Record<string, unknown> };
}

/**
 * A slot switched to another variant, keeping every setting the new variant
 * also declares with a value it accepts (the announcement's words and link,
 * the footer's words), so changing a bar or a footer, or a fallback the
 * resolver picks, never drops what the merchant wrote. The rest are the new
 * variant's defaults.
 */
export function storefrontBlockSwitch(
  slot: StorefrontBlockSlot,
  from: { variant: string; settings: Record<string, unknown> },
  id: string,
): { variant: string; settings: Record<string, unknown> } {
  const next = storefrontBlockDefault(slot, id);
  const spec = storefrontVariantSpec(slot, id);
  for (const key of Object.keys(next.settings)) {
    if (!(key in from.settings)) continue;
    const candidate = { ...next.settings, [key]: structuredClone(from.settings[key]) };
    if (spec.settings.safeParse(candidate).success) next.settings = candidate;
  }
  return next;
}
