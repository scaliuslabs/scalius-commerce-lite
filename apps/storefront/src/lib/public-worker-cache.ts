import {
  canonicalizeStorefrontHtmlCachePath,
  hasStorefrontProductVariantSelectionParams,
} from "@scalius/shared/storefront-cache-path";
import { CACHE_TTL } from "@/lib/edge-cache";
import { requestBypassesPublicStorefrontCache } from "@/lib/cache-policy";
const MAX_PUBLIC_QUERY_ENTRIES = 30;
const MAX_PUBLIC_QUERY_KEY_LENGTH = 64;
const MAX_PUBLIC_QUERY_VALUE_LENGTH = 512;

const RESERVED_TOP_LEVEL_PATHS = new Set([
  "account",
  "api",
  "blog",
  "buy",
  "cart",
  "categories",
  "checkout",
  "collections",
  "health",
  "order-success",
  "payment-recovery",
  "products",
  "robots.txt",
  "search",
  "sitemap.xml",
  "sitemap.xsl",
  "theme-preview",
  "ucp",
]);

const PUBLIC_STOREFRONT_CACHE_TAGS = new Set([
  "categories",
  "collections",
  "discovery",
  "homepage",
  "layout",
  "media",
  "pages",
  "product-schema",
  "products",
  "search",
]);

export interface PublicStorefrontCachePolicy {
  canonicalUrl: string;
  edgeTtlSeconds: number;
  tags: readonly string[];
}

interface PublicStorefrontRoutePolicy {
  edgeTtlSeconds: number;
  tags: readonly string[];
}

function hasPrivateRequestSignals(request: Request): boolean {
  return requestBypassesPublicStorefrontCache(request.headers);
}

function isCmsPagePath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  return (
    segments.length === 1 &&
    !segments[0]!.includes(".") &&
    !RESERVED_TOP_LEVEL_PATHS.has(segments[0]!)
  );
}

function availabilityPolicy(tags: readonly string[]): PublicStorefrontRoutePolicy {
  return { edgeTtlSeconds: CACHE_TTL.AVAILABILITY, tags };
}

function contentPolicy(tags: readonly string[]): PublicStorefrontRoutePolicy {
  return { edgeTtlSeconds: CACHE_TTL.LONG, tags };
}

function resolvePublicPathPolicy(
  pathname: string,
): PublicStorefrontRoutePolicy | null {
  if (pathname === "/") {
    return availabilityPolicy(["homepage", "layout", "media", "products"]);
  }
  if (/^\/products\/[^/]+\/?$/.test(pathname)) {
    return availabilityPolicy(["products", "product-schema", "layout", "media"]);
  }
  if (/^\/categories\/[^/]+\/?$/.test(pathname)) {
    return availabilityPolicy(["categories", "products", "layout", "media"]);
  }
  if (/^\/collections\/[^/]+\/?$/.test(pathname)) {
    return availabilityPolicy(["collections", "products", "layout", "media"]);
  }
  if (/^\/search\/?$/.test(pathname)) {
    return availabilityPolicy(["search", "products", "layout", "media"]);
  }
  if (pathname === "/blog/feed.xml") {
    return contentPolicy(["pages", "products", "discovery"]);
  }
  if (/^\/blog(?:\/[^/]+)?\/?$/.test(pathname)) {
    return availabilityPolicy(["pages", "products", "layout", "media"]);
  }
  if (pathname === "/llms.txt") {
    return contentPolicy(["discovery"]);
  }
  if (
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml" ||
    pathname === "/sitemap.xsl" ||
    /^\/sitemap-.*\.xml$/.test(pathname)
  ) {
    return contentPolicy([
      "discovery",
      "products",
      "categories",
      "collections",
      "pages",
      "layout",
    ]);
  }
  if (
    pathname === "/api/product-feed.xml" ||
    pathname === "/api/facebook-feed.xml"
  ) {
    return availabilityPolicy(["discovery", "products", "layout", "media"]);
  }
  if (pathname === "/.well-known/ucp") {
    return contentPolicy(["discovery", "products", "layout"]);
  }
  // CMS content can embed product shortcodes, so a low-frequency merchant
  // product edit purges this bounded lane without per-page dependency scans.
  if (isCmsPagePath(pathname)) {
    return availabilityPolicy(["pages", "products", "layout", "media"]);
  }
  return null;
}

