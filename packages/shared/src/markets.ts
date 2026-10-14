/**
 * Markets (docs/MARKETS-DESIGN.md D4): the presence grammar, the presence
 * path rule every server and client URL builder uses, and the one
 * deterministic resolution of a buyer's market.
 *
 * - The URL decides the page: a subfolder presence (`/en-in/...`) renders its
 *   market; the root renders the backup market. Nothing else changes the
 *   bytes of a URL, so pages stay cacheable and Google-safe.
 * - Each published store language other than the default is also served
 *   on the backup market at `/<locale>` (`/bn`, Shopify's language
 *   subfolders on the primary market). These presences are not stored: the
 *   published language list is their one source (`marketMatrixSql`).
 * - An explicit buyer choice (the `localization` cookie the market selector
 *   sets) may redirect a top-level navigation to the same path under the
 *   chosen presence. Crawlers and non-navigation requests are never
 *   redirected, and nothing is redirected by location.
 * - The geo hint (`cf-ipcountry`) only suggests a market, never redirects.
 * - At checkout, the shipping country decides the order's market.
 */

/**
 * A subfolder presence, lower case: a market's `<locale>-<country>` (`en-in`)
 * or a language of the backup market, `<locale>` (`bn`). The root is `''`.
 */
export const MARKET_SUBFOLDER_PATTERN = /^[a-z]{2}(?:-[a-z]{2})?$/;
/** A market's own subfolder, the only kind a market stores: `<locale>-<country>` (`en-in`). */
export const MARKET_COUNTRY_SUBFOLDER_PATTERN = /^[a-z]{2}-[a-z]{2}$/;
/** A store language's subfolder on the backup market (`bn`): derived from the published languages. */
export const LANGUAGE_SUBFOLDER_PATTERN = /^[a-z]{2}$/;
/** A market handle: lower-case words joined by dashes. */
export const MARKET_HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MARKET_HANDLE_MAX_LENGTH = 60;
export const MARKET_NAME_MAX_LENGTH = 60;
/** A presence locale: an ISO 639-1 language. */
export const MARKET_LOCALE_PATTERN = /^[a-z]{2}$/;
/** An ISO 3166-1 alpha-2 country. */
export const MARKET_COUNTRY_PATTERN = /^[A-Z]{2}$/;
/** Shopify's cap on markets per store; the presence matrix stays small. */
export const MAX_MARKETS = 50;
export const MAX_MARKET_COUNTRIES = 250;

/** The buyer's market choice, as Shopify names it: `<COUNTRY>:<presence>` (`IN:en-in`, `BD:`). */
export const MARKET_SELECTION_COOKIE = "localization";

/** The no-JavaScript market selector posts here (Shopify's `/localization`). */
export const MARKET_SELECTION_PATH = "/localization";
/** The non-blocking geo suggestion reads this (private, never cached). */
export const MARKET_SUGGESTION_PATH = "/api/market-suggestion";
/**
 * The query parameter that carries a non-root presence to a market-keyed
 * public API read (`PUBLIC_API_CACHE_ROUTES`); no parameter means the root
 * presence (the backup market).
 */
export const MARKET_PRESENCE_QUERY_PARAM = "presence";

/** The country of the City/Thana/Area address adapter, defined once in `place-fields.ts`. */
export { DELIVERY_HIERARCHY_COUNTRY } from "./place-fields";

export type MarketStatus = "draft" | "active";

export interface PublicMarketPresence {
  /** `''` (the root, backup market only), `<locale>` (a language of the backup market) or `<locale>-<country>`. */
  value: string;
  locale: string;
}

/** One active market as buyers can be matched to it. */
export interface PublicMarket {
  id: string;
  handle: string;
  name: string;
  isBackup: boolean;
  /**
   * The currency it sells in when it is not the shop currency (MARKETS-DESIGN
   * step 6); absent: the shop currency.
   */
  currencyCode?: string;
  /** ISO 3166-1 alpha-2 codes, sorted. */
  countries: string[];
  /** Its subfolder presences; the backup market's include the root. */
  presences: PublicMarketPresence[];
}

