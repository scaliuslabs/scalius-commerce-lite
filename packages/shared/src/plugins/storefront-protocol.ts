// The storefront components protocol without its schemas (no zod): the
// constants, data shapes and render messages the SDK, the islands and the
// storefront share. Bundled into every app's storefront module and island,
// so it stays small and dependency-free. The rest of the contract (manifest
// schemas, settings resolution) is ./storefront-components.ts.

import type { CustomFieldWireValue } from "../custom-fields";

// ── Protocol ──────────────────────────────────────────────────────────────

/** The render protocol between the storefront and a storefront module. */
export const STOREFRONT_COMPONENT_ABI = 1 as const;

/**
 * Core-owned units an app may redraw: its **skin** of the unit gets the
 * unit's public projection (the data the core renderer uses), and core draws
 * the unit whenever the skin is missing, fails or draws nothing.
 */
export const STOREFRONT_SKIN_UNITS = ["header", "footer", "product_card", "product_main", "listing_main"] as const;
export type StorefrontSkinUnit = (typeof STOREFRONT_SKIN_UNITS)[number];
/** A core section's skin targets `section:<core section type>` (`section:hero`). */
export const STOREFRONT_SECTION_SKIN_PREFIX = "section:";
/** What a skin redraws: a fixed unit, or one core section type. */
export type StorefrontSkinTarget = StorefrontSkinUnit | `section:${string}`;

// ── Slots ─────────────────────────────────────────────────────────────────
//
// A slot is a named place on a store page where apps add their own piece.
// Core units place every slot; a skin of a unit places that unit's slots
// (`<Slot name="…" />`). An app names the slots it fills by `targets`:
//
// - **Component slots** are on public pages. An app component
//   (`storefront.components`, drawn at the edge by the app's storefront
//   module) renders in each slot it targets. The product slots are arranged
//   by the merchant (Online store -> Theme, the product page's app blocks,
//   with their values); every other component slot shows each active app's
//   component with its default values. `page` is an app page that a proxy
//   route answers.
// - **UI slots** are on the buyer's own pages (cart, checkout, the receipt,
//   the account), where no app code runs: a `buyer.ui` function answers a
//   `ui` tree (ui.ts, buyer surface) and the store draws it.
//
// A slot nobody fills renders nothing and costs no read.

/** Slots on public pages that app components fill. */
export const STOREFRONT_COMPONENT_SLOTS = [
  // In the header, beside search, account and cart.
  "header.actions",
  // The product's buy box: before the price and options, and after the buttons.
  "product.buy_box.before",
  "product.buy_box.after",
  // After the product page's modules.
  "product.below",
  // Footer columns, after the store's menus.
  "footer.columns",
] as const;
export type StorefrontComponentSlot = (typeof STOREFRONT_COMPONENT_SLOTS)[number];

/** The component slots the merchant arranges in the theme (the product page's app blocks). */
export const STOREFRONT_PRODUCT_SLOTS = ["product.buy_box.before", "product.buy_box.after", "product.below"] as const satisfies readonly StorefrontComponentSlot[];
export type StorefrontProductSlot = (typeof STOREFRONT_PRODUCT_SLOTS)[number];

/** The product slot a component targets, if any: where its product-page placements render (a component has at most one). */
export function storefrontComponentProductSlot(targets: readonly string[]): StorefrontProductSlot | null {
  return (targets.find((target) => (STOREFRONT_PRODUCT_SLOTS as readonly string[]).includes(target)) as StorefrontProductSlot | undefined) ?? null;
}

/** Where an app component renders: a component slot, or `page` (an app page its proxy route answers). */
export const STOREFRONT_COMPONENT_TARGETS = [...STOREFRONT_COMPONENT_SLOTS, "page"] as const;
export type StorefrontComponentTarget = (typeof STOREFRONT_COMPONENT_TARGETS)[number];

/** Slots on the buyer's own pages that `buyer.ui` trees fill, with the page group that draws each. */
export const STOREFRONT_UI_SLOT_PAGES = {
  // The cart page (checkout's information step).
  "checkout.contact.after": "checkout",
  "checkout.delivery.after": "checkout",
  "cart.page.summary": "checkout",
  // The payment step.
  "checkout.payment.after": "checkout",
  "checkout.actions.before": "checkout",
  // The thank-you page.
  "order.confirmation": "order",
  // The order status page (signed in, or the receipt's status view).
  "account.order": "order",
  "account.overview": "account",
  "account.profile": "account",
} as const;
export type StorefrontUiSlot = keyof typeof STOREFRONT_UI_SLOT_PAGES;
export type StorefrontUiSlotPage = (typeof STOREFRONT_UI_SLOT_PAGES)[StorefrontUiSlot];
export const STOREFRONT_UI_SLOTS = Object.keys(STOREFRONT_UI_SLOT_PAGES) as [StorefrontUiSlot, ...StorefrontUiSlot[]];

