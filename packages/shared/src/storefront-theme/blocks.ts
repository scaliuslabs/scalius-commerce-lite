// Block variants: each block of the storefront (top bar, header, menus,
// card, listing, product page, footer) is one variant id plus strict
// settings. Variants choose structure only; tokens.ts owns every size,
// radius and colour (SYNTHESIS.md section 2 for the measured anatomy).
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
import { anyOf, atLeast, atMost, between, blockIs, has, type FitCondition } from "./fit";

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

/** Searches must be reachable: big catalogues get a header with a visible search field (mix rule 3). */
const SMALL_CATALOGUE = [atMost("skuCount", 500), atMost("menuTopItems", 8), atMost("topCategoryCount", 8)];

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
export interface StorefrontCardRenderer {
  quickBuy: boolean;
  badge: "image" | "price";
  hoverImage: boolean;
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
  cascading: variant({ requires: [atLeast("menuDepth", 2)], fallback: "dropdown", renders: "menu" }),
  "mega-panel": variant({
    settings: { promoImages: z.boolean() },
    defaults: { promoImages: false },
    requires: [atLeast("menuGroups", 2)],
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
    requires: [between("menuTopItems", 4, 16)],
    fallback: "dropdown",
    renders: (settings) => (settings.open === "always" ? "sidebar" : "menu"),
  }),
  // Star Tech: a flat bar of top categories that stays when the header
  // scrolls away; each opens a dropdown or cascading fly-outs.
  "sticky-category-bar": variant({
    settings: { flyouts: z.enum(["dropdown", "cascading"]) },
    defaults: { flyouts: "dropdown" },
    requires: [between("menuTopItems", 1, 18)],
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
  standard: variant({
    settings: hoverImage,
    defaults: { hoverImage: false },
    renders: (settings) => ({ quickBuy: false, badge: "image" as const, hoverImage: settings.hoverImage }),
  }),
  // Dawn: title 13/400, price 16/400, Sale / Sold out badge.
  boutique: variant({
    settings: hoverImage,
    defaults: { hoverImage: true },
    renders: (settings) => ({ quickBuy: false, badge: "image" as const, hoverImage: settings.hoverImage }),
  }),
  // Aarong: heart, quick view, name 16/700 in two lines.
  portrait: variant({
    settings: hoverImage,
    defaults: { hoverImage: true },
    renders: (settings) => ({ quickBuy: false, badge: "image" as const, hoverImage: settings.hoverImage }),
  }),
  // Fabrilife: -40% badge, round add over the photo, "Save" line.
  "fashion-value": variant({
    contrastPairs: [["destructive", "card"]],
    renders: { quickBuy: true, badge: "image" as const, hoverImage: false },
  }),
  // Star Tech: four key-spec bullets, full-width Buy Now, Add to Compare.
  spec: variant({
    contrastPairs: [["primary", "card"]],
    renders: { quickBuy: true, badge: "image" as const, hoverImage: false },
  }),
  // Apple Gadgets: outline pill CTA plus cart icon, OFF chip.
  "tech-rounded": variant({ renders: { quickBuy: true, badge: "price" as const, hoverImage: false } }),
  // Target: brand line, sale price, full-width Add to cart pill.
  retail: variant({
    contrastPairs: [["destructive", "card"]],
    renders: { quickBuy: true, badge: "price" as const, hoverImage: false },
  }),
  // Daraz: orange price, -%, sold count and rating only when real.
  marketplace: variant({
    contrastPairs: [["primary", "card"]],
    renders: { quickBuy: false, badge: "price" as const, hoverImage: false },
  }),
  // Chaldal: round + over the photo, pack size, delivery-time chip.
  "quick-add": variant({
    contrastPairs: [["destructive", "card"]],
    renders: { quickBuy: true, badge: "price" as const, hoverImage: false },
  }),
};

/** Category, search and collection listings share the layout (mix rule 7). */
export const STOREFRONT_LISTING_VARIANTS = {
  "sidebar-grid": variant({ renders: "classic" }),
  "bar-drawer": variant({ renders: "classic" }),
  list: variant({ renders: "classic" }),
  // One shelf per sub-category or collection, capped at 8 x 10 items.
  shelves: variant({
    settings: { maxShelves: z.number().int().min(1).max(8) },
    defaults: { maxShelves: 8 },
    requires: [anyOf(atLeast("categoryDepth", 2), has("hasCollections"))],
    fallback: "bar-drawer",
    renders: "classic",
  }),
  "quick-grid": variant({ requires: [blockIs("card", "quick-add")], fallback: "sidebar-grid", renders: "classic" }),
};

/** Toolbar pieces above a listing; a piece whose data is missing is left out. */
export const STOREFRONT_LISTING_TOOLBAR = {
  breadcrumb: { requires: [] },
  "category-banner": { requires: [] },
  "subcategory-pills": { requires: [atLeast("categoryDepth", 2)] },
  "popular-filter-chips": { requires: [has("hasKeySpecs")] },
  "aspect-chips": { requires: [has("hasKeySpecs")] },
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
  desktopNav: blockSchema(STOREFRONT_DESKTOP_NAV_VARIANTS),
  mobileNav: blockSchema(STOREFRONT_MOBILE_NAV_VARIANTS),
  card: blockSchema(STOREFRONT_CARD_VARIANTS),
  listing: z.object({
    layout: blockSchema(STOREFRONT_LISTING_VARIANTS),
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
