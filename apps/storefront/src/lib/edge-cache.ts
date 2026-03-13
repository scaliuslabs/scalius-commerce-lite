// src/lib/edge-cache.ts

/**
 * Two-layer cache wrapper for API responses:
 * - L1: In-memory cache (fast, dies on cold start)
 * - L2: Cloudflare Cache API (persistent at edge, survives cold starts)
 *
 * Cache keys include KV version so /api/purge-cache invalidation works correctly.
 * When KV version bumps, new cache keys are used, effectively invalidating old entries.
 */

/// <reference types="@cloudflare/workers-types" />

import { smartCache } from "./smart-cache";
import { BUILD_ID } from "@/config/build-id";

const DEFAULT_TTL_SECONDS = 8640000; // 24 hours - purge-cache handles invalidation

// Timeout for L2 cache operations to prevent hanging (per CF best practices)
const L2_CACHE_TIMEOUT_MS = 500;

interface EdgeCacheOptions {
  ttlSeconds?: number;
}

interface CacheContext {
  cache: Cache | null;
  kvVersion: string;
  hostname: string;
  waitUntil: ((promise: Promise<any>) => void) | null;
}

/**
 * Request-scoped cache context.
 * Set by middleware at the start of each request.
 * Provides access to Cloudflare Cache API and KV version.
 */
let cacheContext: CacheContext = {
  cache: null,
  kvVersion: "1",
  hostname: "localhost",
  waitUntil: null,
};

/**
 * Initialize the edge cache context for the current request.
 * Called by middleware at the start of each request.
 *
 * @param cache The Cloudflare Cache API instance (caches.default)
 * @param kvVersion The current cache version from KV
 * @param hostname The hostname of the current request (for multi-tenant cache keys)
 * @param waitUntil Function to schedule background work
 */
export function setEdgeCacheContext(
  cache: Cache | null,
  kvVersion: string,
  hostname: string,
  waitUntil: ((promise: Promise<any>) => void) | null,
): void {
  // Clear inflight map on new request to prevent dead promise issues
  // Per CF docs: module-level mutable state can cause issues with isolate reuse
  // If a previous request was interrupted, its promise may never resolve
  inflight.clear();
  cacheContext = { cache, kvVersion, hostname, waitUntil };
}

/**
 * Get the current cache context (for use in cache warming).
 */
export function getEdgeCacheContext(): CacheContext {
  return cacheContext;
}

/**
 * In-flight request deduplication map.
 * Prevents duplicate API calls when multiple components request the same data.
 *
 * Example: Layout.astro and index.astro both call getLayoutData() simultaneously
 * on cache miss - without deduplication, this creates 2 API calls.
 * With deduplication, the second call waits for the first to complete.
 */
const inflight = new Map<string, Promise<any>>();

/**
 * Build the L2 cache key URL.
 * Uses the actual hostname to follow Cloudflare's recommendation.
 * Includes KV version and BUILD_ID to ensure proper invalidation.
 *
 * Cache key format: https://{hostname}/_api-cache/{key}?v={version}&build={BUILD_ID}
 */
function buildL2CacheKey(key: string): string {
  // Use actual hostname with a reserved path prefix for API cache
  // This follows Cloudflare's recommendation to avoid hostname mismatches
  return `https://${cacheContext.hostname}/_api-cache/${key}?v=${cacheContext.kvVersion}&build=${BUILD_ID}`;
}

/**
 * Try to get data from L2 (Cloudflare Cache API).
 * Returns null if not found or if L2 is unavailable.
 */
async function getFromL2<T>(key: string): Promise<T | null> {
  if (!cacheContext.cache) return null;

  try {
    const cacheKeyUrl = buildL2CacheKey(key);

    // Add timeout to cache.match to prevent hanging (per CF best practices)
    const cachedResponse = await Promise.race([
      cacheContext.cache.match(cacheKeyUrl),
      new Promise<Response | undefined>((resolve) =>
        setTimeout(() => resolve(undefined), L2_CACHE_TIMEOUT_MS),
      ),
    ]);

    if (cachedResponse) {
      const data = await cachedResponse.json();
      return data as T;
    }
  } catch (error) {
    console.warn(`[EdgeCache] L2 read error for ${key}:`, error);
  }

  return null;
}