/** The active markets, backup first. */
export interface MarketMatrix {
  markets: PublicMarket[];
}

export function isMarketSubfolder(value: unknown): value is string {
  return typeof value === "string" && MARKET_SUBFOLDER_PATTERN.test(value);
}

/** A language subfolder of the backup market (`bn`): it prices and delivers as the root. */
export function isLanguageSubfolder(value: unknown): value is string {
  return typeof value === "string" && LANGUAGE_SUBFOLDER_PATTERN.test(value);
}

/** The country a market's subfolder names (`en-in` → `IN`); null for the root and a language subfolder. */
export function presenceCountry(value: string | null | undefined): string | null {
  return typeof value === "string" && MARKET_COUNTRY_SUBFOLDER_PATTERN.test(value) ? value.slice(3).toUpperCase() : null;
}

export function normalizeMarketCountry(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return MARKET_COUNTRY_PATTERN.test(code) && code !== "XX" && code !== "T1" ? code : null;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * First path segments that are never storefront pages: API routes, built
 * assets, media, discovery and machine endpoints, and the private relays
 * that agents and the theme editor open by exact URL.
 */
const NON_PAGE_SEGMENTS = new Set([
  "api",
  "_astro",
  "_image",
  "~partytown",
  "media",
  "cdn-cgi",
  ".well-known",
  "ucp",
  "health",
  "theme-preview",
  "agent",
  // The market selector's form target: the same for every presence.
  "localization",
]);

/**
 * Discovery files a subfolder presence serves with its own URLs. Everything
 * else under a presence is a page.
 */
const PRESENCE_DISCOVERY_PATHS = [
  /^\/sitemap\.xml$/,
  /^\/sitemap-[a-z]+\.xml$/,
  /^\/api\/product-feed\.xml$/,
  /^\/api\/facebook-feed\.xml$/,
];

/** Whether a root-relative path names a storefront page (a presence links to it under its subfolder). */
export function isStorefrontPagePath(pathname: string): boolean {
  if (!pathname.startsWith("/") || pathname.startsWith("//") || pathname.includes("\\")) return false;
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return true;
  if (NON_PAGE_SEGMENTS.has(segments[0]!)) return false;
  // A file (robots.txt, sitemap.xml, favicon.svg, feed.xml) is not a page.
  return !segments[segments.length - 1]!.includes(".");
}

/** Whether a presence serves this (presence-stripped) path: its pages and its discovery files. */
export function isPresenceServedPath(pathname: string): boolean {
  return isStorefrontPagePath(pathname) || PRESENCE_DISCOVERY_PATHS.some((pattern) => pattern.test(pathname));
}

/**
 * The subfolder presence a path names by its shape alone (`/en-in/...` →
 * `en-in`), or null for a root path. Whether that presence is active is
 * the presence matrix's answer, never the shape's.
 */
export function presenceOfPath(pathname: string): string | null {
  const first = pathname.split("/")[1] ?? "";
  return isMarketSubfolder(first) ? first : null;
}

/** The path without its presence (`/en-in/products/x` → `/products/x`, `/en-in` → `/`). */
export function stripPresencePath(pathname: string, presence: string | null): string {
  if (!presence) return pathname;
  const prefix = `/${presence}`;
  if (pathname === prefix) return "/";
  return pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) : pathname;
}

/**
 * A root-relative href under a presence: page paths gain the prefix
 * (`/products/x?y=1#z` → `/en-in/products/x?y=1#z`, `/` → `/en-in`); every
 * other href, and every href at the root presence, is returned unchanged.
 * Idempotent: an href already under a presence keeps it.
 */
