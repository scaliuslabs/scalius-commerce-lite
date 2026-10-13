// The storefront components protocol without its schemas (no zod): the
// constants, data shapes and render messages the SDK, the islands and the
// storefront share. Bundled into every app's storefront module and island,
// so it stays small and dependency-free. The rest of the contract (manifest
// schemas, settings resolution) is ./storefront-components.ts.

// ── Protocol ──────────────────────────────────────────────────────────────

/** The render protocol between the storefront and a storefront module. */
export const STOREFRONT_COMPONENT_ABI = 1 as const;

/** Theme slots an app can fill. The core block renders whenever the app's slot draws nothing. */
export const STOREFRONT_COMPONENT_SLOTS = ["header", "footer", "product-card"] as const;
export type StorefrontComponentSlot = (typeof STOREFRONT_COMPONENT_SLOTS)[number];

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

/** What a header slot gets: the store, its header menu and the core routes. */
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
  /** The first selected homepage render unit, only when desktop and phone agree. */
  page?: {
    lead:
      | { kind: "core"; type: string }
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
  /** `timeZone`: the store's IANA time zone (Settings -> Store details), for dates a merchant typed. */
  store: { name: string; currency: string; locale: string; language: "en" | "bn"; timeZone: string };
  page: { kind: "home" | "landing" | "product" | "listing" | "search" | "cart" | "page" | "other"; path: string };
  /** The app's file base URL (`/_x/<plugin id>/<release>/`): its public files are under `public/`. */
  assets: string;
  /** The theme editor's preview: components may mark editable text (`editable()`). */
  preview: boolean;
}

export type StorefrontRenderJob =
  | {
    id: string;
    kind: "section";
    /** The manifest section type. */
    type: string;
    /** The theme's id of this placement. */
    instanceId: string;
    settings: StorefrontResolvedSettings;
  }
  | {
    id: string;
    kind: "slot";
    slot: "header";
    /** The manifest slot id. */
    component: string;
    settings: StorefrontResolvedSettings;
    data: StorefrontHeaderData;
  }
  | {
    id: string;
    kind: "slot";
    slot: "footer";
    component: string;
    settings: StorefrontResolvedSettings;
    data: StorefrontFooterData;
  }
  | {
    id: string;
    kind: "slot";
    slot: "product-card";
    component: string;
    settings: StorefrontResolvedSettings;
    data: { product: StorefrontProductCard; position: number; aboveFold: boolean };
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
  language: "en" | "bn";
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
