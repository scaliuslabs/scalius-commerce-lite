const CMS_EDGE_TTL_SECONDS = 60 * 60;

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

const PUBLIC_STOREFRONT_CACHE_TAGS = new Set(["layout", "pages"]);

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

function buildCacheKey(url: URL): string {
  const pathname = url.pathname.replace(/\/$/, "") || "/";
  const params = new URLSearchParams(
    [...url.searchParams.entries()].sort(
      ([leftKey, leftValue], [rightKey, rightValue]) =>
        leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
    ),
  );
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function getPublicStorefrontCachePolicy(
  request: Request,
): PublicStorefrontCachePolicy | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (hasPrivateRequestSignals(request)) return null;

  const url = new URL(request.url);
  if (!isCmsPagePath(url.pathname)) return null;

  return {
    cacheKey: buildCacheKey(url),
    edgeTtlSeconds: CMS_EDGE_TTL_SECONDS,
    tags: ["pages", "layout"],
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