/** The UI slots one buyer page group draws (`checkout`: the cart page and the payment step). */
export function storefrontUiSlotsOn(page: StorefrontUiSlotPage): StorefrontUiSlot[] {
  return STOREFRONT_UI_SLOTS.filter((slot) => STOREFRONT_UI_SLOT_PAGES[slot] === page);
}

/**
 * Core embeds: `<scalius-embed kind="…">` in a component's markup, where the
 * store renders its own interactive piece with its own data, rules, words
 * and scripts, so an app composes the store's buy form, filters and paging
 * instead of re-implementing them. The markup around an embed is the app's.
 *
 * - `buy_form`: the product's price, options, buyer inputs, quantity and
 *   buttons (a real form; works before hydration). `data-title="false"`
 *   leaves out its heading when the skin draws the product title itself.
 * - `reviews`, `recommendations`: the product's reviews and related products.
 * - `gallery`: the product's photos and videos as the theme's gallery draws
 *   them (one main image with thumbnails, a swipeable stage on phones,
 *   zoom, and the chosen SKU's photo when a variant is picked).
 * - `filters`, `toolbar` (sort and page size), `pagination`: the listing's.
 * - `order_form`: the single-page order form of a landing page, for a
 *   product the section was given (`data-product`, `data-max-quantity`,
 *   `data-submit-label`).
 * - `slot`: a component slot of the unit (`data-name`, `<Slot name="…" />`),
 *   where active apps' components render (a header skin places
 *   `header.actions`, a footer skin `footer.columns`).
 */
export const STOREFRONT_EMBED_KINDS = ["buy_form", "reviews", "recommendations", "filters", "toolbar", "pagination", "order_form", "gallery", "slot"] as const;
export type StorefrontEmbedKind = (typeof STOREFRONT_EMBED_KINDS)[number];
export const STOREFRONT_EMBED_TAG = "scalius-embed";

/**
 * What one render may embed: each allowed kind with how many render (any
 * beyond render nothing, as does a kind not listed), the kinds it must place
 * (without one, core draws the unit instead), and the kinds the host appends
 * when the markup leaves them out (a listing always pages, so crawlers reach
 * every product). `slots` names the component slots a `slot` embed may be
 * (each renders once).
 */
export interface StorefrontEmbedRule {
  allowed: Partial<Record<StorefrontEmbedKind, number>>;
  required: readonly StorefrontEmbedKind[];
  appended: readonly StorefrontEmbedKind[];
  slots?: readonly StorefrontComponentSlot[];
}

const NO_EMBEDS: StorefrontEmbedRule = { allowed: {}, required: [], appended: [] };

/** The embed rule of a render: a component section, a skin's target or an app component (which embeds nothing). */
export function storefrontEmbedRule(unit: "section" | "component" | StorefrontSkinTarget): StorefrontEmbedRule {
  switch (unit) {
    case "section":
      return { allowed: { "order_form": 2 }, required: [], appended: [] };
    case "header":
      return { allowed: { slot: 1 }, required: [], appended: [], slots: ["header.actions"] };
    case "footer":
      return { allowed: { slot: 1 }, required: [], appended: [], slots: ["footer.columns"] };
    case "product_main":
      return { allowed: { "buy_form": 1, reviews: 1, recommendations: 1, gallery: 1 }, required: ["buy_form"], appended: [] };
    case "listing_main":
      return { allowed: { filters: 1, toolbar: 1, pagination: 1 }, required: [], appended: ["pagination"] };
    default:
      return NO_EMBEDS;
  }
}

/** When an island's client module loads. */
export const STOREFRONT_ISLAND_HYDRATION = ["load", "idle", "visible", "interaction"] as const;
export type StorefrontIslandHydration = (typeof STOREFRONT_ISLAND_HYDRATION)[number];

