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
export const STOREFRONT_SKIN_UNITS = ["header", "footer", "product-card", "product-main", "listing-main"] as const;
export type StorefrontSkinUnit = (typeof STOREFRONT_SKIN_UNITS)[number];
/** A core section's skin targets `section:<core section type>` (`section:hero`). */
export const STOREFRONT_SECTION_SKIN_PREFIX = "section:";
/** What a skin redraws: a fixed unit, or one core section type. */
export type StorefrontSkinTarget = StorefrontSkinUnit | `section:${string}`;

/** Where an app's component product block draws: in the buy box after the buttons, or after the page's modules. */
export const STOREFRONT_BLOCK_TARGETS = ["product.buy-box", "product.below"] as const;
export type StorefrontBlockTarget = (typeof STOREFRONT_BLOCK_TARGETS)[number];

/**
 * Core embeds: `<scalius-embed kind="…">` in a component's markup, where the
 * store renders its own interactive piece with its own data, rules, words
 * and scripts, so an app composes the store's buy form, filters and paging
 * instead of re-implementing them. The markup around an embed is the app's.
 *
 * - `buy-form`: the product's price, options, buyer inputs, quantity and
 *   buttons (a real form; works before hydration). `data-title="false"`
 *   leaves out its heading when the skin draws the product title itself.
 * - `reviews`, `recommendations`: the product's reviews and related products.
 * - `gallery`: the product's photos and videos as the theme's gallery draws
 *   them (one main image with thumbnails, a swipeable stage on phones,
 *   zoom, and the chosen SKU's photo when a variant is picked).
 * - `filters`, `toolbar` (sort and page size), `pagination`: the listing's.
 * - `order-form`: the single-page order form of a landing page, for a
 *   product the section was given (`data-product`, `data-max-quantity`,
 *   `data-submit-label`).
 */
export const STOREFRONT_EMBED_KINDS = ["buy-form", "reviews", "recommendations", "filters", "toolbar", "pagination", "order-form", "gallery"] as const;
export type StorefrontEmbedKind = (typeof STOREFRONT_EMBED_KINDS)[number];
export const STOREFRONT_EMBED_TAG = "scalius-embed";

/**
 * What one render may embed: each allowed kind with how many render (any
 * beyond render nothing, as does a kind not listed), the kinds it must place
 * (without one, core draws the unit instead), and the kinds the host appends
 * when the markup leaves them out (a listing always pages, so crawlers reach
 * every product).
 */
export interface StorefrontEmbedRule {
  allowed: Partial<Record<StorefrontEmbedKind, number>>;
  required: readonly StorefrontEmbedKind[];
  appended: readonly StorefrontEmbedKind[];
}

const NO_EMBEDS: StorefrontEmbedRule = { allowed: {}, required: [], appended: [] };

/** The embed rule of a render: a component section, a skin's target or a product block. */
export function storefrontEmbedRule(unit: "section" | "block" | StorefrontSkinTarget): StorefrontEmbedRule {
  switch (unit) {
    case "section":
      return { allowed: { "order-form": 2 }, required: [], appended: [] };
    case "product-main":
      return { allowed: { "buy-form": 1, reviews: 1, recommendations: 1, gallery: 1 }, required: ["buy-form"], appended: [] };
    case "listing-main":
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
export const STOREFRONT_FILE_PATH = /^(?:storefront\.js|styles\.css|islands\/[a-z][a-z0-9-]{0,47}\.js|public\/(?:[a-z0-9][a-z0-9_-]{0,63}\/){0,3}[a-z0-9][a-z0-9_.-]{0,99})$/;

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

/** An amount in the page's currency: the number and the store's formatting of it. */
export interface StorefrontMoney {
  amount: number;
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
  /** Requested storefront-visible custom fields, keyed by namespace.key. */
  fields: Record<string, CustomFieldWireValue>;
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

/** What a product-card skin gets: the card, its place in its list, and whether it shows before the first scroll. */
export interface StorefrontProductCardData {
  product: StorefrontProductCard;
  position: number;
  aboveFold: boolean;
}

/** Storefront-visible custom fields, by `<namespace>.<key>` (JSON per type; money in major units). */
export type StorefrontFieldValues = Record<string, unknown>;

/** A page link: its title and store path. */
export interface StorefrontLink {
  title: string;
  url: string;
}

/**
 * What a product-main skin and a product block get: the product as the core
 * product page shows it, priced in the page's market. Availability is a
 * band, never a quantity. The buy form (`<scalius-embed kind="buy-form">`)
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
  };
}

/** What a listing-main skin gets: the listing as the core listing page shows it (this page of it). */
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

/**
 * What a core section's skin (`section:<type>`) gets: the section's settings
 * at its `version` with every reference resolved by fixed rules (a media id
 * as `StorefrontImage | null`, a product source as `StorefrontProductList`,
 * category and collection ids as `StorefrontTile[]`, a promotion id as
 * `{ endsAt }`), hidden blocks left out. `CoreSectionSettings<"hero">`
 * (`@scalius/shared/storefront-theme`) types one section's settings.
 */
export interface StorefrontSectionSkinData<Settings = Record<string, unknown>> {
  type: string;
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
  | (SkinJobBase & { target: "product-card"; data: StorefrontProductCardData })
  | (SkinJobBase & { target: "product-main"; data: StorefrontProductPage })
  | (SkinJobBase & { target: "listing-main"; data: StorefrontListingPage })
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
    /** Published records from the section's declared public object reads. */
    objects?: Record<string, { records: Array<{ id: string; handle: string | null; data: Record<string, unknown> }>; fields: Record<string, string> }>;
    /** The manifest section type. */
    type: string;
    /** The theme's id of this placement. */
    instanceId: string;
    settings: StorefrontResolvedSettings;
  }
  | StorefrontSkinJob
  | {
    id: string;
    /** A product block (a `productBlocks` entry). */
    kind: "block";
    target: StorefrontBlockTarget;
    /** The manifest block type. */
    type: string;
    /** The theme's id of this placement. */
    instanceId: string;
    settings: StorefrontResolvedSettings;
    data: StorefrontProductPage;
  };

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
  /** Formats an amount in the page's currency as the store does. */
  formatMoney(amount: number): string;
  /** Opens the cart drawer. */
  openCart(): void;
  /**
   * Adds a simple product to the cart from its URL and opens the cart, as a
   * card's quick add does. False when the product needs its page (options,
   * buyer input, sold out): navigate there.
   */
  quickAdd(productUrl: string): Promise<boolean>;
  /** Calls the cart's listener now and on every change; returns the unsubscribe. */
  onCart(listener: (cart: { count: number; total: number }) => void): () => void;
  /** Calls the app's public routes through the storefront proxy (`/apps/<plugin id>/<path>`). */
  fetchApp(path: string, init?: RequestInit): Promise<Response>;
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
