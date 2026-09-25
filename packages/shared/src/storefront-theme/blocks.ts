// Block variants: each block of the storefront (top bar, header, menus,
// card, listing, product page, footer) is one variant id plus strict
// settings. Variants choose structure; tokens.ts owns colour and the global
// sizes. One exception: a card variant owns its measured look (photo ratio
// and fit, radius, surface, title and price type), because that look is the
// card's identity (SYNTHESIS.md section 2 and fidelity AUDIT.md section 2.1).
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
  atMost,
  between,
  blockIs,
  has,
  type FitCondition,
} from "./fit";
import type { StorefrontImageFit, StorefrontThemeSurface } from "./tokens";

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

const hoverImage = { hoverImage: z.boolean() };
const cartTotal = { cartTotal: z.boolean() };

/**
 * Searches must be reachable: big catalogues get a header with a visible
 * search field (mix rule 3). The inline row shows at most eight top entries
 * (`navTopItems` is already capped by `navigation.maxTopItems`; the rest sit
 * behind "More"), so a long flat menu no longer pushes a 20-product shop out
 * of its own header.
 */
const SMALL_CATALOGUE = [atMost("skuCount", 500), atMost("navTopItems", 8), atMost("topCategoryCount", 8)];

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
 * Optional card facts. Each renders only when its data exists (a real
 * brand, key specs, reviews, 10+ sold, EMI plans...): no zero states.
 */
export const STOREFRONT_CARD_SLOTS = [
  "brand",
  "key-specs",
  "rating",
  "sold",
  "savings",
  "pack-size",
  "delivery",
  "emi",
  // Amazon: colour dots above the title, "Options: 4 sizes" under it.
  "swatches",
  "options",
] as const;
export type StorefrontCardSlot = (typeof STOREFRONT_CARD_SLOTS)[number];
/** What a card body shows, top to bottom: the title, the price and optional facts. */
export type StorefrontCardPart = "title" | "price" | StorefrontCardSlot;

/** A type size in CSS px at 1440 wide (desktop) and 390 wide (phone). */
export interface StorefrontCardTypeSize {
  desktop: number;
  phone: number;
}
export type StorefrontCardWeight = 400 | 500 | 600 | 700;

/**
 * A card's own look: the measured identity of its reference site, applied
 * in every template. A template's radius, surface and photo tokens never
 * flatten it (the tech-rounded card stays a 20px, raised, 1.31 contain card
 * on a square, flat boutique theme). Sizes are CSS px; the density step
 * still owns the grid (card minimum width, gaps) and the card's inner
 * padding, never these values. Phone titles never drop below 14px (the
 * Bangla floor); every other value is the reference's.
 */
export interface StorefrontCardLook {
  /** Photo box: width / height (1 square, 0.75 portrait 3:4, 1.31 a landscape crop) and how the photo fills it. */
  image: { ratio: number; fit: StorefrontImageFit };
  /** Corner radius in px: the card's frame; on a flat card, the photo's corners. */
  radius: number;
  surface: StorefrontThemeSurface;
  title: { size: StorefrontCardTypeSize; weight: StorefrontCardWeight; lines: 1 | 2 | 3 };
  price: { size: StorefrontCardTypeSize; weight: StorefrontCardWeight };
}

