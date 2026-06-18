// src/lib/edge-cache.ts

/**
 * Two-layer cache wrapper for API responses:
 * - L1: In-memory cache (fast, dies on cold start)
 * - L2: Cloudflare Cache API (persistent at edge, survives cold starts)
 *
 * Cache keys include KV version so /api/purge-cache invalidation works correctly.
 * When KV version bumps, new cache keys are used, effectively invalidating old entries.
 *
 * Cache context is stored per-request in AsyncLocalStorage to prevent
 * cross-request state contamination under concurrent Worker requests.
 */

import { smartCache } from "./smart-cache";
import { BUILD_ID } from "@/config/build-id";
import {
  resolveExactCacheGeneration,
  shouldUseExactCacheGeneration,
} from "./cache-generations";

const DEFAULT_TTL_SECONDS = 8640000; // 24 hours - purge-cache handles invalidation

// Timeout for L2 cache operations to prevent hanging (per CF best practices)
const L2_CACHE_TIMEOUT_MS = 500;
const GENERATION_LOOKUP_TIMEOUT_MS = 500;

interface EdgeCacheOptions {
  ttlSeconds?: number;
}

interface CacheContext {
  cache: Cache | null;
  kvStore: KVNamespace | null;
  kvVersion: string | null;
  hostname: string;
  cacheNamespace: string;
  waitUntil: ((promise: Promise<unknown>) => void) | null;
}

// ---------------------------------------------------------------------------
// AsyncLocalStorage for per-request cache context
// ---------------------------------------------------------------------------

interface AsyncLocalStorageLike<T> {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
}

let _cacheAls: AsyncLocalStorageLike<CacheContext>;

if (import.meta.env.SSR) {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  _cacheAls = new AsyncLocalStorage<CacheContext>();
} else {
  _cacheAls = {
    getStore: () => undefined,
    run: <R>(_store: CacheContext, fn: () => R) => fn(),
  };
}

export const cacheContextAls: AsyncLocalStorageLike<CacheContext> = _cacheAls;

/** Default context used when ALS is not yet initialized. */
const DEFAULT_CONTEXT: CacheContext = {
  cache: null,
  kvStore: null,
  kvVersion: null,
  hostname: "localhost",
  cacheNamespace: "localhost",
  waitUntil: null,
};

/**
 * Get the current cache context from ALS.
 */
function getCacheContext(): CacheContext {
  return cacheContextAls.getStore() ?? DEFAULT_CONTEXT;
}

/**
 * Initialize the edge cache context for the current request.
 * Called by middleware at the start of each request via cacheContextAls.run().
 *
 * @param cache The Cloudflare Cache API instance (caches.default)
 * @param kvVersion The current cache version from KV
 * @param hostname The hostname of the current request (for multi-tenant cache keys)
 * @param waitUntil Function to schedule background work
 */
export function setEdgeCacheContext(
  cache: Cache | null,
  kvVersion: string | null,
  hostname: string,
  waitUntil: ((promise: Promise<unknown>) => void) | null,
  kvStore: KVNamespace | null = null,
  cacheNamespace: string = hostname,
): void {
  // Store context so getEdgeCacheContext() works for callers that
  // don't go through cacheContextAls.run() yet.
  // The ALS path is preferred — this is a compatibility shim.
  _fallbackContext = { cache, kvStore, kvVersion, hostname, cacheNamespace, waitUntil };
}

/** Fallback for callers not yet within ALS.run(). */
let _fallbackContext: CacheContext = DEFAULT_CONTEXT;

/**
 * Get the current cache context (for use in cache warming).
 */
export function getEdgeCacheContext(): CacheContext {
  return cacheContextAls.getStore() ?? _fallbackContext;
}

/**
 * In-flight request deduplication map.
 * Prevents duplicate API calls when multiple components request the same data.
 *
 * Example: Layout.astro and index.astro both call getLayoutData() simultaneously
 * on cache miss - without deduplication, this creates 2 API calls.
 * With deduplication, the second call waits for the first to complete.
 */
const inflight = new Map<string, Promise<unknown>>();

