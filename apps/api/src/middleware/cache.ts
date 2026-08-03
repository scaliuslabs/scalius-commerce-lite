// src/server/middleware/cache.ts
import type { Context, MiddlewareHandler } from "hono";
import { getCache, setCache, getCacheType } from "../utils/kv-cache";
import {
  captureApiCacheFenceSnapshot,
  getApiCacheFenceScopesForKey,
  isApiCacheFenceSnapshotCurrent,
  withApiCacheFenceToken,
} from "../utils/api-cache-fence";
import type { WaitUntilExecutionContext } from "../utils/cache-invalidation";

// Default TTL in seconds (1 hour)
const DEFAULT_CACHE_TTL = 3600;

/**
 * Default Cache-Control for storefront API responses.
 * KV remains the shared edge cache. Browsers may store the response, but must
 * revalidate it so a mutation cannot remain hidden behind a browser stale
 * window after the matching KV fence advances.
 */
const DEFAULT_CACHE_CONTROL =
  "public, max-age=0, no-cache, must-revalidate";

type CacheQueryDefaultValue = string | number | boolean | undefined;
type CacheQueryDefaults =
  | Record<string, CacheQueryDefaultValue>
  | ((c: Context) => Record<string, CacheQueryDefaultValue>);
type CacheQueryNormalizers = Record<
  string,
  (value: string, key: string) => string | undefined
>;

export interface CacheOptions {
  ttl?: number | ((c: Context) => number);
  keyPrefix?: string;
  cacheNullValues?: boolean;
  methods?: string[];
  varyByQuery?: boolean;
  queryDefaults?: CacheQueryDefaults;
  queryNormalizers?: CacheQueryNormalizers;
  varyByAuth?: boolean;
  cacheCondition?: (c: Context) => boolean;
  /** Override Cache-Control. Default ensures browser revalidation for consistency with KV invalidation. */
  cacheControl?: string;
}

function resolveQueryDefaults(
  c: Context,
  queryDefaults: CacheQueryDefaults | undefined,
): Record<string, CacheQueryDefaultValue> {
  return typeof queryDefaults === "function"
    ? queryDefaults(c)
    : queryDefaults ?? {};
}

export function canonicalizeCacheQueryString(
  url: string,
  queryDefaults: Record<string, CacheQueryDefaultValue> = {},
  queryNormalizers: CacheQueryNormalizers = {},
): string {
  const params = new URL(url).searchParams;
  const entries: Array<[string, string]> = [];

  for (const [key, value] of params.entries()) {
    const normalizedValue = queryNormalizers[key]?.(value, key) ?? value;
    if (normalizedValue === "") continue;
    const defaultValue = queryDefaults[key];
    if (defaultValue !== undefined && normalizedValue === String(defaultValue)) {
      continue;
    }
    entries.push([key, normalizedValue]);
  }

  entries.sort(([aKey, aValue], [bKey, bValue]) => {
    const keyCompare = aKey.localeCompare(bKey);
    return keyCompare === 0 ? aValue.localeCompare(bValue) : keyCompare;
  });

  const canonicalParams = new URLSearchParams();
  for (const [key, value] of entries) {
    canonicalParams.append(key, value);
  }
  return canonicalParams.toString();
}

/**
 * Middleware for caching API responses in Cloudflare KV (or in-memory fallback).
 */
export const cacheMiddleware = (
  options: CacheOptions = {},
): MiddlewareHandler => {
  const {
    ttl = DEFAULT_CACHE_TTL,
    keyPrefix = "api:",
    cacheNullValues = false,
    methods = ["GET"],
    varyByQuery = true,
    queryDefaults,
    queryNormalizers,
    varyByAuth = false,
    cacheCondition,
    cacheControl = DEFAULT_CACHE_CONTROL,
  } = options;

  return async (c, next) => {
    if (!methods.includes(c.req.method)) return next();
    const resolvedTtl = typeof ttl === "function" ? ttl(c) : ttl;
    if (resolvedTtl <= 0) return next();
    if (cacheCondition && !cacheCondition(c)) return next();

    // KV namespace from Cloudflare Workers env binding
    const kv: KVNamespace | undefined = c.env?.CACHE;

    // Build cache key
    let cacheKey = `${keyPrefix}${c.req.path}`;

    if (varyByQuery) {
      const qs = canonicalizeCacheQueryString(
        c.req.url,
        resolveQueryDefaults(c, queryDefaults),
        queryNormalizers,
      );
      if (qs) cacheKey += `?${qs}`;
    }

    if (varyByAuth) {
      const authHeader = c.req.header("Authorization") || "";
      if (authHeader) {
        let hash = 0;
        for (let i = 0; i < authHeader.length; i++) {
          hash = ((hash << 5) - hash + authHeader.charCodeAt(i)) | 0;
        }
        cacheKey += `:auth:${(hash >>> 0).toString(36)}`;
      } else {
        cacheKey += ":auth:none";
      }
    }

    const fenceSnapshot = await captureApiCacheFenceSnapshot(
      getApiCacheFenceScopesForKey(cacheKey, keyPrefix),
      kv,
    );
    const versionedCacheKey = withApiCacheFenceToken(cacheKey, fenceSnapshot);

    // Try cache hit
    try {
      const cached = await getCache<{
        status: number;
        headers: Record<string, string>;
        body: string;
      }>(versionedCacheKey, kv);

      if (cached) {
        const headers = new Headers(cached.headers);
        headers.set("X-Cache", "HIT");
        headers.set("X-Cache-Type", getCacheType(kv));
        headers.set("Cache-Control", cacheControl);
        return new Response(cached.body, { status: cached.status, headers });
      }
    } catch (error: unknown) {
      console.error("[Cache] Error reading from cache:", error);
    }

    // Cache miss – add headers and execute handler
    c.header("X-Cache", "MISS");
    c.header("X-Cache-Type", getCacheType(kv));
    c.header("Cache-Control", cacheControl);

    await next();

    const response = c.res;
    if (!response.ok) return;

    const resCacheControl = response.headers.get("Cache-Control");
    if (resCacheControl?.includes("no-store")) return;

    const cloned = response.clone();
    const cacheWrite = (async () => {
      try {
        const body = await cloned.text();

        if (!body && !cacheNullValues) return;

        const headers: Record<string, string> = {};
        cloned.headers.forEach((value, key) => {
          headers[key] = value;
        });

        const isSnapshotCurrent = await isApiCacheFenceSnapshotCurrent(
          fenceSnapshot,
          kv,
        );
        if (!isSnapshotCurrent) return;

        await setCache(
          versionedCacheKey,
          { status: cloned.status, headers, body },
          resolvedTtl,
          kv,
        );
      } catch (error: unknown) {
        console.error("[Cache] Error writing to cache:", error);
      }
    })();

    let executionCtx: WaitUntilExecutionContext | undefined;
    try {
      executionCtx = c.executionCtx;
    } catch {
      executionCtx = undefined;
    }

    if (executionCtx && typeof executionCtx.waitUntil === "function") {
      executionCtx.waitUntil(cacheWrite);
    } else {
      await cacheWrite;
    }
  };
};

/**
 * Create a cache key for a specific resource item.
 */
export function createResourceCacheKey(prefix: string, id: string): string {
  return `api:${prefix}:${id}`;
}

/**
 * Create a cache key pattern for a resource type (used for bulk invalidation).
 */
export function createResourceCachePattern(prefix: string): string {
  return `api:${prefix}:*`;
}