/** Each card's measured look (desktop / phone px). Sources in the comments. */
export const STOREFRONT_CARD_LOOKS = {
  // Dawn /collections/bags: 269×351 cards, square photos, radius 0, no
  // chrome; title 13/400, price 16/400.
  boutique: {
    image: { ratio: 1, fit: "cover" },
    radius: 0,
    surface: "flat",
    title: { size: { desktop: 13, phone: 14 }, weight: 400, lines: 2 },
    price: { size: { desktop: 16, phone: 16 }, weight: 400 },
  },
  // Aarong /women/saree: 3:4 photos (310×413, 179×239 on phones), radius 0;
  // name 16/700 in two lines, price 16/400.
  portrait: {
    image: { ratio: 0.75, fit: "cover" },
    radius: 0,
    surface: "flat",
    title: { size: { desktop: 16, phone: 16 }, weight: 700, lines: 2 },
    price: { size: { desktop: 16, phone: 16 }, weight: 400 },
  },
  // Fabrilife /shop: 236×366 cards, square 234px photo, radius 0; title
  // 15/500 on one line, price 20/700.
  "fashion-value": {
    image: { ratio: 1, fit: "cover" },
    radius: 0,
    surface: "flat",
    title: { size: { desktop: 15, phone: 15 }, weight: 500, lines: 1 },
    price: { size: { desktop: 20, phone: 20 }, weight: 700 },
  },
  // Star Tech /laptop-notebook: 254×665, square 204px photo on white
  // (contain), radius 0, no border or shadow; title 14/600 in two lines,
  // price 17/600 (the same on phones, base 14).
  spec: {
    image: { ratio: 1, fit: "contain" },
    radius: 0,
    surface: "flat",
    title: { size: { desktop: 14, phone: 14 }, weight: 600, lines: 2 },
    price: { size: { desktop: 17, phone: 17 }, weight: 600 },
  },
  // Apple Gadgets: radius 20, border plus soft shadow, image 278×212 (a
  // 1.31 crop of a square photo, contain); title 18/600 (14/600 on phones),
  // price 18/600.
  "tech-rounded": {
    image: { ratio: 1.31, fit: "contain" },
    radius: 20,
    surface: "raised",
    title: { size: { desktop: 18, phone: 14 }, weight: 600, lines: 2 },
    price: { size: { desktop: 18, phone: 18 }, weight: 600 },
  },
  // Target search: square 318px photo with radius 8, no card chrome; brand
  // 14/700, title 14/400, price 22/700.
  retail: {
    image: { ratio: 1, fit: "contain" },
    radius: 8,
    surface: "flat",
    title: { size: { desktop: 14, phone: 14 }, weight: 400, lines: 2 },
    price: { size: { desktop: 22, phone: 22 }, weight: 700 },
  },
  // Daraz ?q=ssd: 250×421, square 200px photo, white on grey with no
  // border, 2px corners; title 13/400 in two lines, price 18/400 (orange).
  marketplace: {
    image: { ratio: 1, fit: "contain" },
    radius: 2,
    surface: "flat",
    title: { size: { desktop: 13, phone: 14 }, weight: 400, lines: 2 },
    price: { size: { desktop: 18, phone: 18 }, weight: 400 },
  },
  // Chaldal /popular: 194px tiles, square photo, no borders; name 16/400 in
  // two lines (14/400 on phones), price 18/700 (12/700 on phones).
  "quick-add": {
    image: { ratio: 1, fit: "contain" },
    radius: 0,
    surface: "flat",
    title: { size: { desktop: 16, phone: 14 }, weight: 400, lines: 2 },
    price: { size: { desktop: 18, phone: 12 }, weight: 700 },
  },
  // Amazon UK search grid (owner's screenshot, 2026-09-25): square photo
  // contained on a grey well, no card chrome, radius 0; title 16/400 in
  // three lines (14 on phones), superscript price with 28px whole units
  // (22 on phones).
  detailed: {
    image: { ratio: 1, fit: "contain" },
    radius: 0,
    surface: "flat",
    title: { size: { desktop: 16, phone: 14 }, weight: 400, lines: 3 },
    price: { size: { desktop: 28, phone: 22 }, weight: 400 },
  },
} as const satisfies Record<string, StorefrontCardLook>;

/**
 * A card's measured anatomy as data (SYNTHESIS.md section 2.4): its body,
 * actions and wording, plus its own look (`look`; null only for `standard`,
 * which follows the template's tokens and type scale so today's card stays
 * pixel-identical).
 */