function runInflightOnly<T>(
  memoryKey: string,
  fetcher: () => Promise<T | null>,
): Promise<T | null> {
  if (inflight.has(memoryKey)) {
    return inflight.get(memoryKey) as Promise<T | null>;
  }

  const promise = fetcher().finally(() => {
    inflight.delete(memoryKey);
  });
  inflight.set(memoryKey, promise);
  return promise;
}

/**
 * Build the L2 cache key URL.
 * Uses the actual hostname to follow Cloudflare's recommendation.
 * Includes KV version and BUILD_ID to ensure proper invalidation.
 *
 * Cache key format: https://{hostname}/_api-cache/{encoded-key}?v={version}&build={BUILD_ID}[&g={generation}]
 */
function buildL2CacheKey(key: string, generation: string | null): string {
  const ctx = getCacheContext();
  if (!ctx.kvVersion) {
    throw new Error("Cannot build L2 cache key without a cache version");
  }
  const encodedKey = encodeURIComponent(key);
  // Use actual hostname with a reserved path prefix for API cache
  // This follows Cloudflare's recommendation to avoid hostname mismatches
  const cacheKey = new URL(`https://${ctx.hostname}/_api-cache/${encodedKey}`);
  cacheKey.searchParams.set("v", ctx.kvVersion);
  cacheKey.searchParams.set("build", BUILD_ID);
  if (generation !== null) {
    cacheKey.searchParams.set("g", generation);
  }
  return cacheKey.toString();
}

function buildScopedMemoryKey(
  key: string,
  ctx: CacheContext,
  generation: string | null,
): string {
  if (!ctx.kvVersion) {
    return `${key}:host=${ctx.hostname}:ns=${ctx.cacheNamespace}:build=${BUILD_ID}:v=disabled`;
  }
  return `${key}:host=${ctx.hostname}:ns=${ctx.cacheNamespace}:build=${BUILD_ID}:v${ctx.kvVersion}:g${generation ?? "global"}`;
}

async function resolveLogicalCacheGeneration(
  key: string,
  ctx: CacheContext,
): Promise<
  | { cacheEnabled: true; generation: string | null }
  | { cacheEnabled: false; reason: string }
> {
  if (!shouldUseExactCacheGeneration(key)) {
    return { cacheEnabled: true, generation: null };
  }

  if (!ctx.kvStore) {
    return {
      cacheEnabled: false,
      reason: "KV generation store unavailable",
    };
  }

  const generation = await resolveExactCacheGeneration({
    store: ctx.kvStore,
    hostname: ctx.cacheNamespace,
    logicalKey: key,
    timeoutMs: GENERATION_LOOKUP_TIMEOUT_MS,
  });

  if (generation.status === "unavailable") {
    return {
      cacheEnabled: false,
      reason: generation.reason,
    };
  }

  return { cacheEnabled: true, generation: generation.generation };
}

/**
 * Try to get data from L2 (Cloudflare Cache API).
 * Returns null if not found or if L2 is unavailable.
 */
async function getFromL2<T>(key: string, generation: string | null): Promise<T | null> {
  const ctx = getCacheContext();
  if (!ctx.cache || !ctx.kvVersion) return null;

  try {
    const cacheKeyUrl = buildL2CacheKey(key, generation);

    // Add timeout to cache.match to prevent hanging (per CF best practices)
    const cachedResponse = await Promise.race([
      ctx.cache.match(cacheKeyUrl),
      new Promise<Response | undefined>((resolve) =>
        setTimeout(() => resolve(undefined), L2_CACHE_TIMEOUT_MS),
      ),
    ]);

    if (cachedResponse) {
      const data = await cachedResponse.json();
      return data as T;
    }
  } catch (error: unknown) {
    console.warn(`[EdgeCache] L2 read error for ${key}:`, error);
  }

  return null;
}

/**
 * Store data in L2 (Cloudflare Cache API).
 * Uses waitUntil to avoid blocking the response.
 */
function storeInL2<T>(
  key: string,
  data: T,
  ttlSeconds: number,
  generation: string | null,
): void {
  const ctx = getCacheContext();
  if (!ctx.cache || !ctx.kvVersion) return;

  const cacheKeyUrl = buildL2CacheKey(key, generation);
  const response = new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      // Long TTL for Cache API storage; invalidation via KV version in cache key.
      "Cache-Control": `public, max-age=${ttlSeconds}`,
      // Track when this was cached for debugging
      "X-Cached-At": new Date().toISOString(),
      "X-Cache-Key": key,
      "X-Cache-Version": ctx.kvVersion,
      ...(generation !== null ? { "X-Cache-Generation": generation } : {}),
    },
  });

  const storePromise = ctx.cache.put(cacheKeyUrl, response);

  // Use waitUntil if available to avoid blocking response
  if (ctx.waitUntil) {
    ctx.waitUntil(storePromise);
  }
}