/** Budgets the packer and the upload enforce, and the storefront holds a render to. */
export const STOREFRONT_COMPONENT_LIMITS = {
  /** The compiled module (server side; loaded on an isolate's first render). */
  moduleBytes: 512 * 1024,
  /** The one stylesheet. */
  stylesheetBytes: 96 * 1024,
  /** One island's client module. */
  islandBytes: 64 * 1024,
  /** All islands together. */
  islandsBytes: 192 * 1024,
  /** One public file (a font, an image). */
  publicFileBytes: 512 * 1024,
  /** All public files together. */
  publicBytes: 4 * 1024 * 1024,
  /** Public files per app. */
  publicFiles: 40,
  /** Markup one render answers. */
  htmlBytes: 256 * 1024,
  /** Element nesting and element count of one render's markup. */
  htmlDepth: 48,
  htmlElements: 6_000,
  /** A batch's wall time before the storefront falls back to its own blocks. */
  renderWallMs: 250,
  /** CPU one batch may use in its isolate. */
  renderCpuMs: 50,
  /** Jobs one batch carries (a listing's cards, the chrome, the sections). */
  batchJobs: 120,
} as const;

/** Public file types an app may ship (fonts and images). */
export const STOREFRONT_PUBLIC_FILE_TYPES: Readonly<Record<string, string>> = {
  woff2: "font/woff2",
  woff: "font/woff",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
};

/** Where each compiled file sits in a package (and in R2 under the release). */
export const STOREFRONT_PACKAGE_DIR = "storefront";
export const STOREFRONT_MODULE_FILE = "storefront.js";
export const STOREFRONT_STYLESHEET_FILE = "styles.css";
export const storefrontIslandFile = (name: string) => `islands/${name}.js`;
export const storefrontPublicFile = (path: string) => `public/${path}`;

/** A file path inside the storefront part of a package: lower case, no `..`. */
export const STOREFRONT_FILE_PATH = /^(?:storefront\.js|styles\.css|islands\/[a-z][a-z0-9_-]{0,47}\.js|public\/(?:[a-z0-9][a-z0-9_-]{0,63}\/){0,3}[a-z0-9][a-z0-9_.-]{0,99})$/;

/** The content type a storefront file is served with; null for a path that is not one. */
export function storefrontFileContentType(path: string): string | null {
  if (!STOREFRONT_FILE_PATH.test(path) || path.includes("..")) return null;
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  const extension = path.slice(path.lastIndexOf(".") + 1);
  return STOREFRONT_PUBLIC_FILE_TYPES[extension] ?? null;
}

/**
 * The digests the packer seals into the plugin bundle (like the listing
 * images'): one line `//# scalius-storefront {"<path>":"<sha256>",…}`. The
 * bundle's SHA-256, which the signature covers, thus pins every storefront
 * file; the upload, the file route and the isolate loader check each one.
 */
export const STOREFRONT_SEAL_PREFIX = "//# scalius-storefront ";

export function sealedStorefrontDigests(code: string): Record<string, string> {
  const start = code.lastIndexOf(STOREFRONT_SEAL_PREFIX);
  if (start < 0) return {};
  const line = code.slice(start + STOREFRONT_SEAL_PREFIX.length).split("\n", 1)[0] ?? "";
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const digests: Record<string, string> = {};
    for (const [path, digest] of Object.entries(parsed)) {
      if (STOREFRONT_FILE_PATH.test(path) && typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest)) digests[path] = digest;
    }
    return digests;
  } catch {
    return {};
  }
}

// ── Data a component gets ─────────────────────────────────────────────────

/** An image, ready for `<img>`: a URL, an optional `srcset` of renditions, the intrinsic size and alt text. */
export interface StorefrontImage {
  url: string;
  srcset: string | null;
  width: number | null;
  height: number | null;
  alt: string;
}

/**
 * An amount of money, as every app boundary carries it: integer minor units
 * of `currency` (ISO 4217), with the store's text for it on this page
 * (`formatted`, the format of the store's own prices).
 */
export interface StorefrontMoney {
  amountMinor: number;
  currency: string;
  formatted: string;
}

/** One product as a card shows it. */
export interface StorefrontProductCard {
  id: string;
  title: string;
  url: string;
  price: StorefrontMoney;
  /** The regular price while discounted. */
  compareAt: StorefrontMoney | null;
  /** The price varies by option ("From …"). */
  priceVaries: boolean;
  percentOff: number | null;
  image: StorefrontImage | null;
  /** The second photo when the product has one; the component decides whether to show it (on hover, in a gallery). */
  hoverImage: StorefrontImage | null;
  soldOut: boolean;
  rating: { average: number; count: number } | null;
  /** Adds to the cart in place: no options, no buyer input, in stock (`data-scalius-action="add-to-cart"`). */
  quickAdd: boolean;
  /** Has options to choose on its page. */
  needsOptions: boolean;
  /** Short facts the store shows on cards (key specs, delivery). */
  facts: string[];
  /** Requested storefront-visible custom fields, keyed by namespace.key (money as `StorefrontMoney`). */
  fields: Record<string, CustomFieldWireValue | StorefrontMoney | StorefrontMoney[]>;
}

