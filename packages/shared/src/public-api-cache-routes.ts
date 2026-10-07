/**
 * Anonymous public API reads that are cached under the store's cache
 * generation, and the storefront read batch built on them.
 *
 * The API caches these routes (apps/api/src/public-cache-policy.ts). The
 * storefront renders a page from several of them; instead of one service
 * binding call each, it sends them together to `STOREFRONT_BATCH_PATH`, which
 * answers every part from the same generation-keyed cache in one invocation.
 * Only routes in this list can be batched, so a batch never reaches a private
 * or uncached route.
 *
 * Every route also says, here and only here, whether its answer varies by
 * market (docs/MARKETS-DESIGN.md D4). A market-keyed read carries the page's
 * presence (`?presence=en-in`; none means the root, the backup market), so
 * the presence is part of its cache key, and the route reads its market
 * through `publicMarketPresence`, which refuses a market-invariant route. A
 * market-invariant read gets no presence: one cache entry serves every
 * market. Moving a read to market-keyed (price lists and FX in step 4a,
 * translations in step 4b) is a change of this table, never of a route alone.
 * A presence also names its language (MARKETS-DESIGN D9): every read that
 * shows translatable buyer text is keyed, so its translation travels in the
 * same key. A store with only the root presence sends no `presence` at all,
 * so its keys do not change.
 */
import type { StorefrontBatchPartCache } from "./cache-frontier";
import { MARKET_PRESENCE_QUERY_PARAM } from "./markets";

/** How a public read relates to markets: keyed by the page's presence, or the same in every market (with the reason). */
export type PublicApiMarketScope = { readonly keyed: true } | { readonly invariant: string };

export interface PublicApiCacheRoute {
  path: string;
  exact?: boolean;
  isEligible?: (url: URL) => boolean;
  market: PublicApiMarketScope;
}

/** A read with only the page's presence in its query (a route that takes no other query). */
const presenceOnly = (url: URL) => url.searchParams.size === 0
  || (url.searchParams.size === 1 && url.searchParams.has(MARKET_PRESENCE_QUERY_PARAM));

const MAX_PUBLIC_CACHE_QUERY_ENTRIES = 30;
const MAX_PUBLIC_CACHE_QUERY_KEY_LENGTH = 64;
const MAX_PUBLIC_CACHE_QUERY_VALUE_LENGTH = 512;

export const PUBLIC_API_CACHE_ROUTES: readonly PublicApiCacheRoute[] = [
  // Prices (step 4a): a presence's market may price its own way (FX, price
  // lists), so every read that shows a product price is market-keyed. A
  // market that prices like the backup market answers the root's bytes.
  { path: "/api/v1/products", market: { keyed: true } },
  { path: "/api/v1/categories", market: { keyed: true } },
  { path: "/api/v1/brands", market: { keyed: true } },
  { path: "/api/v1/collections", market: { keyed: true } },
  // One fixed read: a query string other than the presence is rejected by the route, and never cached or batched.
  { path: "/api/v1/storefront/homepage", exact: true, isEligible: presenceOnly, market: { keyed: true } },
  // The checkout settings of the page's market, and its payment method names in its language (step 4b).
  { path: "/api/v1/checkout/config", exact: true, market: { keyed: true } },
  // The cart and checkout copy of the page's language (step 4b): its own copy, else the default language's.
  { path: "/api/v1/checkout-languages/active", exact: true, isEligible: presenceOnly, market: { keyed: true } },
  // Delivery rate names in the page's language (step 4b); the rates themselves are the zones'.
  { path: "/api/v1/shipping-methods", market: { keyed: true } },
  { path: "/api/v1/locations", market: { invariant: "The place directory (City, Thana, Area names) is the same in every market and language." } },
  // One country's address rules (libaddressinput): code, not data, the same for every market.
  { path: "/api/v1/address-rules", isEligible: (url) => url.searchParams.size === 0, market: { invariant: "Address rules are code (libaddressinput metadata), the same in every market." } },
  { path: "/api/v1/attributes", market: { invariant: "Attribute names and values show no price and are not translated yet (step 4b defers them)." } },
  // CMS pages, articles and store policies in the page's language (step 4b).
  { path: "/api/v1/pages", market: { keyed: true } },
  { path: "/api/v1/articles", market: { keyed: true } },
  { path: "/api/v1/seo", market: { invariant: "Discovery policy (feeds, titles, the social image) is store-wide." } },
  // Menus in the page's language (step 4b).
  { path: "/api/v1/navigation", market: { keyed: true } },
  { path: "/api/v1/storefront/pages/slug", market: { keyed: true } },
  // A landing page's product lists are priced in the page's market.
  { path: "/api/v1/storefront/landing", isEligible: presenceOnly, market: { keyed: true } },
  // The layout: the whole presence matrix (the same everywhere), and the
  // page's menus, category tree, policies and storefront copy in its language (step 4b).
  { path: "/api/v1/storefront/layout", exact: true, isEligible: presenceOnly, market: { keyed: true } },
  // A product page's app blocks (`/product-apps/<slug>`); a query string is rejected by the route.
  { path: "/api/v1/storefront/product-apps", isEligible: (url) => url.searchParams.size === 0, market: { invariant: "An app's product blocks are drawn store-wide (a localized handle names its product too); apps read no market until step 6." } },
  // The active presence matrix, for the storefront gateway's buyer-choice redirect.
  { path: "/api/v1/storefront/markets", exact: true, isEligible: (url) => url.searchParams.size === 0, market: { invariant: "The presence matrix is the same for every market." } },
];

