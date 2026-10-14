// The store's media on its own origin: `/media/<id>.<ext>[/<width>.webp]`.
// A page's images then reuse the connection that carried the page (no second
// DNS lookup, TLS handshake or HTTP/2 connection ahead of the LCP image).
// The bytes come from the API Worker over the service binding (it reads R2);
// each object is immutable, so it is served with a year-long cache header
// and kept in this data center's cache: after the first request an image costs
// one cache read. The gateway answers these paths before Astro: no page
// render, no layout read.
//
// The path is the R2 object key, so rewriting a media URL to this origin is
// swapping the origin (`mediaUrlOnStoreOrigin`). `/media` alone (a CMS page)
// and every other path are not this route.

import { INTERNAL_SERVICE_ORIGIN } from "@scalius/shared/platform-config";

export const STOREFRONT_MEDIA_PREFIX = "/media/";

/** The longest object key (`media/<id>.<ext>/<width>.webp`) a request may name. */
const KEY_MAX_LENGTH = 200;
/** The shape the API accepts (`validateMediaObjectKey`): `media/<id>.<ext>` and its `/<width>.webp` renditions. */
const KEY_PATTERN = /^media\/[A-Za-z0-9][A-Za-z0-9/_-]*\.[A-Za-z0-9]{1,10}(?:\/[1-9]\d{0,3}\.webp)?$/;
/** Objects up to this size are kept in the data-center cache; larger ones (video) stream. */
export const MEDIA_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const IMMUTABLE = "public, max-age=31536000, immutable";

/** The R2 object key a gateway path names; null for any other path. */
export function mediaKeyOfPath(pathname: string): string | null {
  if (!pathname.startsWith(STOREFRONT_MEDIA_PREFIX)) return null;
  const key = pathname.slice(1);
  return key.length <= KEY_MAX_LENGTH && !key.includes("//") && KEY_PATTERN.test(key) ? key : null;
}

/**
 * The data-center cache key of one object. `store` (the store's own origin)
 * keeps one store's cache from serving another's; the Worker version keeps a
 * deploy from reading the previous release's entries.
 */
export function mediaCacheKey(store: string, workerVersion: string, key: string): string {
  return `${INTERNAL_SERVICE_ORIGIN}/__storefront-media/${encodeURIComponent(store)}/${encodeURIComponent(workerVersion)}/${key}`;
}

function defaultCache(): Cache | null {
  return typeof caches === "undefined" ? null : (caches as unknown as { default?: Cache }).default ?? null;
}

const notFound = () =>
  new Response("Not Found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });

/** Request headers that change the answer from a cached copy (range and validators). */
function cacheLookupHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const name of ["Range", "If-None-Match", "If-Modified-Since", "If-Range"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function publicHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const name of ["Content-Type", "Content-Length", "Content-Range", "ETag", "Last-Modified"]) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", IMMUTABLE);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Access-Control-Allow-Origin", "*");
  return headers;
}

export interface StorefrontMediaContext {
  env: { BACKEND_API?: Fetcher };
  /** `CF_VERSION_METADATA.id`; without it nothing is cached. */
  workerVersion: string | null;
  waitUntil: (promise: Promise<unknown>) => void;
  /** The data-center cache (`caches.default`); injected in tests. */
  cache?: Cache | null;
}

/**
 * The gateway's answer for a `/media/…` path; null for any other path. A hit
 * is one cache read. A miss streams the object from the API to the buyer
 * while a copy goes into the cache (never buffered whole). A range request
 * is answered from a cached copy, else passed through uncached.
 */
export async function serveStorefrontMedia(
  request: Request,
  context: StorefrontMediaContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(STOREFRONT_MEDIA_PREFIX)) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const key = mediaKeyOfPath(url.pathname);
  if (!key) return notFound();
  const head = request.method === "HEAD";

  const cache = context.cache === undefined ? defaultCache() : context.cache;
  const cacheKey = cache && context.workerVersion ? mediaCacheKey(url.origin, context.workerVersion, key) : null;
  if (cache && cacheKey) {
    const hit = await cache.match(new Request(cacheKey, { headers: cacheLookupHeaders(request) })).catch(() => undefined);
    if (hit) return new Response(head ? null : hit.body, { status: hit.status, headers: publicHeaders(hit.headers) });
  }

  const backend = context.env.BACKEND_API;
  if (!backend) return notFound();
  const forwarded = new Headers({ Accept: request.headers.get("Accept") ?? "*/*" });
  const range = request.headers.get("Range");
  if (range) forwarded.set("Range", range);
  const upstream = await backend
    .fetch(new Request(`${INTERNAL_SERVICE_ORIGIN}/api/v1/media/${key}`, { headers: forwarded }))
    .catch(() => null);
  if (!upstream) return new Response("Bad Gateway", { status: 502, headers: { "Cache-Control": "no-store" } });
  if (upstream.status === 404) return notFound();
  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => undefined);
    return new Response("Bad Gateway", { status: 502, headers: { "Cache-Control": "no-store" } });
  }

  const response = new Response(head ? null : upstream.body, {
    status: upstream.status,
    headers: publicHeaders(upstream.headers),
  });
  const size = Number(upstream.headers.get("Content-Length"));
  if (cache && cacheKey && !head && upstream.status === 200 && Number.isFinite(size) && size > 0 && size <= MEDIA_CACHE_MAX_BYTES) {
    context.waitUntil(cache.put(cacheKey, response.clone()).catch(() => undefined));
  }
  return response;
}
