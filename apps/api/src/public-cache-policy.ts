import { CACHE_TTLS } from "./utils/cache-ttls";

export interface PublicApiCachePolicy {
  edgeTtlSeconds: number;
  tags: readonly string[];
}

interface PublicApiRoutePolicy extends PublicApiCachePolicy {
  path: string;
  exact?: boolean;
}

const PUBLIC_API_ROUTE_POLICIES: readonly PublicApiRoutePolicy[] = [
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
    path: "/api/v1/products",
    edgeTtlSeconds: CACHE_TTLS.STANDARD,
    tags: ["products", "search", "product-schema"],
  },
  {
    path: "/api/v1/categories",
    edgeTtlSeconds: CACHE_TTLS.STANDARD,
    tags: ["categories"],
  },
  {
    path: "/api/v1/collections",
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
    path: "/api/v1/storefront/homepage",
    exact: true,
    edgeTtlSeconds: CACHE_TTLS.STANDARD,
    tags: [
      "homepage",
      "layout",
      "products",
      "categories",
      "collections",
    ],
  },
  {
    path: "/api/v1/storefront/page",
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

export function getPublicApiCachePolicy(
  request: Request,
): PublicApiCachePolicy | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (hasPrivateRequestSignals(request)) return null;

  const pathname = new URL(request.url).pathname.replace(/\/$/, "") || "/";
  const policy = PUBLIC_API_ROUTE_POLICIES.find((candidate) =>
    routeMatches(pathname, candidate),
  );
  if (!policy) return null;

  return {
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