export interface StorefrontCardRenderer {
  /** A buy action on the card (products without options, in stock). */
  quickBuy: boolean;
  /** The discount sits on the photo or beside the price. */
  badge: "image" | "price";
  hoverImage: boolean;
  /** How a discount reads: "-20%", "Sale", "Save ৳600" or "৳600 OFF". */
  discount: "percent" | "sale" | "save" | "off";
  /** Title lines before it is clamped. */
  titleLines: 1 | 2 | 3;
  titleWeight: "regular" | "medium" | "strong";
  /** The price's colour role: ink, the action colour, or the sale colour while discounted. */
  priceTone: "ink" | "primary" | "sale";
  /** The body, top to bottom. */
  body: readonly StorefrontCardPart[];
  /** Where the buy action sits: a full-width button, an outline button, or a round button on the photo. */
  action: "block" | "outline" | "round";
  actionLabel: "buy-now" | "add-to-cart";
  /** An "Add to Compare" toggle under the action, and the floating Compare tray (Star Tech). */
  compare: boolean;
  /** The card's own look; null follows the template's tokens (standard only). */
  look: StorefrontCardLook | null;
}

const TITLE_WEIGHTS = { 400: "regular", 500: "medium", 600: "strong", 700: "strong" } as const;

/**
 * A card from its anatomy and look. `titleLines` and `titleWeight` are
 * derived from the look so the two can never disagree.
 */
function card(
  look: StorefrontCardLook | null,
  anatomy: Partial<Omit<StorefrontCardRenderer, "look" | "titleLines" | "titleWeight">>,
): StorefrontCardRenderer {
  return {
    quickBuy: false,
    badge: "image",
    hoverImage: false,
    discount: "percent",
    priceTone: "ink",
    body: ["title", "price"],
    action: "block",
    actionLabel: "add-to-cart",
    compare: false,
    ...anatomy,
    titleLines: look?.title.lines ?? 2,
    titleWeight: look ? TITLE_WEIGHTS[look.title.weight] : "medium",
    look,
  };
}
export interface StorefrontGalleryRenderer {
  gallery: "beside" | "stacked";
  thumbnails: "beside" | "below";
}

// ─── Registries ───────────────────────────────────────────────────────────

/**
 * Above the header (36-50px); its text is the announcement in Header
 * settings. `renders` says whether a bar can show at all.
 */
export const STOREFRONT_TOP_BAR_VARIANTS = {
  none: variant({ renders: false }),
  // Dawn, Fabrilife: one centred line.
  announcement: variant({ renders: true }),
  // Game Ghor, Target: the announcement at the start; call, track order and
  // account at the end. Computers only (phones reach them in the menu).
  utility: variant({ contrastPairs: [["foreground", "muted"]], renders: true }),
  // Apple Gadgets, Amazon: a dismissible phone-only banner (60px) carrying
  // the announcement until the store has an app to link.
  "app-banner": variant({ renders: true }),
};