/** A navigation entry: a title, a store path or https link, and its children (three levels at most). */
export interface StorefrontMenuItem {
  title: string;
  url: string;
  children: StorefrontMenuItem[];
}

export interface StorefrontStoreInfo {
  name: string;
  /** The store's own home URL (`/` on the storefront origin). */
  url: string;
  logo: StorefrontImage | null;
  /** The logo width on computers, in CSS pixels. */
  logoWidth: number;
}

/** What a header skin gets: the store, its header menu and the core routes. */
export interface StorefrontHeaderData {
  store: StorefrontStoreInfo;
  menu: StorefrontMenuItem[];
  /** The top categories with their children, for a category menu. */
  categories: StorefrontMenuItem[];
  announcement: { text: string; url: string | null } | null;
  /** Core routes: put them in links and forms, never hard-code them. */
  routes: { home: string; search: string; cart: string; account: string };
  /** The search form's query parameter. */
  searchParam: string;
  /**
   * The theme's phone navigation (Online store -> Theme): the menu drawer as
   * an accordion or one level at a time (`drill`), and whether the store
   * draws its bottom tab bar under this header on phones. The bar's menu tab
   * opens the element marked with `menuDrawer()` (a `popover` or a dialog).
   * Absent from older stores.
   */
  phoneNavigation?: { menu: "accordion" | "drill"; tabBar: boolean };
  /** The first selected homepage render unit, only when desktop and phone agree. */
  page?: {
    lead:
      | {
          kind: "core";
          type: string;
          /** The header's own app skin of that core section (same-plugin only): its skin id and resolved values. */
          skin?: { id: string; settings: StorefrontResolvedSettings };
        }
      | {
          kind: "app";
          pluginId: string;
          type: string;
          instanceId: string;
          /** Same-plugin settings only; media resolved, product lists empty. */
          settings?: StorefrontResolvedSettings;
        }
      | null;
  };
}

export interface StorefrontFooterData {
  store: StorefrontStoreInfo & {
    footerLogo: StorefrontImage | null;
    phone: string | null;
    email: string | null;
    address: string | null;
    social: Array<{ network: string; url: string }>;
  };
  /** The footer menus, each a titled column. */
  menus: Array<{ title: string; items: StorefrontMenuItem[] }>;
  policies: Array<{ title: string; url: string }>;
  /** The store's newsletter sign-up endpoint is on (POST the form to `routes.newsletter`). */
  newsletter: boolean;
  routes: { home: string; newsletter: string };
  year: number;
}

/** What a product_card skin gets: the card, its place in its list, and whether it shows before the first scroll. */
export interface StorefrontProductCardData {
  product: StorefrontProductCard;
  position: number;
  aboveFold: boolean;
}

/** Storefront-visible custom fields, by `<namespace>.<key>` (JSON per type; money as `StorefrontMoney`). */
export type StorefrontFieldValues = Record<string, unknown>;

/** A page link: its title and store path. */
export interface StorefrontLink {
  title: string;
  url: string;
}

/**
 * What a product_main skin and a product block get: the product as the core
 * product page shows it, priced in the page's market. Availability is a
 * band, never a quantity. The buy form (`<scalius-embed kind="buy_form">`)
 * is the only way to buy: it keeps price and stock current as the buyer
 * chooses options.
 */
export interface StorefrontProductPage {
  product: {
    id: string;
    title: string;
    url: string;
    brand: StorefrontLink | null;
    /** The merchant's description, sanitized by the store; "" without one. */
    descriptionHtml: string;
    /** Photos (a video's poster), in the gallery's order; 20 at most. */
    media: StorefrontImage[];
    /** The price the page opens on (the lowest when options are priced differently). */
    price: StorefrontMoney;
    compareAt: StorefrontMoney | null;
    priceVaries: boolean;
    availability: "untracked" | "out_of_stock" | "low_stock" | "in_stock";
    rating: { average: number; count: number } | null;
    /** The merchant's option axes, in order, with their values. */
    options: Array<{ name: string; values: Array<{ label: string; swatch: string | null }> }>;
    /** The buyer's SKUs (100 at most; sold-out ones `available: false`), each with its value of every option, in option order. */
    variants: Array<{
      id: string;
      title: string;
      options: string[];
      price: StorefrontMoney;
      compareAt: StorefrontMoney | null;
      available: boolean;
      image: StorefrontImage | null;
    }>;
    fields: StorefrontFieldValues;
    /** Home first, the product last. */
    breadcrumbs: StorefrontLink[];
    /**
     * What the buyer types or picks before buying (engraving, gift wrap), in
     * the buy form's order: an island reads the answers with
     * `context.product.state().inputs[key]`. Absent from older stores.
     */
    buyerInputs?: StorefrontBuyerInput[];
  };
}

