import {
  canonicalizeStorefrontHtmlCachePath,
  hasStorefrontProductVariantSelectionParams,
} from "@scalius/shared/storefront-cache-path";
import { BUILD_ID } from "@/config/build-id";
// Freshness is mutation-driven through semantic cache-tag purges. This long
// TTL keeps hot public HTML resident at the edge; it is only a final fallback
// if every explicit purge attempt fails.
const STOREFRONT_EDGE_TTL_SECONDS = 86_400;
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
  cacheKey: string;
  edgeTtlSeconds: number;
  tags: readonly string[];
}

function hasPrivateRequestSignals(request: Request): boolean {
  return (
    Boolean(request.headers.get("Authorization")) ||
    Boolean(request.headers.get("Cookie")) ||
    Boolean(request.headers.get("X-API-Token"))
  );
}

function isCmsPagePath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  return (
    segments.length === 1 &&
    !segments[0]!.includes(".") &&
    !RESERVED_TOP_LEVEL_PATHS.has(segments[0]!)
  );
}

function resolvePublicPathTags(pathname: string): readonly string[] | null {
  if (pathname === "/") return ["homepage", "layout", "media", "products"];
  if (/^\/products\/[^/]+\/?$/.test(pathname)) {
    return ["products", "product-schema", "layout", "media"];
  }
  if (/^\/categories\/[^/]+\/?$/.test(pathname)) {
    return ["categories", "products", "layout", "media"];
  }
  if (/^\/collections\/[^/]+\/?$/.test(pathname)) {
    return ["collections", "products", "layout", "media"];
  }
  if (/^\/search\/?$/.test(pathname)) {
    return ["search", "products", "layout", "media"];
  }
  if (/^\/blog(?:\/[^/]+)?\/?$/.test(pathname)) {
    return ["pages", "products", "layout", "media"];
  }
  if (pathname === "/blog/feed.xml") {
    return ["pages", "products", "discovery"];
  }
  if (
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml" ||
    pathname === "/sitemap.xsl" ||
    /^\/sitemap-.*\.xml$/.test(pathname)
  ) {
    return [
      "discovery",
      "products",
      "categories",
      "collections",
      "pages",
      "layout",
    ];
  }
  if (
    pathname === "/api/product-feed.xml" ||
    pathname === "/api/facebook-feed.xml"
  ) {
    return ["discovery", "products", "layout", "media"];
  }
  if (pathname === "/.well-known/ucp") {
    return ["discovery", "products", "layout"];
  }
  // CMS content can embed product shortcodes, so a low-frequency merchant
  // product edit purges this bounded lane without per-page dependency scans.
  if (isCmsPagePath(pathname)) {
    return ["pages", "products", "layout", "media"];
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
  buildId = BUILD_ID,
): PublicStorefrontCachePolicy | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (hasPrivateRequestSignals(request)) return null;

  const url = new URL(request.url);
  if (!hasBoundedPublicQuery(url)) return null;
  if (hasStorefrontProductVariantSelectionParams(url)) return null;
  const tags = resolvePublicPathTags(url.pathname);
  if (!tags) return null;
  const normalizedPathname = url.pathname.replace(/\/$/, "") || "/";
  const canonicalCacheKey = canonicalizeStorefrontHtmlCachePath(
    `${normalizedPathname}${url.search}`,
  );
  if (!canonicalCacheKey) return null;

  // Native Worker caches survive code rollouts. A build-scoped internal key
  // makes the first request after deployment render the new code immediately;
  // semantic tags continue to own freshness within that build.
  const cacheKey = `${canonicalCacheKey}${canonicalCacheKey.includes("?") ? "&" : "?"}__scalius_build=${encodeURIComponent(buildId)}`;

  return {
    cacheKey,
    edgeTtlSeconds: STOREFRONT_EDGE_TTL_SECONDS,
    tags,
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
