import {
  canonicalizeStorefrontHtmlCachePath,
  hasStorefrontProductVariantSelectionParams,
} from "@scalius/shared/storefront-cache-path";
import {
  CACHE_GENERATION_HEADER,
  PUBLIC_CACHE_MAX_AGE_SECONDS,
} from "@scalius/shared/cache-generation";
import {
  requestBypassesPublicStorefrontCache,
  toPublicCacheRequest,
} from "@/lib/cache-policy";
import { applyBrowserCachePolicyForPublicResponse } from "@/lib/public-discovery-cache";

// Anonymous public pages are cached per data center in the Cache API under
// a key made of the build, the Worker version, the store's cache generation,
// and the canonical URL. A buyer-visible write replaces the generation, a
// deploy (or a `wrangler dev`/`astro dev` start) replaces the Worker version,
// and old entries age out; nothing is ever purged. The version covers what
// BUILD_ID's source hash cannot: every bundled package and toolchain input.

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
  "track-order",
  "robots.txt",
  "search",
  "sitemap.xml",
  "sitemap.xsl",
  "theme-preview",
  "ucp",
]);

export interface PublicStorefrontCachePolicy {
  canonicalUrl: string;
}

const PUBLIC_PRECONNECT_REL = "rel=preconnect";

function normalizeHttpsOrigin(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;

  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !url.hostname
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Expose one deployment-stable Early Hints candidate for public HTML. A
 * preconnect transfers no merchant asset bytes, so Cloudflare's separate,
 * URI-only 103 cache cannot serve stale price, inventory, or hero content.
 */
export function applyPublicStorefrontPreconnectHint(
  response: Response,
  configuredCdnUrl: string | null | undefined,
): void {
  const origin = normalizeHttpsOrigin(configuredCdnUrl);
  if (!origin) return;

  const candidate = `<${origin}>; ${PUBLIC_PRECONNECT_REL}; crossorigin`;
  const current = response.headers.get("Link");
  if (current?.includes(candidate)) return;
  response.headers.append("Link", candidate);
}

function isCmsPagePath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  return (
    segments.length === 1 &&
    !segments[0]!.includes(".") &&
    !RESERVED_TOP_LEVEL_PATHS.has(segments[0]!)
  );
}

/** Anonymous pages and discovery files; everything else is never cached. */
function isPublicCachePath(pathname: string): boolean {
  return (
    pathname === "/" ||
    /^\/(?:products|categories|collections)\/[^/]+\/?$/.test(pathname) ||
    /^\/search\/?$/.test(pathname) ||
    /^\/blog(?:\/[^/]+)?\/?$/.test(pathname) ||
    pathname === "/blog/feed.xml" ||
    pathname === "/llms.txt" ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml" ||
    pathname === "/sitemap.xsl" ||
    /^\/sitemap-.*\.xml$/.test(pathname) ||
    pathname === "/api/product-feed.xml" ||
    pathname === "/api/facebook-feed.xml" ||
    pathname === "/.well-known/ucp" ||
    // CMS pages can embed product shortcodes; the store-wide generation
    // already covers that dependency.
    isCmsPagePath(pathname)
  );
}

/**
 * HTML pages that start their layout read together with their own reads (one
 * API batch) and use no platform origin before that read resolves. Every
 * other route gets the layout, and so the origins, before it runs.
 */
export function isLayoutBatchedPagePath(pathname: string): boolean {
  return (
    pathname === "/" ||
    /^\/(?:products|categories|collections)\/[^/]+\/?$/.test(pathname) ||
    /^\/(?:search|cart|checkout)\/?$/.test(pathname) ||
    /^\/blog(?:\/[^/]+)?\/?$/.test(pathname) && !pathname.endsWith(".xml") ||
    isCmsPagePath(pathname)
  );
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
  if (requestBypassesPublicStorefrontCache(request.headers)) return null;

  const url = new URL(request.url);
  if (!hasBoundedPublicQuery(url)) return null;
  if (hasStorefrontProductVariantSelectionParams(url)) return null;
  if (!isPublicCachePath(url.pathname)) return null;
  const normalizedPathname = url.pathname.replace(/\/$/, "") || "/";
  const canonicalCachePath = canonicalizeStorefrontHtmlCachePath(
    `${normalizedPathname}${url.search}`,
  );
  if (!canonicalCachePath) return null;

  return { canonicalUrl: new URL(canonicalCachePath, url.origin).toString() };
}