export const STOREFRONT_HEADER_VARIANTS = {
  // Dawn: 84px, logo, 3-6 inline items, icon search.
  "boutique-inline": variant({ requires: SMALL_CATALOGUE, fallback: "fashion-department", renders: "centered" }),
  // Fabrilife/Aarong: uppercase departments, filled search, icon-over-label utilities.
  // The filled search fields paint ink on the muted surface.
  "fashion-department": variant({
    settings: { subBrandRow: z.boolean() },
    defaults: { subBrandRow: false },
    contrastPairs: [["foreground", "muted"]],
    renders: "classic",
  }),
  // Star Tech: dark row with a 580px search, light category row that stays.
  "spec-two-row": variant({ contrastPairs: [["foreground", "muted"]], renders: "marketplace" }),
  // Apple Gadgets: dark row, pill search, round icons, category row.
  "tech-rounded": variant({ renders: "marketplace" }),
  // Amazon/Daraz: department-scoped search, trending queries.
  "marketplace-search": variant({
    settings: { trendingQueries: z.boolean() },
    defaults: { trendingQueries: true },
    contrastPairs: [["foreground", "muted"]],
    renders: "marketplace",
  }),
  // Game Ghor: big logo, search with a category select, cart with its total.
  "mall-departments": variant({ settings: cartTotal, defaults: { cartTotal: true }, renders: "classic" }),
  // Target/Walmart: Categories and Deals pills, pill search.
  "retail-pill": variant({ settings: cartTotal, defaults: { cartTotal: false }, renders: "marketplace" }),
  // Chaldal: fixed header, delivery-city selector, wide search.
  "grocery-shell": variant({ contrastPairs: [["foreground", "muted"]], renders: "marketplace" }),
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
  // Game Ghor (home): an "All departments" tab whose list is open over the
  // hero on the home page and opens on demand elsewhere. Chaldal (always): a
  // column beside every page.
  "departments-rail": variant({
    settings: { open: z.enum(["home", "always"]) },
    defaults: { open: "home" },
    requires: [between("navTopItems", 4, 16)],
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
  // Today's classic card (department-mall, pixel-identical): badge on the
  // photo, title 2 lines, price below.
  standard: variant({
    settings: hoverImage,
    defaults: { hoverImage: false },
    renders: (settings) => card(null, { hoverImage: settings.hoverImage }),
  }),
  // Dawn: title 13/400, price 16/400, Sale / Sold out badge.
  boutique: variant({
    settings: hoverImage,
    defaults: { hoverImage: true },
    renders: (settings) => card(STOREFRONT_CARD_LOOKS.boutique, { hoverImage: settings.hoverImage, discount: "sale" }),
  }),
  // Aarong: portrait photo, name 16/700 in two lines, price 16/400.
  portrait: variant({
    settings: hoverImage,
    defaults: { hoverImage: true },
    renders: (settings) => card(STOREFRONT_CARD_LOOKS.portrait, { hoverImage: settings.hoverImage }),
  }),
  // Fabrilife: -40% badge, round add over the photo, title on one line,
  // "Save ৳600", price 20/700.
  "fashion-value": variant({
    contrastPairs: [["destructive", "card"]],
    renders: card(STOREFRONT_CARD_LOOKS["fashion-value"], { quickBuy: true, body: ["title", "savings", "price"], action: "round" }),
  }),
  // Star Tech: "Save ৳" pill, title 14/600, four key-spec bullets, price in
  // the action colour, full-width Buy Now.
  spec: variant({
    contrastPairs: [["primary", "card"]],
    renders: card(STOREFRONT_CARD_LOOKS.spec, {
      quickBuy: true,
      discount: "save",
      priceTone: "primary",
      body: ["title", "key-specs", "price", "emi"],
      actionLabel: "buy-now",
      compare: true,
    }),
  }),
  // Apple Gadgets: title 18/600, price 18/600 with a "৳500 OFF" chip, outline
  // pill CTA.
  "tech-rounded": variant({
    contrastPairs: [["primary", "card"]],
    renders: card(STOREFRONT_CARD_LOOKS["tech-rounded"], {
      quickBuy: true,
      badge: "price",
      discount: "off",
      body: ["title", "price", "emi"],
      action: "outline",
      actionLabel: "buy-now",
    }),
  }),
  // Target: price first (22/700, "Sale" in the sale colour), brand 14/700,
  // title 14/400, rating, delivery, full-width Add to cart pill.
  retail: variant({
    contrastPairs: [["destructive", "card"]],
    renders: card(STOREFRONT_CARD_LOOKS.retail, {
      quickBuy: true,
      badge: "price",
      discount: "sale",
      priceTone: "sale",
      body: ["price", "brand", "title", "rating", "delivery"],
    }),
  }),
  // Daraz: title 13/400, price 18 in the action colour, -%, then rating and
  // "129 sold" (only when real).
  marketplace: variant({
    contrastPairs: [["primary", "card"], ["destructive", "card"]],
    renders: card(STOREFRONT_CARD_LOOKS.marketplace, {
      badge: "price",
      priceTone: "primary",
      body: ["title", "price", "rating", "sold"],
    }),
  }),
  // Chaldal: round + over the photo, price first (red on sale), name 16/400,
  // pack size, delivery chip.
  "quick-add": variant({
    contrastPairs: [["destructive", "card"]],
    renders: card(STOREFRONT_CARD_LOOKS["quick-add"], {
      quickBuy: true,
      badge: "price",
      priceTone: "sale",
      body: ["price", "title", "pack-size", "delivery"],
      action: "round",
    }),
  }),
  // Amazon: colour swatches, title in three lines, "Options: 4 sizes",
  // rating, "1K+ bought in past month" (only from real sales), a
  // superscript price with the struck list price, the delivery line.
  detailed: variant({
    contrastPairs: [["destructive", "card"]],
    renders: card(STOREFRONT_CARD_LOOKS.detailed, {
      badge: "price",
      body: ["swatches", "title", "options", "rating", "sold", "price", "delivery"],
    }),
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
  shelves: variant({
    settings: { maxShelves: z.number().int().min(1).max(8) },
    defaults: { maxShelves: 8 },
    requires: [anyOf(atLeast("categoryDepth", 2), has("hasCollections"))],
    fallback: "grid",
    renders: "classic",
  }),
  // Chaldal: the dense quick-add grid.
  "quick-grid": variant({ requires: [blockIs("card", "quick-add")], fallback: "grid", renders: "classic" }),
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
  "sidebar-dense": { placement: "sidebar", column: 240, rowPitch: 22, label: 14, barFacets: null },
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
 * readable and every row a target.
 */
export const STOREFRONT_LISTING_FILTER_BOUNDS = {
  column: { min: 180, max: 340 },
  rowPitch: { min: 16, max: 36 },
  label: { min: 12, max: 18 },
} as const;

const filterNumber = (bounds: { min: number; max: number }) => z.number().int().min(bounds.min).max(bounds.max).optional();

export const storefrontListingFiltersSchema = z.object({
  style: z.enum(STOREFRONT_LISTING_FILTER_STYLES),
  /** Facet groups start open (sidebars and the drawer); bar dropdowns always open on demand. */
  openByDefault: z.boolean(),
  /** Desktop column width in px (sidebars), over the style's. */
  column: filterNumber(STOREFRONT_LISTING_FILTER_BOUNDS.column),
  /** Facet value row pitch in px, over the style's. */
  rowPitch: filterNumber(STOREFRONT_LISTING_FILTER_BOUNDS.rowPitch),
  /** Facet value label size in px, over the style's. */
  label: filterNumber(STOREFRONT_LISTING_FILTER_BOUNDS.label),
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
  "popular-filter-chips": { requires: [has("hasKeySpecs")] },
  // eBay's phone chips, one per filterable facet (today's attributes and
  // option axes); the storefront leaves them out without a multi-value facet.
  "aspect-chips": { requires: [] },
  "result-count": { requires: [] },
  sort: { requires: [] },
  "per-page": { requires: [] },
  "applied-chips": { requires: [] },
  "grid-list-toggle": { requires: [] },
} as const satisfies Record<string, { requires: readonly FitCondition[] }>;

export const STOREFRONT_LISTING_PHONE_LAYOUTS = ["grid", "list-row"] as const;
/** Load more and infinite paging keep crawlable `?page=n` URLs. */
export const STOREFRONT_LISTING_PAGING = ["numbered", "load-more", "infinite"] as const;

export const STOREFRONT_GALLERY_VARIANTS = {
  // Today's product page (owner-protected): thumbnails beside the photo.
  classic: variant({ renders: { gallery: "beside" as const, thumbnails: "beside" as const } }),
  "thumbs-below": variant({ renders: { gallery: "beside" as const, thumbnails: "below" as const } }),
  "thumbs-left": variant({ renders: { gallery: "beside" as const, thumbnails: "beside" as const } }),
  stacked: variant({ renders: { gallery: "stacked" as const, thumbnails: "below" as const } }),
  portrait: variant({ renders: { gallery: "beside" as const, thumbnails: "below" as const } }),
  "image-grid": variant({ renders: { gallery: "stacked" as const, thumbnails: "below" as const } }),
};

export const STOREFRONT_BUY_BOX_VARIANTS = {
  // Today's product page (owner-protected).
  classic: variant({ renders: "classic" }),
  // Star Tech: fact pills, key features, cash vs EMI radio (hidden without EMI plans).
  spec: variant({
    settings: { emi: z.boolean() },
    defaults: { emi: true },
    contrastPairs: [["accent-foreground", "accent"], ["secondary-foreground", "secondary"]],
    renders: "classic",
  }),
  // Apple Gadgets: option panels, twin pill CTAs, EMI and WhatsApp strips.
  tech: variant({
    settings: { emi: z.boolean(), whatsapp: z.boolean() },
    defaults: { emi: true, whatsapp: true },
    contrastPairs: [["foreground", "muted"]],
    renders: "classic",
  }),
  // Daraz/Amazon: delivery, cash on delivery, return and warranty column.
  "marketplace-3col": variant({ contrastPairs: [["foreground", "muted"]], renders: "classic" }),
  // Target: fulfilment tiles, payment-offer cards, at-a-glance chips.
  retail: variant({ contrastPairs: [["accent-foreground", "accent"]], renders: "classic" }),
  // Dawn: outline Add to cart plus solid Buy it now, collapsible rows.
  boutique: variant({ renders: "classic" }),
  // Fabrilife: bordered card, size boxes, returns card, size chart.
  fashion: variant({ contrastPairs: [["foreground", "muted"]], renders: "classic" }),
  // Game Ghor: promise bullets (delivery time, where to redeem).
  digital: variant({ requires: [has("hasDigitalLines")], fallback: "classic", renders: "classic" }),
};

/** Modules below the product fold, in page order; a module without data is left out. */
export const STOREFRONT_PRODUCT_MODULES = {
  "frequently-bought-together": { requires: [] },
  "key-attributes": { requires: [has("hasKeySpecs")] },
  "about-bullets": { requires: [] },
  "spec-table": { requires: [has("hasKeySpecs")] },
  description: { requires: [] },
  "content-blocks": { requires: [has("hasContentBlocks")] },
  "compare-similar": { requires: [has("hasKeySpecs")] },
  questions: { requires: [has("hasQuestions")] },
  reviews: { requires: [has("hasReviews")] },
  policies: { requires: [] },
  related: { requires: [] },
  "recently-viewed": { requires: [] },
} as const satisfies Record<string, { requires: readonly FitCondition[] }>;

/** One sticky element at the top and one at the bottom on phones (mix rule 6). */
export const STOREFRONT_PRODUCT_STICKY = {
  phoneTop: ["none", "anchor-bar"],
  phoneBottom: ["none", "buy-bar"],
  desktop: ["none", "anchor-bar", "product-bar", "info-column", "side-rail"],
} as const;

export const STOREFRONT_FOOTER_VARIANTS = {
  // Dawn: quick links, info, email signup, payment icons.
  "minimal-columns": variant({ renders: "columns" }),
  // Star Tech: the header's dark colour, a large phone-number card.
  "support-dark": variant({ renders: "contact" }),
  // Apple Gadgets: branches and policy columns.
  "brand-black": variant({ renders: "contact" }),
  // Fabrilife: policy links, newsletter, hotline, app badges.
  "newsletter-grey": variant({ contrastPairs: [["foreground", "muted"]], renders: "compact" }),
  // Daraz/Amazon: a curated directory of categories (about 60 links).
  directory: variant({ requires: [atLeast("topCategoryCount", 8)], fallback: "minimal-columns", renders: "columns" }),
  // Game Ghor: three columns of small product lists.
  "product-widgets": variant({ requires: [atLeast("productCount", 6)], fallback: "minimal-columns", renders: "columns" }),
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
    /** Where the facets live and whether their groups start open. */
    filters: storefrontListingFiltersSchema,
    toolbar: uniqueList(toolbarIds, toolbarIds.length, "toolbar piece"),
    /** `list-row` on phones is a listing choice, never a card choice (mix rule 2). */
    phoneLayout: z.enum(STOREFRONT_LISTING_PHONE_LAYOUTS),
    paging: z.enum(STOREFRONT_LISTING_PAGING),
  }).strict(),
  product: z.object({
    gallery: blockSchema(STOREFRONT_GALLERY_VARIANTS),
    buyBox: blockSchema(STOREFRONT_BUY_BOX_VARIANTS),
    below: uniqueList(moduleIds, moduleIds.length, "module"),
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