export function presencePath(presence: string | null | undefined, href: string): string {
  if (!presence || !href.startsWith("/") || href.startsWith("//")) return href;
  const end = href.search(/[?#]/);
  const pathname = end === -1 ? href : href.slice(0, end);
  const rest = end === -1 ? "" : href.slice(end);
  if (presenceOfPath(pathname) !== null) return href;
  if (!isStorefrontPagePath(pathname)) return href;
  return `/${presence}${pathname === "/" ? "" : pathname}${rest}`;
}

/**
 * Any link a page renders, under a presence: a root-relative page href, or
 * an absolute URL on the store's own origin, gains the prefix (the HTML
 * rewriter and the redirect `Location` rule). Other origins, protocol-relative
 * and relative hrefs, fragments and non-HTTP schemes are returned unchanged.
 */
export function presenceHref(presence: string | null | undefined, href: string, origin: string): string {
  if (!presence) return href;
  const trimmed = href.trim();
  if (trimmed.startsWith("/")) return presencePath(presence, trimmed);
  if (!/^https?:\/\//i.test(trimmed)) return href;
  try {
    const url = new URL(trimmed);
    if (url.origin !== origin) return href;
    const localized = presencePath(presence, `${url.pathname}${url.search}${url.hash}`);
    return `${url.origin}${localized}`;
  } catch {
    return href;
  }
}

// ---------------------------------------------------------------------------
// The presence matrix
// ---------------------------------------------------------------------------

export function backupMarket(matrix: MarketMatrix): PublicMarket | null {
  return matrix.markets.find((market) => market.isBackup) ?? null;
}

/** The active market selling to a country, else null. */
export function marketOfCountry(matrix: MarketMatrix, country: string | null | undefined): PublicMarket | null {
  const code = normalizeMarketCountry(country);
  if (!code) return null;
  return matrix.markets.find((market) => market.countries.includes(code)) ?? null;
}

/** The active market and presence of a subfolder, else null. */
export function marketOfPresence(
  matrix: MarketMatrix,
  value: string,
): { market: PublicMarket; presence: PublicMarketPresence } | null {
  for (const market of matrix.markets) {
    const presence = market.presences.find((each) => each.value === value);
    if (presence) return { market, presence };
  }
  return null;
}

/** The URL a market is reached at: the root for the backup market, else its first presence. */
export function primaryPresence(market: PublicMarket): PublicMarketPresence | null {
  if (market.isBackup) return market.presences.find((presence) => presence.value === "") ?? { value: "", locale: "en" };
  return market.presences[0] ?? null;
}

/** Every active subfolder presence, the root included. */
export function activePresences(matrix: MarketMatrix): Array<{ market: PublicMarket; presence: PublicMarketPresence }> {
  const all: Array<{ market: PublicMarket; presence: PublicMarketPresence }> = [];
  for (const market of matrix.markets) {
    for (const presence of market.presences) all.push({ market, presence });
    if (market.isBackup && !market.presences.some((presence) => presence.value === "")) {
      all.push({ market, presence: { value: "", locale: "en" } });
    }
  }
  return all;
}

/**
 * The `hreflang` of a presence: `en-IN` for `en-in`; the root's and a
 * language subfolder's (`/bn`) name the backup's one country when it has
 * exactly one (`bn-BD`), else the language alone.
 */
export function presenceHreflang(market: PublicMarket, presence: PublicMarketPresence): string {
  const country = presenceCountry(presence.value);
  if (country) return `${presence.locale}-${country}`;
  return market.countries.length === 1 ? `${presence.locale}-${market.countries[0]}` : presence.locale;
}

/** The languages a market's pages are in, one presence each (the root first): what a language selector offers. */
export function marketLanguagePresences(market: PublicMarket): PublicMarketPresence[] {
  const seen = new Set<string>();
  const presences = market.isBackup && !market.presences.some((presence) => presence.value === "")
    ? [{ value: "", locale: "en" }, ...market.presences]
    : market.presences;
  return presences.filter((presence) => !seen.has(presence.locale) && Boolean(seen.add(presence.locale)));
}

export interface HreflangAlternate {
  hreflang: string;
  href: string;
}

/**
 * Reciprocal, self-referencing alternates of one page (Google's localized
 * versions), one per active presence plus `x-default` (the root), or none
 * while the store has a single presence (today's HTML stays as it is).
 * `path` is the page's path (and query) without its presence; `origin` the
 * store URL. `pathForLocale` gives a page with localized handles its path in
 * a presence's language (MARKETS-DESIGN D9: `/products/<handle>`); a locale it
 * has no path for uses `path`.
 */
export function hreflangAlternates(
  matrix: MarketMatrix,
  path: string,
  origin: string,
  pathForLocale?: (locale: string) => string | null | undefined,
): HreflangAlternate[] {
  const presences = activePresences(matrix);
  const pathname = path.split(/[?#]/)[0]!;
  if (presences.length < 2 || !isStorefrontPagePath(pathname)) return [];
  const base = origin.replace(/\/$/, "");
  const query = path.slice(pathname.length);
  const localPath = (locale: string) => {
    const localized = pathForLocale?.(locale);
    return localized ? `${localized}${query}` : path;
  };
  const alternates = presences.map(({ market, presence }) => ({
    hreflang: presenceHreflang(market, presence),
    href: `${base}${presencePath(presence.value, localPath(presence.locale))}`,
  }));
  const root = presences.find(({ presence }) => presence.value === "");
  return [...alternates, { hreflang: "x-default", href: `${base}${root ? localPath(root.presence.locale) : path}` }];
}

/** The store default language: the root presence's locale (null without a root presence). */
export function defaultLocale(matrix: MarketMatrix): string | null {
  return activePresences(matrix).find(({ presence }) => presence.value === "")?.presence.locale ?? null;
}

// ---------------------------------------------------------------------------
// The buyer's choice
// ---------------------------------------------------------------------------

export interface MarketSelection {
  country: string;
  /** The presence the selector sent the buyer to (`''` for the root). */
  presence: string;
}

export function formatMarketSelection(selection: MarketSelection): string {
  return `${selection.country}:${selection.presence}`;
}

export function parseMarketSelection(value: string | null | undefined): MarketSelection | null {
  const match = /^([A-Z]{2}):([a-z]{2}(?:-[a-z]{2})?)?$/.exec(value?.trim() ?? "");
  return match ? { country: match[1]!, presence: match[2] ?? "" } : null;
}

/** The selection cookie's value from a Cookie header. */
export function readMarketSelectionCookie(cookieHeader: string | null | undefined): MarketSelection | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1 || part.slice(0, separator).trim() !== MARKET_SELECTION_COOKIE) continue;
    try {
      return parseMarketSelection(decodeURIComponent(part.slice(separator + 1).trim()));
    } catch {
      return null;
    }
  }
  return null;
}

/** Search, social and AI crawlers: never redirected by a buyer's choice. */
const CRAWLER_USER_AGENT = /bot\b|bot\/|crawl|spider|slurp|facebookexternalhit|facebot|mediapartners|adsbot|lighthouse|headlesschrome|preview/i;

export function isCrawlerUserAgent(userAgent: string | null | undefined): boolean {
  return !userAgent || CRAWLER_USER_AGENT.test(userAgent);
}

/** A top-level page navigation (not a fetch, prefetch, frame or asset request). */
export function isTopLevelNavigation(request: { method: string; headers: Headers }): boolean {
  if (request.method !== "GET") return false;
  const purpose = request.headers.get("Sec-Purpose") ?? request.headers.get("Purpose") ?? "";
  if (/prefetch|prerender/i.test(purpose)) return false;
  const mode = request.headers.get("Sec-Fetch-Mode");
  const destination = request.headers.get("Sec-Fetch-Dest");
  if (mode !== null || destination !== null) return mode === "navigate" && (destination === null || destination === "document");
  return /\btext\/html\b/i.test(request.headers.get("Accept") ?? "");
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** A page request: the URL decides; a buyer's choice may redirect; geo only suggests. */
export interface PageMarketSignals {
  surface: "page";
  /** The request path, presence included. */
  pathname: string;
  /** The search string (`?a=1`) a redirect keeps. */
  search?: string;
  /** The `localization` cookie. */
  selection?: MarketSelection | null;
  /** `cf-ipcountry`. */
  geoCountry?: string | null;
  crawler: boolean;
  navigation: boolean;
}

/** Checkout: the shipping country decides the order's market. */
export interface CheckoutMarketSignals {
  surface: "checkout";
  shippingCountry: string | null | undefined;
}

export type MarketResolutionReason =
  /** The page's subfolder presence. */
  | "url_presence"
  /** A root page: the backup market. */
  | "root"
  /** A subfolder shape no active presence holds: the page does not exist. */
  | "unknown_presence"
  /** Checkout: the market selling to the shipping country. */
  | "shipping_country"
  /** Checkout: no market sells to the shipping country. */
  | "backup";

export interface MarketResolution {
  /** Null only for `unknown_presence` (and a store without its backup market). */
  market: PublicMarket | null;
  presence: PublicMarketPresence | null;
  reason: MarketResolutionReason;
  /** Pages only: the same path under the buyer's chosen presence, when it differs. */
  redirect: { location: string; reason: "buyer_choice" } | null;
  /** Pages only: the market the geo hint suggests, when the buyer has not chosen and it differs. */
  suggestion: { market: PublicMarket; presence: PublicMarketPresence; reason: "geo_hint" } | null;
}

/**
 * The one market resolution (MARKETS-DESIGN D4). Pure and deterministic:
 * the same matrix and signals always give the same market and reason.
 */
export function resolveMarket(
  matrix: MarketMatrix,
  signals: PageMarketSignals | CheckoutMarketSignals,
): MarketResolution {
  const backup = backupMarket(matrix);
  if (signals.surface === "checkout") {
    const market = marketOfCountry(matrix, signals.shippingCountry);
    return market
      ? { market, presence: primaryPresence(market), reason: "shipping_country", redirect: null, suggestion: null }
      : { market: backup, presence: backup ? primaryPresence(backup) : null, reason: "backup", redirect: null, suggestion: null };
  }

  const urlPresence = presenceOfPath(signals.pathname);
  let market: PublicMarket | null;
  let presence: PublicMarketPresence | null;
  let reason: MarketResolutionReason;
  if (urlPresence === null) {
    market = backup;
    presence = backup ? primaryPresence(backup) : null;
    reason = "root";
  } else {
    const found = marketOfPresence(matrix, urlPresence);
    if (!found) return { market: null, presence: null, reason: "unknown_presence", redirect: null, suggestion: null };
    ({ market, presence } = found);
    reason = "url_presence";
  }

  const path = stripPresencePath(signals.pathname, urlPresence);
  const eligible = !signals.crawler && isStorefrontPagePath(path);
  let redirect: MarketResolution["redirect"] = null;
  if (eligible && signals.navigation && signals.selection) {
    const chosen = marketOfCountry(matrix, signals.selection.country) ?? backup;
    // The presence the buyer was sent to while it still belongs to that market, else the market's own.
    const target = chosen?.presences.find((each) => each.value === signals.selection!.presence)
      ?? (chosen ? primaryPresence(chosen) : null);
    if (target && target.value !== (urlPresence ?? "")) {
      redirect = { location: `${presencePath(target.value, path)}${signals.search ?? ""}`, reason: "buyer_choice" };
    }
  }

  let suggestion: MarketResolution["suggestion"] = null;
  if (eligible && !signals.selection && market) {
    const hinted = marketOfCountry(matrix, signals.geoCountry);
    const hintedPresence = hinted ? primaryPresence(hinted) : null;
    if (hinted && hintedPresence && hinted.id !== market.id) {
      suggestion = { market: hinted, presence: hintedPresence, reason: "geo_hint" };
    }
  }

  return { market, presence, reason, redirect, suggestion };
}
