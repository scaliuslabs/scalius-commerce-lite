import {
  canonicalizeStorefrontHtmlCachePath,
  hasStorefrontProductVariantSelectionParams,
} from "@scalius/shared/storefront-cache-path";

const STOREFRONT_EDGE_TTL_SECONDS = 5;
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
  "homepage",
  "layout",
  "pages",
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
  if (pathname === "/") return ["homepage", "layout", "products"];
  if (/^\/products\/[^/]+\/?$/.test(pathname)) {
    return ["products", "layout"];
  }
  if (/^\/categories\/[^/]+\/?$/.test(pathname)) {
    return ["categories", "products", "layout"];
  }
  if (/^\/collections\/[^/]+\/?$/.test(pathname)) {
    return ["collections", "products", "layout"];
  }
  if (/^\/search\/?$/.test(pathname)) return ["search", "products", "layout"];
  if (isCmsPagePath(pathname)) return ["pages", "layout"];
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
  const tags = resolvePublicPathTags(url.pathname);
  if (!tags) return null;
  const normalizedPathname = url.pathname.replace(/\/$/, "") || "/";
  const cacheKey = canonicalizeStorefrontHtmlCachePath(
    `${normalizedPathname}${url.search}`,
  );
  if (!cacheKey) return null;

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
  const legacyCacheStatus = response.headers.get("X-Cache-Status") ?? "";
  const passedPublicResponseGate = /^(HIT|MISS)(?:;|$)/.test(
    legacyCacheStatus,
  );
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