/** Cache API key: build, Worker version and generation first, then the canonical URL. */
export function publicStorefrontCacheKey(
  canonicalUrl: string,
  buildId: string,
  workerVersion: string,
  generation: string,
): string {
  const url = new URL(canonicalUrl);
  return `${url.origin}/__cache/${encodeURIComponent(buildId)}/${encodeURIComponent(workerVersion)}/${generation}${url.pathname}${url.search}`;
}

/** Only the gateway sets the generation a render pins its API reads to. */
function withGenerationHeader(request: Request, generation: string | null): Request {
  if (!generation && !request.headers.has(CACHE_GENERATION_HEADER)) return request;
  const next = new Request(request);
  if (generation) next.headers.set(CACHE_GENERATION_HEADER, generation);
  else next.headers.delete(CACHE_GENERATION_HEADER);
  return next;
}

function isStorableResponse(response: Response): boolean {
  return (
    response.status === 200 &&
    response.headers.get("X-Cache-Status") === "MISS" &&
    !response.headers.has("Set-Cookie")
  );
}

function toStoredResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", `public, max-age=${PUBLIC_CACHE_MAX_AGE_SECONDS}`);
  headers.delete("Pragma");
  headers.delete("Expires");
  return new Response(response.body, { status: response.status, headers });
}

function fromStoredResponse(stored: Response, request: Request, pathname: string): Response {
  const response = new Response(request.method === "HEAD" ? null : stored.body, stored);
  applyBrowserCachePolicyForPublicResponse(response, pathname);
  response.headers.set("X-Cache-Status", "HIT");
  return response;
}

export interface PublicStorefrontCacheContext {
  /** `caches.default` in production. */
  cache: Pick<Cache, "match" | "put">;
  /** The store's cache generation, or `null` to serve uncached. */
  readGeneration(): Promise<string | null>;
  buildId: string;
  /**
   * This Worker's version (`readWorkerVersion`), or `null` to serve uncached:
   * an unversioned key could serve the previous deploy's HTML.
   */
  workerVersion: string | null;
  render(request: Request): Promise<Response>;
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Serves one storefront request. Private requests (checkout, cart, account,
 * a named session cookie, variant selections) always render. Public requests
 * render the canonical, cookie-less URL pinned to the page's generation, and
 * a successful anonymous render is stored for the next visitor.
 */
export async function servePublicStorefrontRequest(
  request: Request,
  context: PublicStorefrontCacheContext,
): Promise<Response> {
  const policy = getPublicStorefrontCachePolicy(request);
  const workerVersion = policy ? context.workerVersion : null;
  const generation = workerVersion ? await context.readGeneration() : null;
  if (!policy || !workerVersion || !generation) {
    return context.render(withGenerationHeader(request, null));
  }

  const key = publicStorefrontCacheKey(policy.canonicalUrl, context.buildId, workerVersion, generation);
  const pathname = new URL(policy.canonicalUrl).pathname;
  const stored = await context.cache.match(key);
  if (stored) return fromStoredResponse(stored, request, pathname);

  const response = await context.render(withGenerationHeader(
    toPublicCacheRequest(request, policy.canonicalUrl),
    generation,
  ));
  if (request.method === "GET" && isStorableResponse(response)) {
    context.waitUntil(context.cache.put(key, toStoredResponse(response.clone())));
  }
  return response;
}