/** One buyer input of the buy form. */
export interface StorefrontBuyerInput {
  key: string;
  type: "text" | "textarea" | "select" | "checkbox";
  label: string;
  required: boolean;
  /** text and textarea; null without a limit. */
  maxLength: number | null;
  /** select choices; empty otherwise. */
  options: Array<{ value: string; label: string }>;
}

/** The buy form as the buyer has it now (`context.product`). */
export interface StorefrontProductState {
  /** The chosen SKU; null until the buyer has chosen every option. */
  variantId: string | null;
  quantity: number;
  /** Buyer input answers by key (`buyerInputs`); a checkbox is "true" when ticked. */
  inputs: Record<string, string>;
}

/** What a listing_main skin gets: the listing as the core listing page shows it (this page of it). */
export interface StorefrontListingPage {
  kind: "category" | "collection" | "brand" | "search";
  title: string;
  /** The merchant's description on the first page, sanitized by the store; null otherwise. */
  descriptionHtml: string | null;
  /** The listing's banner image, when the theme shows one. */
  image: StorefrontImage | null;
  cards: StorefrontProductCard[];
  /** Products in the whole listing (a lower bound when `totalIsCapped`). */
  total: number;
  totalIsCapped: boolean;
  page: number;
  pageCount: number;
  /** Home and the published ancestors (empty on search). */
  breadcrumbs: StorefrontLink[];
  fields: StorefrontFieldValues;
}

/** A category, collection or brand as a tile shows it. */
export interface StorefrontTile {
  id: string;
  title: string;
  url: string;
  image: StorefrontImage | null;
  /** A collection's own products (collections sections only); empty otherwise. */
  cards: StorefrontProductCard[];
}

/** A product source as a section shows it: its title, its listing ("View all"; null without one) and its first cards. */
export interface StorefrontProductList {
  title: string;
  url: string | null;
  cards: StorefrontProductCard[];
}

// ── Core section projections ──────────────────────────────────────────────
//
// What a core section's skin gets as `data.settings`: a projection of the
// section the merchant filled in, declared here and versioned on its own, so
// core can change how it stores a section while skins keep reading this. The
// host maps core's settings to these in one place; a projection only gains
// optional fields within its version. Hidden blocks are left out.

/** Where a photo's subject is, in percent of its width (`x`) and height (`y`). */
export interface StorefrontFocalPoint {
  x: number;
  y: number;
}

/** A delivery-facts strip's facts, as the store words them. */
export interface StorefrontDeliveryFacts {
  kind: "delivery-facts";
  items: Array<{ title: string; detail: string }>;
}

/** One public field of an object a section shows, formatted once by the store. */
export interface StorefrontObjectFieldView {
  key: string;
  name: string;
  parts: Array<
    | { kind: "text"; text: string }
    | { kind: "link"; href: string; label: string; external: boolean }
    | { kind: "color"; value: string }
    | { kind: "image"; asset: { id: string; url: string; alt: string; width: number | null; height: number | null } }
  >;
  list: boolean;
}

/** A running promotion's end (ISO 8601); null once it ended or when it is unknown. */
export interface StorefrontPromotionEnd {
  endsAt: string;
}

export interface StorefrontHeroSkinSettings {
  layout: "full-bleed" | "contained-banners" | "split" | "full-screen" | "wide-editorial";
  slides: Array<{
    image: StorefrontImage | null;
    phoneImage?: StorefrontImage | null;
    focalPoint: StorefrontFocalPoint;
    phoneFocalPoint?: StorefrontFocalPoint;
    alt: string;
    heading?: string;
    text?: string;
    buttonLabel?: string;
    link: string | null;
  }>;
  phonePlacement?: "after-categories";
  sideBanners?: Array<{ image: StorefrontImage | null; alt: string; href: string | null }>;
  phoneHeight?: "screen" | "compact";
}

