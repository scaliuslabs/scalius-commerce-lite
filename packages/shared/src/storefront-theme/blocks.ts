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
  // Fabrilife /shop: 236×366 white tiles with a hairline and 4px corners,
  // square 234px photo; title 15/500 in two lines, price 20/700.
  "fashion-value": {
    image: { ratio: 1, fit: "cover" },
    radius: 4,
    surface: "hairline",
    title: { size: { desktop: 15, phone: 15 }, weight: 500, lines: 2 },
    price: { size: { desktop: 20, phone: 20 }, weight: 700 },
  },
  // Star Tech /laptop-notebook: 254×665 white tiles (a hairline, 4px
  // corners), square 204px photo on white (contain); title 14/600 in two
  // lines, price 17/600 (the same on phones, base 14).
  spec: {
    image: { ratio: 1, fit: "contain" },
    radius: 4,
    surface: "hairline",
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
  // Chaldal /popular: 194px tiles ruled by hairlines, square photo; name
  // 16/400 in two lines (14/400 on phones), price 18/700 (12/700 on phones).
  "quick-add": {
    image: { ratio: 1, fit: "contain" },
    radius: 0,
    surface: "hairline",
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
  /**
   * Where the discount mark sits: on the photo, beside the price, or both
   * (Fabrilife: "-40%" on the photo and again after the struck price).
   */
  badge: "image" | "price" | "both";
  hoverImage: boolean;
  /** How a discount reads: "-20%", "Sale", "Save ৳600" or "৳600 OFF". */
  discount: "percent" | "sale" | "save" | "off";
  /**
   * The discount mark's shape: a round pill, a square tag, a flag flush with
   * the photo's edge (Star Tech), plain text (Daraz, Target), a tinted chip
   * (Apple Gadgets) or Amazon's red deal box above the price.
   */
  discountStyle: "pill" | "tag" | "flag" | "text" | "chip" | "deal";
  /**
   * The regular price while discounted: struck after the price, struck
   * before it (Dawn), Target's plain "reg ৳1,200", or Amazon's "List:".
   */
  strike: "after" | "before" | "reg" | "list";
  /** Title lines before it is clamped. */
  titleLines: 1 | 2 | 3;
  titleWeight: "regular" | "medium" | "strong";
  /**
   * The price's colour role: ink, the action colour, the sale colour while
   * discounted, or the sale colour always (Star Tech's red prices).
   */
  priceTone: "ink" | "primary" | "sale" | "sale-always";
  /** A rating as five stars and the count (Daraz, Amazon, Target, Dawn), or "★ 4.6 (128)". */
  rating: "stars" | "score";
  /** The body, top to bottom. */
  body: readonly StorefrontCardPart[];
  /**
   * Where the buy action sits: a full-width button, an outline button, a
   * round button (on the photo, or beside the price), or Amazon's small pill
   * at the start of the row.
   */
  action: "block" | "outline" | "round" | "compact";
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
    discountStyle: "pill",
    strike: "after",
    priceTone: "ink",
    rating: "stars",
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
  cta: { height: number; shape: "pill" | "rect"; layout: "row" | "stack"; maxWidth: number | null; first: "add-to-cart" | "buy-now" };
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
  // Star Tech product page: h1 22/400, price pills, "Key Features" list,
  // a 200×42 "Buy Now" beside the quantity.
  spec: {
    title: { size: { desktop: 22, phone: 18 }, weight: 400 },
    price: { size: { desktop: 20, phone: 18 }, weight: 700, tone: "primary" },
    cta: { height: 42, shape: "rect", layout: "row", maxWidth: 420, first: "buy-now" },
    facts: "list",
    factPills: true,
    features: "list",
    bundles: "rows",
    card: false,
  },
  // Apple Gadgets: h1 28/600, price 24/700, twin 380×48 pills stacked, EMI
  // and WhatsApp strips.
  tech: {
    title: { size: { desktop: 28, phone: 20 }, weight: 600 },
    price: { size: { desktop: 24, phone: 20 }, weight: 700, tone: "foreground" },
    cta: { height: 48, shape: "pill", layout: "stack", maxWidth: 380, first: "buy-now" },
    facts: "list",
    factPills: false,
    features: "none",
    bundles: "rows",
    card: false,
  },
  // Daraz / Amazon: h1 22/400, price 30/400 in the brand colour, Buy Now then
  // Add to Cart; delivery, cash on delivery, returns and warranty in a 284px
  // column at the right.
  "marketplace-3col": {
    title: { size: { desktop: 22, phone: 16 }, weight: 400 },
    price: { size: { desktop: 30, phone: 22 }, weight: 400, tone: "primary" },
    cta: { height: 44, shape: "rect", layout: "row", maxWidth: null, first: "buy-now" },
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
  // Fabrilife: a bordered card, h1 24/600, price 22/700, size boxes, a
  // returns card under the buttons.
  fashion: {
    title: { size: { desktop: 24, phone: 18 }, weight: 600 },
    price: { size: { desktop: 22, phone: 20 }, weight: 700, tone: "foreground" },
    cta: { height: 44, shape: "rect", layout: "row", maxWidth: null, first: "add-to-cart" },
    facts: "list",
    factPills: false,
    features: "none",
    bundles: "chips",
    card: true,
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
  // Dawn: title 13/400, stars when reviewed, the struck price before the
  // 16/400 price, a "Sale" / "Sold out" pill on the photo.
  boutique: variant({
    settings: hoverImage,
    defaults: { hoverImage: true },
    renders: (settings) => card(STOREFRONT_CARD_LOOKS.boutique, {
      hoverImage: settings.hoverImage,
      discount: "sale",
      strike: "before",
      body: ["title", "rating", "price"],
    }),
  }),
  // Aarong: portrait photo, name 16/700 in two lines, price 16/400 in the
  // sale colour while discounted, a square "-20%" tag on the photo.
  portrait: variant({
    settings: hoverImage,
    defaults: { hoverImage: true },
    contrastPairs: [["destructive", "card"]],
    renders: (settings) => card(STOREFRONT_CARD_LOOKS.portrait, { hoverImage: settings.hoverImage, discountStyle: "tag", priceTone: "sale" }),
  }),
  // Fabrilife: a white bordered tile, a red "-40%" tag on the photo, title in
  // two lines, "Save ৳600" chip, price 20/700 with the struck price and
  // "-40%" after it, the round dark cart beside it.
  "fashion-value": variant({
    contrastPairs: [["destructive", "card"]],
    renders: card(STOREFRONT_CARD_LOOKS["fashion-value"], {
      quickBuy: true,
      badge: "both",
      discountStyle: "tag",
      body: ["title", "savings", "price"],
      action: "round",
    }),
  }),
  // Star Tech: a white bordered tile, a "Save ৳" flag, title 14/600, four
  // key-spec bullets, the price always red, full-width Buy Now, Compare.
  spec: variant({
    contrastPairs: [["primary", "card"], ["destructive", "card"]],
    renders: card(STOREFRONT_CARD_LOOKS.spec, {
      quickBuy: true,
      discount: "save",
      discountStyle: "flag",
      priceTone: "sale-always",
      rating: "score",
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
      discountStyle: "chip",
      rating: "score",
      body: ["title", "price", "emi"],
      action: "outline",
      actionLabel: "buy-now",
    }),
  }),
  // Target: colour circles, the 22/700 price first (red with "Sale" and
  // "reg ৳1,200" while discounted), brand 14/700, title 14/400, stars,
  // delivery, a full-width Add to cart pill.
  retail: variant({
    contrastPairs: [["destructive", "card"]],
    renders: card(STOREFRONT_CARD_LOOKS.retail, {
      quickBuy: true,
      badge: "price",
      discount: "sale",
      discountStyle: "text",
      strike: "reg",
      priceTone: "sale",
      body: ["swatches", "price", "brand", "title", "rating", "delivery"],
    }),
  }),
  // Daraz: title 13/400, the 18/400 price always in its orange-red (the sale
  // colour, so it survives an ink-only palette), the struck price and "-15%"
  // under it, then "129 sold" and the stars on one line (only when real).
  marketplace: variant({
    contrastPairs: [["primary", "card"], ["destructive", "card"]],
    renders: card(STOREFRONT_CARD_LOOKS.marketplace, {
      badge: "price",
      discountStyle: "text",
      priceTone: "sale-always",
      body: ["title", "price", "sold", "rating"],
    }),
  }),
  // Chaldal: ruled tiles, a "৳81 OFF" tag and the round + on the photo,
  // price first (red on sale), name 16/400, pack size, delivery chip.
  "quick-add": variant({
    contrastPairs: [["destructive", "card"]],
    renders: card(STOREFRONT_CARD_LOOKS["quick-add"], {
      quickBuy: true,
      discount: "off",
      discountStyle: "tag",
      priceTone: "sale",
      body: ["price", "title", "pack-size", "delivery"],
      action: "round",
    }),
  }),
  // Amazon: colour swatches, title in three lines, "Options: 4 sizes",
  // stars with the count, "1K+ bought in past month" (only from real
  // sales), the red deal box, a superscript price with "List:", the
  // delivery line and the small Add to cart pill.
  detailed: variant({
    contrastPairs: [["destructive", "card"], ["primary", "card"]],
    renders: card(STOREFRONT_CARD_LOOKS.detailed, {
      quickBuy: true,
      badge: "price",
      discountStyle: "deal",
      strike: "list",
      body: ["swatches", "title", "options", "rating", "sold", "price", "delivery"],
      action: "compact",
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

const gallery = (spec: StorefrontGalleryRenderer) => variant({ renders: spec });

export const STOREFRONT_GALLERY_VARIANTS = {
  // Today's product page (owner-protected): thumbnails beside the photo.
  classic: gallery({ gallery: "beside", thumbnails: "beside", stageRatio: 1, thumbnailSize: null }),
  // Star Tech / Apple Gadgets: a square stage over an 88px strip.
  "thumbs-below": gallery({ gallery: "beside", thumbnails: "below", stageRatio: 1, thumbnailSize: 88 }),
  // Amazon: a narrow 48px strip (40-64 measured) at the left of the stage.
  "thumbs-left": gallery({ gallery: "beside", thumbnails: "beside", stageRatio: 1, thumbnailSize: 48 }),
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
  // Dawn: outline Add to cart plus solid Buy it now, collapsible rows.
  boutique: variant({ renders: buyBox(STOREFRONT_BUY_BOX_LOOKS.boutique) }),
  // Fabrilife: bordered card, size boxes, returns card.
  fashion: variant({ contrastPairs: [["foreground", "muted"]], renders: buyBox(STOREFRONT_BUY_BOX_LOOKS.fashion) }),
  // Game Ghor: promise bullets (delivery time, where to redeem).
  digital: variant({ requires: [has("hasDigitalLines")], fallback: "classic", renders: buyBox(STOREFRONT_BUY_BOX_LOOKS.digital) }),
};

/**
 * Modules below the product fold, in page order. The fit rule drops a
 * module the store has no data for; the product page then leaves out a
 * module this product has no data for, so nothing renders an empty box.
 * `reviews` needs no published review: its zero state carries "Write a
 * review", so a store's first review can be written. `spec-table` needs no
 * key spec: any attribute value is a specification row.
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
  questions: { requires: [has("hasQuestions")] },
  reviews: { requires: [] },
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
