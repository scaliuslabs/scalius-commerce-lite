import {
  canonicalizeStorefrontHtmlCachePath,
  isStorefrontCacheIgnoredParam,
  readStorefrontSeenSeq,
} from "@scalius/shared/storefront-cache-path";
import {
  DEPENDENCY_CACHE_RETENTION_SECONDS,
  decideCacheFrontierHit,
  isCacheDepHash,
  type CacheFrontier,
  type CacheFrontierEntry,
} from "@scalius/shared/cache-frontier";
import {
  CACHE_GENERATION_HEADER,
  PUBLIC_CACHE_MAX_AGE_SECONDS,
} from "@scalius/shared/cache-generation";
import {
  isBuyerShellPathname,
  requestBypassesPublicStorefrontCache,
  toPublicCacheRequest,
} from "@/lib/cache-policy";
import { STOREFRONT_ROUTE_SEGMENTS } from "@scalius/shared/storefront-route-segments";
import { applyBrowserCachePolicyForPublicResponse } from "@/lib/public-discovery-cache";
import {
  CACHE_FRONTIER_DELTA_MS,
  cacheFrontierKey,
  isCacheFrontierFresh,
  readStoredCacheFrontier,
  refreshCacheFrontier,
  singleFlight,
  storeCacheFrontier,
  type CacheFrontierClient,
} from "@/lib/cache-frontier";
import {
  collectPageDependencies,
  createPageDependencies,
  notFoundReadsAdmitted,
  pageEntryFromDependencies,
} from "@/lib/page-dependencies";
import { presenceOfPath } from "@scalius/shared/markets";
import { logicalUrl, withPresencePrefix } from "@/lib/market-presence";

// Anonymous public pages carry dependency proofs and are validated against a
// frontier at most one second old. Worker versions separate deployed code;
// unchanged content has no routine age expiry. Cloudflare may evict storage.
// Generation mode exists only for explicit differential/load comparisons.
export type StorefrontPageCacheMode = "generation" | "frontier";
export const STOREFRONT_PAGE_CACHE_MODE: StorefrontPageCacheMode = "frontier";

/** Internal headers of a stored dependency-validated entry; never sent to a browser. */
export const PAGE_DEPENDENCY_HEADERS = {
  apiVersion: "X-Scalius-Api-Version",
  deps: "X-Scalius-Deps",
  s0: "X-Scalius-Dep-Seq",
  validUntil: "X-Scalius-Valid-Until",
  softMaxAge: "X-Scalius-Soft-Max-Age",
  renderedAt: "X-Scalius-Rendered-At",
} as const;

const MAX_PUBLIC_QUERY_ENTRIES = 30;
const MAX_PUBLIC_QUERY_KEY_LENGTH = 64;
const MAX_PUBLIC_QUERY_VALUE_LENGTH = 512;

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
 * The media CDN preconnect among a public page's Early Hints (stored pages add
 * their build files, `pageEarlyHintLinks`). A preconnect transfers no merchant
 * asset bytes, so Cloudflare's separate, URI-only 103 cache cannot serve
 * stale price, inventory, or hero content.
 */
export function applyPublicStorefrontPreconnectHint(
  response: Response,
  configuredCdnUrl: string | null | undefined,
): void {
  const origin = normalizeHttpsOrigin(configuredCdnUrl);
  if (!origin) return;

  // No `crossorigin`: images load without CORS, and a CORS preconnect warms a connection they never use.
  const candidate = `<${origin}>; ${PUBLIC_PRECONNECT_REL}`;
  const current = response.headers.get("Link");
  if (current?.includes(candidate)) return;
  response.headers.append("Link", candidate);
}

/** Build files a stored page may name in Early Hints: its stylesheets and preloaded fonts. */
const EARLY_HINT_ASSET = /^\/_astro\/[A-Za-z0-9._~/-]+\.(?:css|woff2)$/;
const EARLY_HINT_MEDIA = /^\((?:min|max)-width: ?\d{1,4}px\)$/;
const MAX_EARLY_HINTS = 6;
/** The head is at the start of the page: only this much of a stored body is read for it. */
const EARLY_HINT_HEAD_BYTES = 64 * 1024;

function linkAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.slice(5).matchAll(/([A-Za-z-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    attributes.set(match[1]!.toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

/**
 * The `Link` preloads of a page's own build files, read from its head: every
 * stylesheet, and every font it preloads (with the preload's width query).
 * Cloudflare answers the next request for the URL with them as 103 Early
 * Hints before the Worker runs, so the browser fetches the render-blocking
 * CSS and the heading font while a hit waits for its frontier. Only
 * build-scoped `/_astro/` files qualify: immutable, never merchant content,
 * so a hint remembered from an older response costs at most a wasted fetch.
 */
export function pageEarlyHintLinks(html: string): string[] {
  const headEnd = html.indexOf("</head>");
  const head = headEnd >= 0 ? html.slice(0, headEnd) : html;
  const links = new Set<string>();
  for (const [tag] of head.matchAll(/<link\b[^>]*>/gi)) {
    if (links.size >= MAX_EARLY_HINTS) break;
    const attributes = linkAttributes(tag);
    const href = attributes.get("href") ?? "";
    if (!EARLY_HINT_ASSET.test(href)) continue;
    const rel = attributes.get("rel")?.toLowerCase();
    if (rel === "stylesheet" && href.endsWith(".css")) {
      links.add(`<${href}>; rel=preload; as=style`);
    } else if (rel === "preload" && attributes.get("as") === "font" && href.endsWith(".woff2")) {
      const media = attributes.get("media");
      links.add(`<${href}>; rel=preload; as=font; type="font/woff2"; crossorigin${media && EARLY_HINT_MEDIA.test(media) ? `; media="${media}"` : ""}`);
    }
  }
  return [...links];
}

function isCmsPagePath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  return (
    segments.length === 1 &&
    !segments[0]!.includes(".") &&
    // A static route wins over the CMS page of the same slug.
    !STOREFRONT_ROUTE_SEGMENTS.has(segments[0]!)
  );
}

/**
 * The anonymous HTML pages: each is stored by the shared cache and starts its
 * layout read together with its own reads (one API batch), using no platform
 * origin before that read resolves.
 */
function isPublicHtmlPagePath(pathname: string): boolean {
  return (
    pathname === "/" ||
    /^\/(?:products|categories|brands|collections)\/[^/]+\/?$/.test(pathname) ||
    // A product's review pages (noindex, but a public page like any other).
    /^\/products\/[^/]+\/reviews\/?$/.test(pathname) ||
    /^\/pages\/[a-z0-9]+(?:-[a-z0-9]+)*\/?$/.test(pathname) ||
    // The category and collection indexes and the header's whole menu panels (a partial).
    /^\/(?:categories|collections|navigation\/panels)\/?$/.test(pathname) ||
    /^\/(?:search|compare)\/?$/.test(pathname) ||
    (pathname !== "/blog/feed.xml" && /^\/blog(?:\/[^/]+)?\/?$/.test(pathname)) ||
    // CMS shortcode reads contribute their product dependencies to the page proof.
    isCmsPagePath(pathname)
  );
}

/**
 * Anonymous pages, discovery files and the buyer shells (`isBuyerShellPathname`);
 * everything else is never cached.
 */
function isPublicCachePath(pathname: string): boolean {
  return (
    isPublicHtmlPagePath(pathname) ||
    isBuyerShellPathname(pathname) ||
    pathname === "/blog/feed.xml" ||
    pathname === "/llms.txt" ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml" ||
    /^\/sitemap-.*\.xml$/.test(pathname) ||
    pathname === "/api/product-feed.xml" ||
    pathname === "/api/facebook-feed.xml" ||
    pathname === "/.well-known/ucp"
  );
}

/**
 * HTML pages that start their layout read together with their own reads (one
 * API batch) and use no platform origin before that read resolves. Every
 * other route gets the layout, and so the origins, before it runs.
 */
export function isLayoutBatchedPagePath(pathname: string): boolean {
  return isPublicHtmlPagePath(pathname) || isBuyerShellPathname(pathname);
}

/**
 * The query that can shape a page stays small. Ad-click and campaign
 * parameters, and any parameter a discovery file does not read, never reach
 * the key or the render, so a long `fbclid`, a stack of `utm_*` tags or a
 * pile of unknown parameters on a feed cannot push a request off the cache.
 */
function hasBoundedPublicQuery(url: URL): boolean {
  const pathname = url.pathname.replace(/\/$/, "") || "/";
  const entries = [...url.searchParams.entries()].filter(
    ([key]) => !isStorefrontCacheIgnoredParam(pathname, key),
  );
  return (
    entries.length <= MAX_PUBLIC_QUERY_ENTRIES &&
    entries.every(
      ([key, value]) =>
        key.length <= MAX_PUBLIC_QUERY_KEY_LENGTH &&
        value.length <= MAX_PUBLIC_QUERY_VALUE_LENGTH,
    )
  );
}

/**
 * Whether a request may use the shared page cache, and its canonical URL.
 * Credentials play no part: the public render receives none
 * (`toPublicCacheRequest`), and the one that changes a page, a theme preview,
 * is decided by the gateway from its signature (`publicPolicyForRequest`).
 * A subfolder presence (`/en-in/...`) is classified by the page it renders
 * and keeps its prefix in the canonical URL, so every presence has its own
 * entries and a root URL's key is exactly what it was before presences.
 */
export function getPublicStorefrontCachePolicy(
  request: Request,
): PublicStorefrontCachePolicy | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;

  const url = new URL(request.url);
  const presence = presenceOfPath(url.pathname);
  const logical = logicalUrl(url);
  if (!hasBoundedPublicQuery(logical)) return null;
  if (!isPublicCachePath(logical.pathname)) return null;
  const normalizedPathname = logical.pathname.replace(/\/$/, "") || "/";
  // A buyer shell reads no query parameter on the server, so every /cart (or
  // /checkout) URL shares one entry and a query can neither split nor poison it.
  const canonicalCachePath = isBuyerShellPathname(normalizedPathname)
    ? normalizedPathname
    : canonicalizeStorefrontHtmlCachePath(`${normalizedPathname}${logical.search}`);
  if (!canonicalCachePath) return null;

  return { canonicalUrl: new URL(withPresencePrefix(presence, canonicalCachePath), url.origin).toString() };
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

/** Cache API key of a dependency-validated entry: no generation, the entry carries its proof. */
export function publicStorefrontDvcCacheKey(
  canonicalUrl: string,
  buildId: string,
  workerVersion: string,
): string {
  const url = new URL(canonicalUrl);
  return `${url.origin}/__cache/${encodeURIComponent(buildId)}/${encodeURIComponent(workerVersion)}/dvc${url.pathname}${url.search}`;
}

/** Only the gateway sets the generation a render pins its API reads to. */
function withGenerationHeader(request: Request, generation: string | null): Request {
  if (!generation && !request.headers.has(CACHE_GENERATION_HEADER)) return request;
  const next = new Request(request);
  if (generation) next.headers.set(CACHE_GENERATION_HEADER, generation);
  else next.headers.delete(CACHE_GENERATION_HEADER);
  return next;
}

/**
 * A public page that says "not found": the 404 page of an anonymous request
 * for a public page address (a product, category, page handle no one has).
 * It is stored like a found page, dependency-validated by the keys its lookup
 * read, so creating that handle invalidates it, and in any case for at most
 * `NOT_FOUND_PAGE_MAX_AGE_SECONDS`. A failed read is a 503 or a degraded
 * render, never a stored 404.
 */
export function isPublicNotFoundPage(response: Response): boolean {
  return response.status === 404 && (response.headers.get("Content-Type")?.toLowerCase().includes("text/html") ?? false);
}

/** The longest a stored "not found" page is served, whatever its proof says. */
export const NOT_FOUND_PAGE_MAX_AGE_SECONDS = 30;

function isStorableResponse(response: Response, notFound: "store" | "skip" = "skip"): boolean {
  return (
    (response.status === 200 || (notFound === "store" && isPublicNotFoundPage(response))) &&
    response.headers.get("X-Cache-Status") === "MISS" &&
    !response.headers.has("Set-Cookie")
  );
}

/**
 * A "not found" entry is served until `NOT_FOUND_PAGE_MAX_AGE_SECONDS` after
 * this storefront's own render started, and kept in storage only a little
 * longer. The bound is from the render's start, never from its oldest read:
 * the layout read is often an hour-old hit, which would make the entry
 * expire before it is stored.
 */
function boundNotFoundEntry(entry: CacheFrontierEntry, renderStartedAt: number): CacheFrontierEntry {
  const expires = renderStartedAt + NOT_FOUND_PAGE_MAX_AGE_SECONDS * 1000;
  return { ...entry, validUntil: entry.validUntil === null ? expires : Math.min(entry.validUntil, expires) };
}

function toStoredResponse(
  response: Response,
  entry: CacheFrontierEntry | null = null,
  body: BodyInit | null = response.body,
  earlyHints: readonly string[] = [],
): Response {
  const headers = new Headers(response.headers);
  for (const link of earlyHints) {
    if (!headers.get("Link")?.includes(link)) headers.append("Link", link);
  }
  const retention = response.status === 404 ? NOT_FOUND_PAGE_MAX_AGE_SECONDS * 2 : entry ? DEPENDENCY_CACHE_RETENTION_SECONDS : PUBLIC_CACHE_MAX_AGE_SECONDS;
  headers.set("Cache-Control", `public, max-age=${retention}`);
  headers.delete("Pragma");
  headers.delete("Expires");
  for (const name of Object.values(PAGE_DEPENDENCY_HEADERS)) headers.delete(name);
  if (entry) {
    headers.set(PAGE_DEPENDENCY_HEADERS.apiVersion, entry.apiVersion);
    headers.set(PAGE_DEPENDENCY_HEADERS.deps, entry.depHashes.join(","));
    headers.set(PAGE_DEPENDENCY_HEADERS.s0, String(entry.s0));
    headers.set(PAGE_DEPENDENCY_HEADERS.renderedAt, String(entry.renderedAt));
    if (entry.validUntil !== null) headers.set(PAGE_DEPENDENCY_HEADERS.validUntil, String(entry.validUntil));
    if (entry.softMaxAgeSeconds !== null) headers.set(PAGE_DEPENDENCY_HEADERS.softMaxAge, String(entry.softMaxAgeSeconds));
  }
  return new Response(body, { status: response.status, headers });
}

/**
 * What a request waited for before its answer, beside its lane in
 * `X-Cache-Status`: `HIT; frontier-wait=183ms` when it blocked on a frontier
 * refresh (the round trip to the API), `slow-check=95ms` on the indexed
 * check. The lane stays the first token; a wait under 1 ms is not reported.
 */
interface CacheWaits {
  frontierMs: number | null;
  slowCheckMs: number | null;
}

const NO_WAITS: CacheWaits = { frontierMs: null, slowCheckMs: null };

export function cacheStatusWithWaits(lane: string, waits: CacheWaits): string {
  const token = (name: string, ms: number | null) => (ms !== null && ms >= 1 ? [`${name}=${Math.round(ms)}ms`] : []);
  return [lane, ...token("frontier-wait", waits.frontierMs), ...token("slow-check", waits.slowCheckMs)].join("; ");
}

/** The lane of an `X-Cache-Status` value (`HIT`, `MISS`, `BYPASS`...), without its waits. */
export function cacheStatusLane(value: string | null): string {
  return (value ?? "").split(";", 1)[0]!.trim();
}

function fromStoredResponse(stored: Response, request: Request, pathname: string, waits: CacheWaits = NO_WAITS, lane = "HIT"): Response {
  if (request.method === "HEAD") void stored.body?.cancel().catch(() => undefined);
  const response = new Response(request.method === "HEAD" ? null : stored.body, stored);
  for (const name of Object.values(PAGE_DEPENDENCY_HEADERS)) response.headers.delete(name);
  applyBrowserCachePolicyForPublicResponse(response, pathname);
  response.headers.set("X-Cache-Status", cacheStatusWithWaits(lane, waits));
  return response;
}

/**
 * A finished render other requests for the same page may take: exactly the
 * entry it stored (its bytes and stored headers, plain data), so a joiner
 * gets what a hit on that entry would give it and nothing of the leader's
 * own response (its waits, its stream, its request).
 */
interface SharedRender {
  status: number;
  headers: Array<[string, string]>;
  body: ArrayBuffer;
}

/**
 * Renders in flight in this isolate, by page cache key (CACHE-DESIGN §6.7):
 * simultaneous misses for one page render once. A request joins a render
 * only if it started at most Δ ago, so what it gets read the database no
 * earlier than a hit could have been validated (the freshness comes from
 * that start, not from the render's proof); one carrying `_sv` (a write its
 * visitor just made) never joins. A joiner gets the leader's bytes whenever
 * the response is one the cache could store by its headers (200, a MISS, no
 * cookie), proven or not. A failed, private, degraded or cookie-setting
 * render shares nothing, and says so as soon as its headers are known, so
 * its joiners render at once; one that degrades while its body streams
 * (`markRenderDegraded`) says so when the body ends. A joiner waits at most `RENDER_JOIN_WAIT_MS`
 * and then renders alone: joining never costs more than that bound. An entry
 * leaves the map when its render settles.
 */
const rendersInFlight = new Map<string, { startedAt: number; shared: Promise<SharedRender | null> }>();

/** The longest a request waits on another request's render of its page before rendering alone. */
export const RENDER_JOIN_WAIT_MS = 1_500;

/** The shared render, or null once it shares nothing or `waitMs` passes. */
async function awaitSharedRender(shared: Promise<SharedRender | null>, waitMs: number): Promise<SharedRender | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs); });
  try {
    return await Promise.race([shared.catch(() => null), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function joinableRender(key: string, now: number) {
  const flight = rendersInFlight.get(key);
  return flight && now >= flight.startedAt && now - flight.startedAt <= CACHE_FRONTIER_DELTA_MS ? flight : null;
}

function leadRender(key: string, startedAt: number, shared: Promise<SharedRender | null>): void {
  const flight = { startedAt, shared };
  rendersInFlight.set(key, flight);
  void shared.finally(() => {
    if (rendersInFlight.get(key) === flight) rendersInFlight.delete(key);
  }).catch(() => undefined);
}

/** Test hook: the number of renders this isolate is sharing now. */
export function rendersInFlightCount(): number {
  return rendersInFlight.size;
}

const isClockHeader = (value: string | null): value is string => value !== null && /^\d{1,15}$/.test(value);
const isSecondsHeader = (value: string | null): value is string => value !== null && /^\d{1,12}(?:\.\d+)?$/.test(value);

/** The proof a stored entry carries, or null when it carries none (never served in frontier mode). */
export function readStoredPageEntry(headers: Headers): CacheFrontierEntry | null {
  const apiVersion = headers.get(PAGE_DEPENDENCY_HEADERS.apiVersion);
  const s0 = headers.get(PAGE_DEPENDENCY_HEADERS.s0);
  const renderedAt = headers.get(PAGE_DEPENDENCY_HEADERS.renderedAt);
  const deps = headers.get(PAGE_DEPENDENCY_HEADERS.deps);
  const validUntil = headers.get(PAGE_DEPENDENCY_HEADERS.validUntil);
  const softMaxAge = headers.get(PAGE_DEPENDENCY_HEADERS.softMaxAge);
  if (!apiVersion || !isClockHeader(s0) || !isClockHeader(renderedAt) || deps === null) return null;
  if (validUntil !== null && !isClockHeader(validUntil)) return null;
  if (softMaxAge !== null && !isSecondsHeader(softMaxAge)) return null;
  const depHashes = deps === "" ? [] : deps.split(",");
  if (!depHashes.every(isCacheDepHash)) return null;
  return {
    apiVersion,
    s0: Number(s0),
    depHashes,
    validUntil: validUntil === null ? null : Number(validUntil),
    softMaxAgeSeconds: softMaxAge === null ? null : Number(softMaxAge),
    renderedAt: Number(renderedAt),
  };
}

export interface PublicStorefrontCacheContext {
  /** `caches.default` in production. */
  cache: Pick<Cache, "match" | "put">;
  /** Explicit generation comparator only; production never reads this hint. */
  readGeneration?(): Promise<string | null>;
  buildId: string;
  /**
   * This Worker's version (`readWorkerVersion`), or `null` to serve uncached:
   * an unversioned key could serve the previous deploy's HTML.
   */
  workerVersion: string | null;
  render(request: Request): Promise<Response>;
  waitUntil(promise: Promise<unknown>): void;
  /** Default `STOREFRONT_PAGE_CACHE_MODE`. */
  mode?: StorefrontPageCacheMode;
  /** The frontier API (frontier mode); without it pages render uncached. */
  frontier?: CacheFrontierClient | null;
  /** Default `RENDER_JOIN_WAIT_MS`. */
  renderJoinWaitMs?: number;
  /**
   * Whether the request's theme preview cookie carries this storefront's
   * signature (`verifyThemePreviewCookie`). Without it every preview cookie
   * is treated as forged.
   */
  verifyThemePreview?(cookieHeader: string | null): Promise<boolean>;
  now?(): number;
}

/**
 * The gateway's cache lane for a request. A theme preview cookie this
 * storefront signed renders the merchant's draft for that request alone,
 * never stored and never served from the shared cache. A forged, foreign or
 * unverifiable one, like any other credential, gets the shared anonymous page,
 * so a made-up cookie cannot force a render.
 */
async function publicPolicyForRequest(
  request: Request,
  context: PublicStorefrontCacheContext,
): Promise<PublicStorefrontCachePolicy | null> {
  const policy = getPublicStorefrontCachePolicy(request);
  if (!policy || !requestBypassesPublicStorefrontCache(request.headers)) return policy;
  const signed = await Promise.resolve(context.verifyThemePreview?.(request.headers.get("Cookie")) ?? false).catch(() => false);
  return signed ? null : policy;
}

/** Cache storage is disposable: a failed lookup has the same authority as a miss. */
async function readCachedPage(cache: PublicStorefrontCacheContext["cache"], key: string): Promise<Response | undefined> {
  try {
    return await cache.match(key);
  } catch {
    return undefined;
  }
}

/** A cache write cannot change the outcome of the render or validated hit. */
async function storeCachedPage(cache: PublicStorefrontCacheContext["cache"], key: string, response: Response): Promise<void> {
  try {
    await cache.put(key, response);
  } catch {
    // The next request can render again.
  }
}

/**
 * Serves one storefront request. Private requests (receipts, accounts, a
 * signed theme preview) always render. Public requests and the buyer shells render
 * the canonical, cookie-less URL (variant selections are made in the browser
 * and share the product's entry), and a successful anonymous render is stored
 * for the next visitor.
 */
export async function servePublicStorefrontRequest(
  request: Request,
  context: PublicStorefrontCacheContext,
): Promise<Response> {
  const policy = await publicPolicyForRequest(request, context);
  const workerVersion = policy ? context.workerVersion : null;
  if ((context.mode ?? STOREFRONT_PAGE_CACHE_MODE) === "frontier") {
    return policy && workerVersion && context.frontier
      ? serveFrontierValidated(request, policy, workerVersion, context, context.frontier)
      : context.render(withGenerationHeader(request, null));
  }
  const generation = workerVersion ? await context.readGeneration?.() ?? null : null;
  if (!policy || !workerVersion || !generation) {
    return context.render(withGenerationHeader(request, null));
  }

  const key = publicStorefrontCacheKey(policy.canonicalUrl, context.buildId, workerVersion, generation);
  const pathname = logicalUrl(new URL(policy.canonicalUrl)).pathname;
  const stored = await readCachedPage(context.cache, key);
  if (stored) return fromStoredResponse(stored, request, pathname);

  const response = await context.render(withGenerationHeader(
    toPublicCacheRequest(request, policy.canonicalUrl),
    generation,
  ));
  if (request.method === "GET" && isStorableResponse(response)) {
    context.waitUntil(storeCachedPage(context.cache, key, toStoredResponse(response.clone())));
  }
  return response;
}

/**
 * One refresh of this data center's frontier per isolate at a time, stored
 * once by the request that started it. Concurrent requests join it instead of
 * each asking the API (and D1) for the same delta.
 */
function refreshFrontierOnce(
  context: PublicStorefrontCacheContext,
  client: CacheFrontierClient,
  key: string,
  stored: CacheFrontier | null,
) {
  const now = context.now ?? Date.now;
  const flight = singleFlight(`frontier:${key}`, () => refreshCacheFrontier(stored, client, now), now);
  if (flight.created) {
    // The refresh outlives the request that started it: others await it.
    context.waitUntil(flight.promise
      .then((next) => next ? storeCacheFrontier(context.cache, key, next) : undefined)
      .catch(() => undefined));
  }
  return flight;
}

/**
 * The data center's frontier, fresh enough to validate a hit now: refreshed
 * (blocking) when missing, older than Δ, or behind the request's `_sv`;
 * refreshed ahead in the background once it is older than Δ/2. Null when it
 * cannot be refreshed: the page then renders. At most one refresh runs per
 * isolate; a request whose `_sv` is newer than the refresh it joined (the
 * write it saw may postdate that refresh's start) asks for one more.
 */
async function freshFrontier(
  context: PublicStorefrontCacheContext,
  client: CacheFrontierClient,
  key: string,
  seenSeq: number | null,
  storedFrontier: Promise<CacheFrontier | null>,
): Promise<{ frontier: CacheFrontier | null; waitedMs: number | null }> {
  const now = context.now ?? Date.now;
  const stored = await storedFrontier;
  const started = now();
  if (isCacheFrontierFresh(stored, started, seenSeq)) {
    if (started - stored.sentAt > CACHE_FRONTIER_DELTA_MS / 2) {
      refreshFrontierOnce(context, client, key, stored).promise.catch(() => undefined);
    }
    return { frontier: stored, waitedMs: null };
  }
  try {
    let flight = refreshFrontierOnce(context, client, key, stored);
    let next = await flight.promise;
    if (next && !flight.created && seenSeq !== null && next.S < seenSeq) {
      flight = refreshFrontierOnce(context, client, key, next);
      next = await flight.promise;
    }
    const finished = now();
    // An `_sv` still ahead of a fresh frontier names no commit yet: ignore it.
    return { frontier: next && isCacheFrontierFresh(next, finished, null) ? next : null, waitedMs: finished - started };
  } catch {
    return { frontier: null, waitedMs: now() - started };
  }
}

/**
 * Frontier mode (CACHE-DESIGN §6.7): a stored page is served only after the
 * hit rule proves none of its dependencies changed after its s0; the slow
 * path asks the API for an entry older than the frontier's horizon. A miss
 * renders inside a dependency collector and is stored, once its body has
 * streamed to the end, only when every API read of the render carried a proof.
 */
async function serveFrontierValidated(
  request: Request,
  policy: PublicStorefrontCachePolicy,
  workerVersion: string,
  context: PublicStorefrontCacheContext,
  client: CacheFrontierClient,
): Promise<Response> {
  const canonical = new URL(policy.canonicalUrl);
  // Browser cache rules follow the page a presence URL renders.
  const pathname = logicalUrl(canonical).pathname;
  const key = publicStorefrontDvcCacheKey(policy.canonicalUrl, context.buildId, workerVersion);
  const waits: CacheWaits = { frontierMs: null, slowCheckMs: null };
  const frontierKey = cacheFrontierKey(canonical.origin, context.buildId, workerVersion);
  // The page and this data center's frontier are read together: a hit needs
  // both, and the second read no longer waits for the first.
  const storedFrontier = readStoredCacheFrontier(context.cache, frontierKey).catch(() => null);
  const stored = await readCachedPage(context.cache, key);
  const entry = stored ? readStoredPageEntry(stored.headers) : null;
  if (stored && entry) {
    const { frontier, waitedMs } = await freshFrontier(context, client, frontierKey, readStorefrontSeenSeq(new URL(request.url)), storedFrontier);
    waits.frontierMs = waitedMs;
    const now = (context.now ?? Date.now)();
    const decision = frontier && isCacheFrontierFresh(frontier, now, null)
      ? decideCacheFrontierHit(entry, frontier, now) : "render";
    if (decision === "serve") {
      // Unrelated writes must not copy the HTML body. Rebase only when the
      // frontier horizon requires the indexed slow check below.
      return fromStoredResponse(stored, request, pathname, waits);
    }
    if (decision === "slow") {
      // Concurrent hits of one stored entry share one check (and one D1 scan);
      // the proof is only as fresh as the check's own start.
      const flight = singleFlight(`check:${key}:${entry.s0}:${entry.renderedAt}`,() => client.check(entry.s0, entry.depHashes), context.now ?? Date.now);
      const checkedAt = flight.startedAt;
      const check = await flight.promise.catch(() => null);
      const finishedAt = (context.now ?? Date.now)();
      waits.slowCheckMs = finishedAt - checkedAt;
      // The slow proof is only fresh from when its request started. Scheduled
      // transitions can pass while that request is in flight, without a write.
      if (check && check.apiVersion === entry.apiVersion && !check.changed && check.S >= entry.s0 && check.S >= check.floor
        && finishedAt >= checkedAt && finishedAt - checkedAt <= CACHE_FRONTIER_DELTA_MS
        && (entry.validUntil === null || finishedAt < entry.validUntil)
        && (entry.softMaxAgeSeconds === null || finishedAt - entry.renderedAt < entry.softMaxAgeSeconds * 1000)) {
        // Only the request that ran the check rebases the stored entry.
        if (flight.created) {
          const copy = stored.clone();
          context.waitUntil(storeCachedPage(context.cache, key, toStoredResponse(copy, { ...entry, s0: check.S })));
        }
        return fromStoredResponse(stored, request, pathname, waits);
      }
    }
  }
  // A rejected/unproven entry is not consumed by the live render. Do not await
  // cancellation of a tee branch: another cache reader can still own its peer.
  if (stored) void stored.body?.cancel().catch(() => undefined);

  const now = context.now ?? Date.now;
  const coalesce = request.method === "GET" && readStorefrontSeenSeq(new URL(request.url)) === null;
  const running = coalesce ? joinableRender(key, now()) : null;
  if (running) {
    const shared = await awaitSharedRender(running.shared, context.renderJoinWaitMs ?? RENDER_JOIN_WAIT_MS);
    if (shared) {
      // Each joiner gets its own copy of the bytes and headers.
      const page = new Response(shared.body.slice(0), { status: shared.status, headers: shared.headers });
      return fromStoredResponse(page, request, pathname, waits, "MISS; coalesced");
    }
  }

  const startedAt = now();
  const dependencies = createPageDependencies();
  const rendering = collectPageDependencies(dependencies, () => context.render(
    withGenerationHeader(toPublicCacheRequest(request, policy.canonicalUrl), null),
  ));
  let share: (page: SharedRender | null) => void = () => undefined;
  if (coalesce && !running) leadRender(key, startedAt, new Promise((resolve) => { share = resolve; }));
  let response: Response;
  try {
    response = await rendering;
  } catch (error) {
    share(null);
    throw error;
  }
  const storable = request.method === "GET" && isStorableResponse(response, "store");
  // A rejected entry's wait still delayed this answer.
  const status = response.headers.get("X-Cache-Status");
  const withWaits = status ? cacheStatusWithWaits(status, waits) : status;
  if (storable) {
    const copy = response.clone();
    context.waitUntil((async () => {
      // The render (and every read its components made while it streamed)
      // has finished once its body has.
      const body = await copy.arrayBuffer();
      const proven = pageEntryFromDependencies(dependencies);
      // A 404 page is stored only when the API's own bounded not-found cache served its lookup.
      const rendered = copy.status !== 404 ? proven
        : proven && notFoundReadsAdmitted(dependencies) ? boundNotFoundEntry(proven, startedAt) : null;
      const isHtml = copy.headers.get("Content-Type")?.toLowerCase().includes("text/html") ?? false;
      const earlyHints = isHtml ? pageEarlyHintLinks(new TextDecoder().decode(body.slice(0, EARLY_HINT_HEAD_BYTES))) : [];
      const page = toStoredResponse(copy, rendered, body, earlyHints);
      // Joiners take the bytes whether or not the render proved its reads (they are as fresh as its
      // start), but never a render that fell back on a failed read: that page is its buyer's only.
      share(dependencies.degraded ? null : { status: page.status, headers: [...page.headers], body: body.slice(0) });
      // Only a proven render is stored.
      if (rendered) await storeCachedPage(context.cache, key, page);
    })().catch(() => share(null)));
  } else {
    share(null);
  }
  if (withWaits !== status) {
    response = new Response(response.body, response);
    response.headers.set("X-Cache-Status", withWaits!);
  }
  return response;
}
