import { PUBLIC_CACHE_MAX_AGE_SECONDS } from "@scalius/shared/cache-generation";
import { isPublicApiCacheRoute } from "@scalius/shared/public-api-cache-routes";

/**
 * Anonymous public API reads served through the `PublicApi` Workers Cache
 * entrypoint. The cache key is the canonical path + sorted query plus the
 * store's cache generation and the running Worker version, so a buyer-visible
 * write or a deploy makes every entry stale without a purge.
 */
export interface PublicApiCachePolicy {
  canonicalUrl: string;
}

/** Internal query parameter carrying the cache generation into the key. */
export const CACHE_GENERATION_QUERY_PARAM = "__cg";
/** Internal query parameter carrying the Worker version into the key. */
export const CACHE_VERSION_QUERY_PARAM = "__cv";
const CACHE_KEY_QUERY_PARAMS = [CACHE_GENERATION_QUERY_PARAM, CACHE_VERSION_QUERY_PARAM] as const;

function hasCacheKeyParams(url: URL): boolean {
  return CACHE_KEY_QUERY_PARAMS.some((name) => url.searchParams.has(name));
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
  if (hasCacheKeyParams(url)) return null;
  if (!isPublicApiCacheRoute(url)) return null;

  return {
    canonicalUrl: new URL(buildPublicApiCacheKey(url), url.origin).toString(),
  };
}

/**
 * The canonical URL with the generation and the Worker version appended; it
 * becomes the cache key.
 */
export function withCacheIdentity(canonicalUrl: string, generation: string, version: string): string {
  const url = new URL(canonicalUrl);
  url.searchParams.append(CACHE_GENERATION_QUERY_PARAM, generation);
  url.searchParams.append(CACHE_VERSION_QUERY_PARAM, version);
  return url.toString();
}

/**
 * How public API reads are cached (CACHE-DESIGN §8). One code-level switch,
 * deliberately not an env var (AGENTS.md: no env var without an
 * architecture decision); a change ships as a deploy, and the Worker version
 * in every key isolates the entries of one mode from the other's.
 *
 * - `generation`: the cache generation is the only freshness authority
 *   (PublicApi for direct reads, the batch reader for storefront parts).
 * - `shadow` (P1): serves exactly as `generation`; after each batch answers,
 *   the dependency-validated cache evaluates the same parts in the
 *   background under its own keys and logs, masked, every entry it would have
 *   served that differs from a fresh render (`[CacheShadow]`).
 * - `strict` (P2): parts are keyed without the generation and served only
 *   after one validation read proves none of their dependencies changed;
 *   direct reads use the same reader in the default entrypoint (PublicApi is
 *   not called). Before switching, remove `exports.PublicApi.cache` from
 *   wrangler.jsonc.
 */
export type ApiPartCacheMode = "generation" | "shadow" | "strict";
export const API_PART_CACHE_MODE: ApiPartCacheMode = "shadow";

/**
 * The dependency-validated key of a public read: the canonical URL and the
 * Worker version, without the generation (the entry carries its own proof).
 */
export function withDvcIdentity(canonicalUrl: string, version: string): string {
  const url = new URL(canonicalUrl);
  url.searchParams.append(CACHE_VERSION_QUERY_PARAM, version);
  return url.toString();
}

/**
 * The data center's snapshot of the store clock and the Platform settings
 * row, as last read by a validation statement (public-read.ts).
 */
export function dvcSnapshotKey(origin: string, version: string): string {
  const url = new URL("/__scalius/dvc-snapshot", origin);
  url.searchParams.append(CACHE_VERSION_QUERY_PARAM, version);
  return url.toString();
}

/** Removes the generation and version before the request reaches the application. */
export function withoutCacheIdentity(request: Request): Request {
  const url = new URL(request.url);
  if (!hasCacheKeyParams(url)) return request;
  for (const name of CACHE_KEY_QUERY_PARAMS) url.searchParams.delete(name);
  return new Request(url.toString(), request);
}

/**
 * A server error the Workers Cache layer produced itself, not this Worker:
 * every response of ours carries the baseline security headers
 * (`applyBaselineSecurityHeaders`), and a stuck cache entry answers an empty
 * 500 without them. Such a read is rendered directly instead; our own 5xx
 * passes through so an outage never doubles the database load.
 */
export function isCacheLayerServerError(response: Response): boolean {
  return response.status >= 500 && !response.headers.has("X-Content-Type-Options");
}

/**
 * One masked line per cache-layer fallback: the read's path and the colo of
 * the incoming request, never query values.
 */
export function logCacheLayerFallback(readUrl: string, incoming: Request, status: number): void {
  const colo = (incoming as Request & { cf?: { colo?: unknown } }).cf?.colo;
  console.warn(
    `[PublicCache] cache layer answered ${status} for ${new URL(readUrl).pathname}` +
      `${typeof colo === "string" ? ` at ${colo}` : ""}; rendering it directly`,
  );
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
