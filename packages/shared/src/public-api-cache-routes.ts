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
 */

export interface PublicApiCacheRoute {
  path: string;
  exact?: boolean;
  isEligible?: (url: URL) => boolean;
}

const MAX_PUBLIC_CACHE_QUERY_ENTRIES = 30;
const MAX_PUBLIC_CACHE_QUERY_KEY_LENGTH = 64;
const MAX_PUBLIC_CACHE_QUERY_VALUE_LENGTH = 512;

function isHeroRequestEligible(url: URL): boolean {
  const pathname = url.pathname.replace(/\/$/, "");
  if (!pathname.endsWith("/hero/sliders")) {
    return url.searchParams.size === 0;
  }
  return (
    url.searchParams.size === 1 &&
    ["desktop", "mobile"].includes(url.searchParams.get("type") ?? "")
  );
}

export const PUBLIC_API_CACHE_ROUTES: readonly PublicApiCacheRoute[] = [
  { path: "/api/v1/products" },
  { path: "/api/v1/categories" },
  { path: "/api/v1/collections" },
  // One fixed read: a query string is rejected by the route, and never cached or batched.
  { path: "/api/v1/storefront/homepage", exact: true, isEligible: (url) => url.searchParams.size === 0 },
  { path: "/api/v1/checkout/config", exact: true },
  // The cart and checkout copy; every checkout-language write bumps the generation.
  { path: "/api/v1/checkout-languages/active", exact: true, isEligible: (url) => url.searchParams.size === 0 },
  { path: "/api/v1/shipping-methods" },
  { path: "/api/v1/locations" },
  { path: "/api/v1/attributes" },
  { path: "/api/v1/pages" },
  { path: "/api/v1/articles" },
  { path: "/api/v1/hero", isEligible: isHeroRequestEligible },
  { path: "/api/v1/seo" },
  { path: "/api/v1/header" },
  { path: "/api/v1/navigation" },
  { path: "/api/v1/footer" },
  { path: "/api/v1/storefront/pages/slug" },
  { path: "/api/v1/storefront/layout", exact: true },
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

/** Whether a GET of this URL is a generation-cached public API read. */
export function isPublicApiCacheRoute(url: URL): boolean {
  if (!hasBoundedPublicQuery(url)) return false;
  const pathname = url.pathname.replace(/\/$/, "") || "/";
  return PUBLIC_API_CACHE_ROUTES.some(
    (route) => routeMatches(pathname, route) && (!route.isEligible || route.isEligible(url)),
  );
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