function hasBoundedPublicQuery(url: URL): boolean {
  const entries = [...url.searchParams.entries()];
  return (
    entries.length <= MAX_PUBLIC_QUERY_ENTRIES &&
    entries.every(
      ([key, value]) =>
        key.length <= MAX_PUBLIC_QUERY_KEY_LENGTH &&
        value.length <= MAX_PUBLIC_QUERY_VALUE_LENGTH,
    )
  );
}

export function getPublicStorefrontCachePolicy(
  request: Request,
): PublicStorefrontCachePolicy | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (hasPrivateRequestSignals(request)) return null;

  const url = new URL(request.url);
  if (!hasBoundedPublicQuery(url)) return null;
  if (hasStorefrontProductVariantSelectionParams(url)) return null;
  const routePolicy = resolvePublicPathPolicy(url.pathname);
  if (!routePolicy) return null;
  const normalizedPathname = url.pathname.replace(/\/$/, "") || "/";
  const requestCachePath = `${normalizedPathname}${url.search}`;
  const canonicalCachePath = canonicalizeStorefrontHtmlCachePath(requestCachePath);
  if (!canonicalCachePath) return null;

  return {
    // Pass a canonical same-host Request to the cache-enabled entrypoint.
    // Wrangler isolates the native cache by Worker version.
    canonicalUrl: new URL(canonicalCachePath, url.origin).toString(),
    edgeTtlSeconds: routePolicy.edgeTtlSeconds,
    tags: routePolicy.tags,
  };
}

export function normalizePublicStorefrontCacheTags(
  tags: readonly string[],
): string[] {
  return [
    ...new Set(
      tags.filter((tag) => PUBLIC_STOREFRONT_CACHE_TAGS.has(tag)),
    ),
  ];
}

export function responseHasStorefrontBuild(
  response: Response,
  expectedBuildId: string,
): boolean {
  return response.headers.get("X-Storefront-Build") === expectedBuildId;
}

export async function recoverCurrentStorefrontBuild({
  response,
  expectedBuildId,
  purge,
  refetch,
  renderDirect,
}: {
  response: Response;
  expectedBuildId: string;
  purge: () => Promise<void>;
  refetch: () => Promise<Response>;
  renderDirect: () => Promise<Response>;
}): Promise<Response> {
  if (responseHasStorefrontBuild(response, expectedBuildId)) return response;

  await purge();
  const retried = await refetch();
  return responseHasStorefrontBuild(retried, expectedBuildId)
    ? retried
    : renderDirect();
}

export function decoratePublicStorefrontResponse(
  response: Response,
  policy: PublicStorefrontCachePolicy,
): Response {
  const cacheStatus = response.headers.get("X-Cache-Status") ?? "";
  const passedPublicResponseGate = /^(?:HIT|MISS|NATIVE)(?:;|$)/.test(cacheStatus);
  const isNoStore = response.headers.get("Cache-Control")?.includes("no-store");
  if (!response.ok || (isNoStore && !passedPublicResponseGate)) {
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

/**
 * The cache-enabled entrypoint consumes the edge TTL and tags before returning
 * to the public gateway. Keep those implementation directives internal so no
 * downstream cache can reinterpret them; the public response still exposes
 * X-Cache-Status and Cloudflare's native HIT/MISS evidence.
 */
export function exposePublicStorefrontResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("Cloudflare-CDN-Cache-Control");
  headers.delete("Cache-Tag");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