function routeMatches(pathname: string, route: PublicApiCacheRoute): boolean {
  if (route.exact) return pathname === route.path;
  return pathname === route.path || pathname.startsWith(`${route.path}/`);
}

export function hasBoundedPublicQuery(url: URL): boolean {
  const entries = [...url.searchParams.entries()];
  return (
    entries.length <= MAX_PUBLIC_CACHE_QUERY_ENTRIES &&
    entries.every(
      ([key, value]) =>
        key.length <= MAX_PUBLIC_CACHE_QUERY_KEY_LENGTH &&
        value.length <= MAX_PUBLIC_CACHE_QUERY_VALUE_LENGTH,
    )
  );
}

/** The cached public route this GET reads, or null. */
export function publicApiCacheRouteOf(url: URL): PublicApiCacheRoute | null {
  if (!hasBoundedPublicQuery(url)) return null;
  const pathname = url.pathname.replace(/\/$/, "") || "/";
  return PUBLIC_API_CACHE_ROUTES.find(
    (route) => routeMatches(pathname, route) && (!route.isEligible || route.isEligible(url)),
  ) ?? null;
}

/** Whether a GET of this URL is a generation-cached public API read. */
export function isPublicApiCacheRoute(url: URL): boolean {
  return publicApiCacheRouteOf(url) !== null;
}

/** Whether this public read's answer varies by market (it then carries the page's presence). */
export function isMarketKeyedPublicRead(url: URL): boolean {
  const route = publicApiCacheRouteOf(url);
  return route !== null && "keyed" in route.market;
}

/**
 * The public read for a page under a subfolder presence: a market-keyed
 * read gains `?presence=<value>`; every other URL, and every URL of a root
 * page (`presence` empty), is returned as it is.
 */
export function withMarketPresence(url: URL, presence: string | null | undefined): URL {
  if (!presence || !isMarketKeyedPublicRead(url)) return url;
  const next = new URL(url);
  next.searchParams.set(MARKET_PRESENCE_QUERY_PARAM, presence);
  return next;
}

/** One storefront render's public reads, answered in one API invocation. */
export const STOREFRONT_BATCH_PATH = "/api/v1/storefront/batch";
/** Query parameter carrying each part's path and query, in order. */
export const STOREFRONT_BATCH_PART_PARAM = "r";
/** A page render needs at most a handful of reads. */
export const MAX_STOREFRONT_BATCH_PARTS = 8;
const MAX_STOREFRONT_BATCH_PART_LENGTH = 2_048;

/** One part of a batch response: the part's own status and body text. */
export interface StorefrontBatchPartResult {
  status: number;
  contentType: string;
  body: string;
  /**
   * Dependency-validated cache metadata (API strict mode only; see
   * `@scalius/shared/cache-frontier`). Absent: the part carries no proof.
   */
  cache?: StorefrontBatchPartCache;
}

export interface StorefrontBatchResponse {
  parts: StorefrontBatchPartResult[];
}

/**
 * The part a batch may carry for this absolute URL: its path and query when
 * it is a public cached read, otherwise null.
 */
export function storefrontBatchPart(url: URL): string | null {
  if (!isPublicApiCacheRoute(url)) return null;
  const part = `${url.pathname}${url.search}`;
  return part.length <= MAX_STOREFRONT_BATCH_PART_LENGTH ? part : null;
}

/** Batch URL (path and query) for these parts, in order. */
export function storefrontBatchPath(parts: readonly string[]): string {
  const query = new URLSearchParams();
  for (const part of parts) query.append(STOREFRONT_BATCH_PART_PARAM, part);
  return `${STOREFRONT_BATCH_PATH}?${query.toString()}`;
}

/**
 * The parts of a batch request, each resolved against `origin`, or null when
 * the batch is malformed or asks for anything but public cached reads.
 */
export function parseStorefrontBatchParts(url: URL): URL[] | null {
  const parts = url.searchParams.getAll(STOREFRONT_BATCH_PART_PARAM);
  if (parts.length === 0 || parts.length > MAX_STOREFRONT_BATCH_PARTS) return null;
  if ([...url.searchParams.keys()].some((key) => key !== STOREFRONT_BATCH_PART_PARAM)) {
    return null;
  }
  const resolved: URL[] = [];
  for (const part of parts) {
    if (
      part.length > MAX_STOREFRONT_BATCH_PART_LENGTH ||
      !part.startsWith("/api/v1/") ||
      part.includes("#") ||
      part.includes("\\")
    ) {
      return null;
    }
    const partUrl = new URL(part, url.origin);
    if (partUrl.origin !== url.origin || !isPublicApiCacheRoute(partUrl)) return null;
    resolved.push(partUrl);
  }
  return resolved;
}