/**
 * Wraps a fetcher with two-layer caching:
 * 1. L1 In-memory cache (fast, dies on cold start)
 * 2. L2 Cloudflare Cache API (persistent at edge)
 * 3. Request deduplication (prevents duplicate API calls on cache miss)
 *
 * Cache keys include KV version so /api/purge-cache invalidation works.
 * Cleared by /api/purge-cache when content is updated.
 */
export async function withEdgeCache<T>(
  key: string,
  fetcher: () => Promise<T | null>,
  options: EdgeCacheOptions = {},
): Promise<T | null> {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const ctx = getCacheContext();

  if (!ctx.kvVersion) {
    return runInflightOnly(buildScopedMemoryKey(key, ctx, null), fetcher);
  }

  const generationState = await resolveLogicalCacheGeneration(key, ctx);
  if (!generationState.cacheEnabled) {
    console.warn(
      `[EdgeCache] Bypassing exact cache for ${key}: ${generationState.reason}`,
    );
    return fetcher();
  }
  const cacheGeneration = generationState.generation;

  // Include hostname, build, and KV version in memory keys so warm isolates
  // cannot share data across custom domains or deployed builds.
  const memoryKey = buildScopedMemoryKey(key, ctx, cacheGeneration);

  // 1. Check L1 Cache (in-memory) - fastest
  const l1Cached = smartCache.get<T>(memoryKey);
  if (l1Cached !== null) {
    return l1Cached;
  }

  // 2. Check if request is already in-flight (deduplication)
  // This prevents duplicate API calls when multiple components request simultaneously
  if (inflight.has(memoryKey)) {
    return inflight.get(memoryKey) as Promise<T | null>;
  }

  // 3. Create the fetch promise with L2 check and backend fallback
  const promise = (async (): Promise<T | null> => {
    try {
      // 3a. Check L2 Cache (Cloudflare Cache API) - survives cold starts
      const l2Cached = await getFromL2<T>(key, cacheGeneration);
      if (l2Cached !== null) {
        // Populate L1 from L2 for faster subsequent requests
        smartCache.set(memoryKey, l2Cached, ttlSeconds);
        return l2Cached;
      }

      // 3b. Fetch from backend (cache miss on both layers)
      const data = await fetcher();

      if (data !== null) {
        // Store in L1 (fast access for this request lifecycle)
        smartCache.set(memoryKey, data, ttlSeconds);

        // Store in L2 (survives cold starts)
        storeInL2(key, data, ttlSeconds, cacheGeneration);
      }

      return data;
    } catch (error: unknown) {
      console.error(`[EdgeCache] Fetch failed for ${key}:`, error);
      return null;
    } finally {
      // Clean up inflight map after request completes (success or failure)
      inflight.delete(memoryKey);
    }
  })();

  inflight.set(memoryKey, promise);
  return promise;
}

/**
 * Clears all L1 (in-memory) cache entries.
 * Called by /api/purge-cache.
 *
 * Note: L2 cache is invalidated automatically because new requests
 * will use a new cache key (with bumped KV version).
 */
export function clearMemoryCache(): void {
  smartCache.clear();
}

/**
 * Selectively clears L1 (in-memory) cache entries matching given prefixes.
 * Called by /api/purge-cache for targeted invalidation.
 *
 * Note: memory keys keep the logical cache key first, then append
 * host/build/version scope, so prefix matching still works.
 */
export function clearL1ByPrefixes(prefixes: string[]): void {
  smartCache.deleteByPrefixes(prefixes);
}

export const CACHE_TTL = {
  LONG: 86400,   // 24h - static data (layout, categories, etc.)
  MEDIUM: 3600,  // 1h  - semi-dynamic (product listings)
  SHORT: 300,    // 5m  - dynamic (CSP settings, checkout config)
} as const;
