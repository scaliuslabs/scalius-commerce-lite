import { PUBLIC_CACHE_MAX_AGE_SECONDS } from "@scalius/shared/cache-generation";

/**
 * Anonymous public API reads served through the `PublicApi` Workers Cache
 * entrypoint. The cache key is the canonical path + sorted query plus the
 * store's cache generation, so a buyer-visible write makes every entry stale
 * without a purge.
 */
export interface PublicApiCachePolicy {
  canonicalUrl: string;
}

interface PublicApiRoutePolicy {
  path: string;
  exact?: boolean;
  isEligible?: (url: URL) => boolean;
}

/** Internal query parameter carrying the cache generation into the key. */
export const CACHE_GENERATION_QUERY_PARAM = "__cg";

const MAX_PUBLIC_CACHE_QUERY_ENTRIES = 30;
const MAX_PUBLIC_CACHE_QUERY_KEY_LENGTH = 64;
const MAX_PUBLIC_CACHE_QUERY_VALUE_LENGTH = 512;

function hasBoundedPublicQuery(url: URL): boolean {
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

const PUBLIC_API_ROUTE_POLICIES: readonly PublicApiRoutePolicy[] = [
  { path: "/api/v1/products" },
  { path: "/api/v1/categories" },
  { path: "/api/v1/collections" },
  { path: "/api/v1/storefront/homepage", exact: true },
  { path: "/api/v1/checkout/config", exact: true },
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
] as const;

function routeMatches(pathname: string, policy: PublicApiRoutePolicy): boolean {
  if (policy.exact) return pathname === policy.path;
  return pathname === policy.path || pathname.startsWith(`${policy.path}/`);
}

function hasPrivateRequestSignals(request: Request): boolean {
  return (
    request.headers.has("Authorization") ||
    request.headers.has("Cookie") ||
    request.headers.has("X-API-Token")
  );
}

function buildPublicApiCacheKey(url: URL): string {
  const pathname = url.pathname.replace(/\/$/, "") || "/";
  const entries = [...url.searchParams.entries()].sort(
    ([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
  );
  const params = new URLSearchParams();
  for (const [key, value] of entries) params.append(key, value);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function getPublicApiCachePolicy(
  request: Request,
): PublicApiCachePolicy | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (hasPrivateRequestSignals(request)) return null;

  const url = new URL(request.url);
  if (url.searchParams.has(CACHE_GENERATION_QUERY_PARAM)) return null;
  if (!hasBoundedPublicQuery(url)) return null;
  const pathname = url.pathname.replace(/\/$/, "") || "/";
  const policy = PUBLIC_API_ROUTE_POLICIES.find(
    (candidate) =>
      routeMatches(pathname, candidate) &&
      (!candidate.isEligible || candidate.isEligible(url)),
  );
  if (!policy) return null;

  return {
    canonicalUrl: new URL(buildPublicApiCacheKey(url), url.origin).toString(),
  };
}

/** The canonical URL with the generation appended; it becomes the cache key. */
export function withCacheGeneration(canonicalUrl: string, generation: string): string {
  const url = new URL(canonicalUrl);
  url.searchParams.append(CACHE_GENERATION_QUERY_PARAM, generation);
  return url.toString();
}

/** Removes the generation before the request reaches the application. */
export function withoutCacheGeneration(request: Request): Request {
  const url = new URL(request.url);
  if (!url.searchParams.has(CACHE_GENERATION_QUERY_PARAM)) return request;
  url.searchParams.delete(CACHE_GENERATION_QUERY_PARAM);
  return new Request(url.toString(), request);
}

export function decoratePublicApiResponse(response: Response): Response {
  if (!response.ok || response.headers.get("Cache-Control")?.includes("no-store")) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "public, max-age=0, no-cache, must-revalidate");
  headers.set(
    "Cloudflare-CDN-Cache-Control",
    `public, max-age=${PUBLIC_CACHE_MAX_AGE_SECONDS}`,
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
