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
 * market. Moving a read to market-keyed (price lists, FX and translations
 * in step 4) is a change of this table, never of a route alone.
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

/** Step 2: every market sells the one catalogue at base prices in the shop currency, untranslated. */
const SAME_CATALOGUE = "Every market sells the same catalogue at base prices in the shop currency until price lists, FX and translations (step 4).";
const STORE_WIDE_DELIVERY = "Delivery methods and locations are store-wide until markets link delivery methods (step 3).";
const STORE_WIDE_COPY = "Buyer copy is store-wide until translations (step 4).";

const MAX_PUBLIC_CACHE_QUERY_ENTRIES = 30;
const MAX_PUBLIC_CACHE_QUERY_KEY_LENGTH = 64;
const MAX_PUBLIC_CACHE_QUERY_VALUE_LENGTH = 512;

export const PUBLIC_API_CACHE_ROUTES: readonly PublicApiCacheRoute[] = [
  { path: "/api/v1/products", market: { invariant: SAME_CATALOGUE } },
  { path: "/api/v1/categories", market: { invariant: SAME_CATALOGUE } },
  { path: "/api/v1/brands", market: { invariant: SAME_CATALOGUE } },
  { path: "/api/v1/collections", market: { invariant: SAME_CATALOGUE } },
  // One fixed read: a query string is rejected by the route, and never cached or batched.
  { path: "/api/v1/storefront/homepage", exact: true, isEligible: (url) => url.searchParams.size === 0, market: { invariant: SAME_CATALOGUE } },
  // The checkout settings of the page's market; payment and delivery methods are store-wide until markets link them (steps 3 and 6).
  { path: "/api/v1/checkout/config", exact: true, market: { keyed: true } },
  // The cart and checkout copy; every checkout-language write bumps the generation.
  { path: "/api/v1/checkout-languages/active", exact: true, isEligible: (url) => url.searchParams.size === 0, market: { invariant: STORE_WIDE_COPY } },
  { path: "/api/v1/shipping-methods", market: { invariant: STORE_WIDE_DELIVERY } },
  { path: "/api/v1/locations", market: { invariant: STORE_WIDE_DELIVERY } },
  // One country's address rules (libaddressinput): code, not data, the same for every market.
  { path: "/api/v1/address-rules", isEligible: (url) => url.searchParams.size === 0, market: { invariant: "Address rules are code (libaddressinput metadata), the same in every market." } },
  { path: "/api/v1/attributes", market: { invariant: SAME_CATALOGUE } },
  { path: "/api/v1/pages", market: { invariant: SAME_CATALOGUE } },
  { path: "/api/v1/articles", market: { invariant: SAME_CATALOGUE } },
  { path: "/api/v1/seo", market: { invariant: "Discovery policy (feeds, titles, the social image) is store-wide." } },
  { path: "/api/v1/navigation", market: { invariant: SAME_CATALOGUE } },
  { path: "/api/v1/storefront/pages/slug", market: { invariant: SAME_CATALOGUE } },
  { path: "/api/v1/storefront/landing", isEligible: (url) => url.searchParams.size === 0, market: { invariant: SAME_CATALOGUE } },
  // The layout carries the whole presence matrix, the same for every market.
  { path: "/api/v1/storefront/layout", exact: true, market: { invariant: "The layout is store-wide and carries the whole active presence matrix." } },
  // A product page's app blocks (`/product-apps/<slug>`); a query string is rejected by the route.
  { path: "/api/v1/storefront/product-apps", isEligible: (url) => url.searchParams.size === 0, market: { invariant: SAME_CATALOGUE } },
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