/**
 * Store data in L2 (Cloudflare Cache API).
 * Uses waitUntil to avoid blocking the response.
 */
function storeInL2<T>(key: string, data: T, ttlSeconds: number): void {
  if (!cacheContext.cache) return;

  const cacheKeyUrl = buildL2CacheKey(key);
  const response = new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      // Long TTL for Cache API storage; invalidation via KV version in cache key.
      // SWR/stale-if-error for consistency with Hono API policy.
      "Cache-Control": `public, max-age=${ttlSeconds}, stale-while-revalidate=120, stale-if-error=300`,
      // Track when this was cached for debugging
      "X-Cached-At": new Date().toISOString(),
      "X-Cache-Key": key,
      "X-Cache-Version": cacheContext.kvVersion,
    },
  });

  const storePromise = cacheContext.cache.put(cacheKeyUrl, response);

  // Use waitUntil if available to avoid blocking response
  if (cacheContext.waitUntil) {
    cacheContext.waitUntil(storePromise);
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

  // Include KV version in L1 key so a version bump (from cache purge)
  // automatically misses L1 on ALL isolates — not just the one that
  // handled the purge request. This eliminates the cross-isolate
  // staleness window that existed when L1 used unversioned keys.
  const l1Key = `${key}:v${cacheContext.kvVersion}`;

  // 1. Check L1 Cache (in-memory) - fastest
  const l1Cached = smartCache.get<T>(l1Key);
  if (l1Cached !== null) {
    return l1Cached;
  }

  // 2. Check if request is already in-flight (deduplication)
  // This prevents duplicate API calls when multiple components request simultaneously
  if (inflight.has(key)) {
    return inflight.get(key) as Promise<T | null>;
  }

  // 3. Create the fetch promise with L2 check and backend fallback
  const promise = (async (): Promise<T | null> => {
    try {
      // 3a. Check L2 Cache (Cloudflare Cache API) - survives cold starts
      const l2Cached = await getFromL2<T>(key);
      if (l2Cached !== null) {
        // Populate L1 from L2 for faster subsequent requests
        smartCache.set(l1Key, l2Cached, ttlSeconds);
        return l2Cached;
      }

      // 3b. Fetch from backend (cache miss on both layers)
      const data = await fetcher();

      if (data !== null) {
        // Store in L1 (fast access for this request lifecycle)
        smartCache.set(l1Key, data, ttlSeconds);

        // Store in L2 (survives cold starts)
        storeInL2(key, data, ttlSeconds);
      }

      return data;
    } catch (error) {
      console.error(`[EdgeCache] Fetch failed for ${key}:`, error);
      return null;
    } finally {
      // Clean up inflight map after request completes (success or failure)
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
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
  inflight.clear(); // Also clear any pending requests
}

/**
 * Selectively clears L1 (in-memory) cache entries matching given prefixes.
 * Called by /api/purge-cache for targeted invalidation.
 *
 * Note: L1 keys include the KV version suffix (e.g., "product_slug_foo:v42"),
 * but prefix matching still works because the prefix comes first.
 */
export function clearL1ByPrefixes(prefixes: string[]): void {
  smartCache.deleteByPrefixes(prefixes);
  // Also clear inflight requests that might be using stale data
  inflight.clear();
}

export const CACHE_TTL = {
  LONG: 86400,   // 24h - static data (layout, categories, etc.)
  MEDIUM: 3600,  // 1h  - semi-dynamic (product listings)
  SHORT: 300,    // 5m  - dynamic (CSP settings, checkout config)
} as const;