export interface StorefrontUspStripSkinSettings {
  style: "icons" | "ticker";
  source: StorefrontDeliveryFacts | { kind: "custom"; items: Array<{ title: string; detail: string }> };
}

export interface StorefrontCategoryTilesSkinSettings {
  style: "photo" | "photo-grid" | "round" | "round-small" | "round-row" | "icons" | "quad" | "square";
  title: string;
  categories: StorefrontTile[];
}

export interface StorefrontCollectionsSkinSettings {
  carousel: "large" | "compact";
  /** Each collection with its own products (`cards`); none until the merchant picks them (see `data.cards`). */
  collections: StorefrontTile[];
  title?: string;
}

export interface StorefrontProductRailSkinSettings {
  title: string;
  products: StorefrontProductList;
  limit: number;
}

export interface StorefrontProductGridSkinSettings {
  title: string;
  products: StorefrontProductList;
  columns: number;
  rows: number;
}

export interface StorefrontDealBlockSkinSettings {
  title: string;
  products: StorefrontProductList;
  promotion?: StorefrontPromotionEnd | null;
  image?: StorefrontImage | null;
}

export interface StorefrontProductTabsSkinSettings {
  title: string;
  tabs: Array<{ label: string; products: StorefrontProductList }>;
  limit: number;
}

export interface StorefrontShopBySkinSettings {
  title: string;
  cards: Array<{ image: StorefrontImage | null; title: string; subtitle?: string; href: string }>;
}

export interface StorefrontBannerMosaicSkinSettings {
  tiles: Array<{ image: StorefrontImage | null; alt: string; href: string | null }>;
}

export interface StorefrontLookbookSkinSettings {
  title: string;
  image: StorefrontImage | null;
  products: StorefrontProductList;
  photo: "tall" | "square";
}

export interface StorefrontBannerSkinSettings {
  layout: "full" | "two-up" | "four-up";
  heading: string;
  text: string;
  image: StorefrontImage | null;
  cta: { label: string; href: string } | null;
}

export interface StorefrontBrandWallSkinSettings {
  title: string;
  style: "grid" | "rail";
}

export type StorefrontEditorialSkinSettings =
  | { layout: "rich-text"; heading: string; body: string }
  | { layout: "image-with-text"; heading: string; body: string; image: StorefrontImage | null; imageSide: "start" | "end" }
  | { layout: "multicolumn"; heading: string; columns: Array<{ title: string; text: string }> }
  | { layout: "testimonial"; quotes: Array<{ quote: string; author: string }> };

export interface StorefrontFaqSkinSettings {
  heading: string;
  items: Array<{ question: string; answer: string }>;
}

export interface StorefrontSpecificationsSkinSettings {
  heading: string;
  /** The connected custom field's object fields, when the section names one (they replace `rows`). */
  objectFields?: StorefrontObjectFieldView[];
  rows: Array<{ label: string; value: string }>;
}

export interface StorefrontUtilityCardsSkinSettings {
  cards: Array<{ title: string; text: string; href: string }>;
}

export interface StorefrontSeoTextSkinSettings {
  heading: string;
  body: string;
}

export interface StorefrontNewsletterSkinSettings {
  heading: string;
  text: string;
  image?: StorefrontImage | null;
  email?: "optional" | "required" | "hidden";
  whatsapp?: boolean;
  buttonLabel?: string;
}

/** Each skinnable core section type's projection (`data.settings` of a `section:<type>` skin). */
export interface StorefrontSectionSkinSettings {
  hero: StorefrontHeroSkinSettings;
  "usp_strip": StorefrontUspStripSkinSettings;
  "category_tiles": StorefrontCategoryTilesSkinSettings;
  collections: StorefrontCollectionsSkinSettings;
  "product_rail": StorefrontProductRailSkinSettings;
  "product_grid": StorefrontProductGridSkinSettings;
  "deal_block": StorefrontDealBlockSkinSettings;
  "product_tabs": StorefrontProductTabsSkinSettings;
  lookbook: StorefrontLookbookSkinSettings;
  banner: StorefrontBannerSkinSettings;
  "shop_by": StorefrontShopBySkinSettings;
  "banner_mosaic": StorefrontBannerMosaicSkinSettings;
  "brand_wall": StorefrontBrandWallSkinSettings;
  editorial: StorefrontEditorialSkinSettings;
  faq: StorefrontFaqSkinSettings;
  specifications: StorefrontSpecificationsSkinSettings;
  "utility_cards": StorefrontUtilityCardsSkinSettings;
  "seo_text": StorefrontSeoTextSkinSettings;
  newsletter: StorefrontNewsletterSkinSettings;
}
/** A core section type a skin may draw (`section:<type>`). */
export type StorefrontSkinnableSection = keyof StorefrontSectionSkinSettings;

