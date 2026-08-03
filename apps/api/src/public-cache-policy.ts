import { CACHE_TTLS } from "./utils/cache-ttls";

export interface PublicApiCachePolicy {
  cacheKey: string;
  edgeTtlSeconds: number;
  tags: readonly string[];
}

interface PublicApiRoutePolicy extends Omit<PublicApiCachePolicy, "cacheKey"> {
  path: string;
  exact?: boolean;
  isEligible?: (url: URL) => boolean;
}

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
  // Availability-bearing product, collection-detail, category-product, and
  // homepage projections stay off this lane until availability invalidation
  // is coalesced. Per-order global tag purges would erase the cache benefit.
  {
    path: "/api/v1/checkout/config",
    exact: true,
    edgeTtlSeconds: CACHE_TTLS.CHECKOUT_CONFIG,
    tags: ["checkout"],
  },
  {
    path: "/api/v1/shipping-methods",
    edgeTtlSeconds: CACHE_TTLS.SHORT,
    tags: ["checkout"],
  },
  {
    path: "/api/v1/locations",
    edgeTtlSeconds: CACHE_TTLS.MEDIUM,
    tags: ["checkout"],
  },
  {
    path: "/api/v1/attributes",
    edgeTtlSeconds: CACHE_TTLS.ATTRIBUTES,
    tags: ["attributes", "search"],
  },
  {
    path: "/api/v1/categories",
    edgeTtlSeconds: CACHE_TTLS.STANDARD,
    tags: ["categories"],
    isEligible: (url) =>
      !url.pathname.replace(/\/$/, "").endsWith("/products"),
  },
  {
    path: "/api/v1/collections",
    exact: true,
    edgeTtlSeconds: CACHE_TTLS.STANDARD,
    tags: ["collections"],
  },
  {
    path: "/api/v1/pages",
    edgeTtlSeconds: CACHE_TTLS.STANDARD,
    tags: ["pages"],
  },
  {
    path: "/api/v1/articles",
    edgeTtlSeconds: CACHE_TTLS.STANDARD,
    tags: ["pages"],
  },
  {
    path: "/api/v1/hero",
    edgeTtlSeconds: CACHE_TTLS.STANDARD,
    tags: ["homepage"],
    isEligible: isHeroRequestEligible,
  },
  {
    path: "/api/v1/seo",
    edgeTtlSeconds: CACHE_TTLS.STANDARD,
    tags: ["homepage", "layout", "discovery"],
  },
  {
    path: "/api/v1/header",
    edgeTtlSeconds: CACHE_TTLS.STANDARD,
    tags: ["layout"],
  },
  {
    path: "/api/v1/navigation",
    edgeTtlSeconds: CACHE_TTLS.STANDARD,
    tags: ["layout", "categories"],
  },
  {
    path: "/api/v1/footer",
    edgeTtlSeconds: CACHE_TTLS.STANDARD,
    tags: ["layout"],
  },
  {
    path: "/api/v1/storefront/pages/slug",
    edgeTtlSeconds: CACHE_TTLS.STANDARD,
    tags: ["pages", "layout"],
  },
  {
    path: "/api/v1/storefront/layout",
    exact: true,
    edgeTtlSeconds: CACHE_TTLS.STANDARD,
    tags: ["layout", "media"],
  },
  {
    path: "/api/v1/storefront/csp",
    exact: true,
    edgeTtlSeconds: CACHE_TTLS.STANDARD,
    tags: ["layout"],
  },
] as const;

const PUBLIC_API_CACHE_TAGS = new Set(
  PUBLIC_API_ROUTE_POLICIES.flatMap((policy) => policy.tags),
);

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

export function normalizePublicApiCacheTags(tags: readonly string[]): string[] {
  return [
    ...new Set(tags.filter((tag) => PUBLIC_API_CACHE_TAGS.has(tag))),
  ];
}

export function getPublicApiCachePolicy(
  request: Request,
): PublicApiCachePolicy | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (hasPrivateRequestSignals(request)) return null;

  const url = new URL(request.url);
  if (!hasBoundedPublicQuery(url)) return null;
  const pathname = url.pathname.replace(/\/$/, "") || "/";
  const policy = PUBLIC_API_ROUTE_POLICIES.find((candidate) =>
    routeMatches(pathname, candidate),
  );
  if (!policy || (policy.isEligible && !policy.isEligible(url))) return null;

  return {
    cacheKey: buildPublicApiCacheKey(url),
    edgeTtlSeconds: policy.edgeTtlSeconds,
    tags: policy.tags,
  };
}

export function decoratePublicApiResponse(
  response: Response,
  policy: PublicApiCachePolicy,
): Response {
  if (!response.ok || response.headers.get("Cache-Control")?.includes("no-store")) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set(
    "Cloudflare-CDN-Cache-Control",
    `public, max-age=${policy.edgeTtlSeconds}, must-revalidate`,
  );
  headers.set("Cache-Tag", policy.tags.join(","));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