/**
 * The projection version of each skinnable core section type, as
 * `StorefrontSectionSkinData.version` carries it. A projection only gains
 * optional fields within its version.
 */
export const STOREFRONT_SECTION_SKIN_PROJECTIONS = {
  hero: 1,
  "usp_strip": 1,
  "category_tiles": 1,
  collections: 1,
  "product_rail": 1,
  "product_grid": 1,
  "deal_block": 1,
  "product_tabs": 1,
  lookbook: 1,
  banner: 1,
  "shop_by": 1,
  "banner_mosaic": 1,
  "brand_wall": 1,
  editorial: 1,
  faq: 1,
  specifications: 1,
  "utility_cards": 1,
  "seo_text": 1,
  newsletter: 1,
} as const satisfies Record<StorefrontSkinnableSection, number>;

/**
 * What a core section's skin (`section:<type>`) gets: the section's
 * projection (`StorefrontSectionSkinSettings[type]`, at the projection
 * `version`) and the store data it shows beyond its settings.
 */
export interface StorefrontSectionSkinData<Settings = Record<string, unknown>> {
  type: string;
  /** The projection's version (`STOREFRONT_SECTION_SKIN_PROJECTIONS[type]`), not core's section version. */
  version: number;
  settings: Settings;
  /** Store data the section shows beyond its settings: a brand wall's brands. */
  tiles: StorefrontTile[];
  /** A collections section's newest products when no collection has any; an endless grid's first page. */
  cards: StorefrontProductCard[];
  /**
   * The section holds the first photos buyers see before scrolling (the
   * homepage's lead section): load its first row of photos eagerly, as the
   * core section does. Absent or false everywhere else.
   */
  aboveFold?: boolean;
}

/** A section's settings as its component gets them: every image, product source, link and list resolved. */
export type StorefrontResolvedSettings = Record<string, StorefrontResolvedValue>;
export type StorefrontResolvedValue =
  | string
  | number
  | boolean
  | string[]
  | StorefrontImage
  | StorefrontProductCard
  | StorefrontProductCard[]
  | Array<Record<string, string | number | boolean | StorefrontImage | null>>
  | null;

/** The page around a render. */
export interface StorefrontRenderContext {
  store: {
    name: string;
    /** The page market's currency (ISO 4217). */
    currency: string;
    /** The page's language and the store's country (BCP 47: `en-US`, `bn-BD`); format with the SDK's `formatNumber`, `plural`, `formatDate`. */
    locale: string;
    /** The page's language (BCP 47: `en`, `bn`, `pt-BR`); pick words with the SDK's `t`. */
    language: string;
    /** The store's IANA time zone (Settings -> Store details), for dates a merchant typed. */
    timeZone: string;
  };
  page: { kind: "home" | "landing" | "product" | "listing" | "search" | "cart" | "page" | "other"; path: string };
  /** The app's file base URL (`/_x/<plugin id>/<release>/`): its public files are under `public/`. */
  assets: string;
  /** The theme editor's preview: components may mark editable text (`editable()`). */
  preview: boolean;
}

interface SkinJobBase {
  id: string;
  kind: "skin";
  /** The manifest skin id. */
  component: string;
  /** The merchant's values for the skin (no images or products: a skin reads nothing). */
  settings: StorefrontResolvedSettings;
}

export type StorefrontSkinJob =
  | (SkinJobBase & { target: "header"; data: StorefrontHeaderData })
  | (SkinJobBase & { target: "footer"; data: StorefrontFooterData })
  | (SkinJobBase & { target: "product_card"; data: StorefrontProductCardData })
  | (SkinJobBase & { target: "product_main"; data: StorefrontProductPage })
  | (SkinJobBase & { target: "listing_main"; data: StorefrontListingPage })
  | (SkinJobBase & {
    target: `section:${string}`;
    /** The theme's id of the section placement. */
    instanceId: string;
    data: StorefrontSectionSkinData;
  });

export type StorefrontRenderJob =
  | {
    id: string;
    kind: "section";
    /** Published records from the section's declared public object reads (money fields as `StorefrontMoney`). */
    objects?: Record<string, { records: Array<{ id: string; handle: string | null; data: Record<string, unknown> }>; fields: Record<string, string> }>;
    /** The manifest section type. */
    type: string;
    /** The theme's id of this placement. */
    instanceId: string;
    settings: StorefrontResolvedSettings;
  }
  | StorefrontSkinJob
  | StorefrontComponentJob;

interface ComponentJobBase {
  id: string;
  kind: "component";
  /** The manifest component type (`storefront.components`). */
  type: string;
  /** The merchant's values for its placement (product slots), else its defaults; no images or products. */
  settings: StorefrontResolvedSettings;
}

/** An app component, at one of its targets. */
export type StorefrontComponentJob =
  | (ComponentJobBase & {
    target: StorefrontProductSlot;
    /** The theme's id of this placement (the product page's app blocks). */
    instanceId: string;
    data: StorefrontProductPage;
  })
  | (ComponentJobBase & { target: Exclude<StorefrontComponentSlot, StorefrontProductSlot> })
  | (ComponentJobBase & {
    target: "page";
    /** What the app's proxy route answered as the page's `props` (JSON; escaped like any other text). */
    props: Record<string, unknown>;
  });

export interface StorefrontRenderBatch {
  abi: typeof STOREFRONT_COMPONENT_ABI;
  context: StorefrontRenderContext;
  jobs: StorefrontRenderJob[];
}

export type StorefrontRenderResult = { id: string; html: string } | { id: string; error: string };

export interface StorefrontRenderReply {
  abi: typeof STOREFRONT_COMPONENT_ABI;
  results: StorefrontRenderResult[];
}

/** What a storefront module exports by default (`defineStorefront`). */
export interface StorefrontModule {
  abi: typeof STOREFRONT_COMPONENT_ABI;
  render(batch: StorefrontRenderBatch): StorefrontRenderReply;
}

// ── Islands (in the buyer's browser) ──────────────────────────────────────

/** What an island's `mount` gets besides its element and props. */
export interface StorefrontIslandContext {
  pluginId: string;
  /** The app's file base URL (its public files are under `public/`). */
  assets: string;
  /** The page's language (BCP 47). */
  language: string;
  currency: string;
  /** Formats an amount (integer minor units of its currency) as the store does. */
  formatMoney(money: { amountMinor: number; currency: string }): string;
  /** Opens the cart drawer. */
  openCart(): void;
  /**
   * Adds a simple product to the cart from its URL and opens the cart, as a
   * card's quick add does. False when the product needs its page (options,
   * buyer input, sold out): navigate there.
   */
  quickAdd(productUrl: string): Promise<boolean>;
  /** Calls the cart's listener now and on every change; returns the unsubscribe. */
  onCart(listener: (cart: { count: number; total: StorefrontMoney }) => void): () => void;
  /** Calls the app's public routes through the storefront proxy (`/apps/<plugin id>/<path>`). */
  fetchApp(path: string, init?: RequestInit): Promise<Response>;
  /**
   * On a product page: the store's buy form, read through the store (never
   * its markup). `onChange` calls the listener when the variant, quantity or
   * an answer changes; it returns the unsubscribe. Absent on other pages.
   */
  product?: {
    state(): StorefrontProductState;
    onChange(listener: (state: StorefrontProductState) => void): () => void;
  };
}

/** An island's client module (`defineIsland`): mounts on its element, may return a cleanup. */
export interface StorefrontIslandModule<Props = unknown> {
  abi: typeof STOREFRONT_COMPONENT_ABI;
  mount(element: HTMLElement, props: Props, context: StorefrontIslandContext): void | (() => void);
}

/** The path prefix of app storefront files on the store's origin. */
export const STOREFRONT_EXTENSION_PREFIX = "/_x/";

/** `/_x/<plugin id>/<release>/`: where an app's storefront files are served on the store's origin (immutable). */
export function storefrontExtensionBase(pluginId: string, release: string): string {
  return `${STOREFRONT_EXTENSION_PREFIX}${pluginId}/${release}/`;
}

/** The plugin id, release and file path a `/_x/…` path names; null for anything else. */
export function parseStorefrontExtensionPath(pathname: string): { pluginId: string; release: string; path: string } | null {
  const match = /^\/_x\/([a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*)\/([0-9a-f]{64})\/(.+)$/.exec(pathname);
  if (!match || !STOREFRONT_FILE_PATH.test(match[3]!)) return null;
  return { pluginId: match[1]!, release: match[2]!, path: match[3]! };
}

/** The isolate id of one app release's storefront module. */
export function storefrontIsolateId(pluginId: string, release: string): string {
  return `storefront:${pluginId}:${release}`;
}
