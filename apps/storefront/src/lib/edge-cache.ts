/**
 * Deduplicate identical backend reads within one SSR request. Persistent public
 * caching belongs to the native Worker entrypoints; in-flight I/O must never be
 * retained at module scope because Workers can serve concurrent requests from
 * the same isolate.
 */

import { apiContext } from "./api/context";

interface EdgeCacheOptions {
  ttlSeconds?: number;
}

export async function withEdgeCache<T>(
  key: string,
  fetcher: () => Promise<T | null>,
  _options: EdgeCacheOptions = {},
): Promise<T | null> {
  const inflight = apiContext.getStore()?.inflightReads;
  const existing = inflight?.get(key);
  if (existing) return existing as Promise<T | null>;

  const request = fetcher()
    .catch((error: unknown) => {
      console.error(`[StorefrontData] Fetch failed for ${key}:`, error);
      return null;
    })
    .finally(() => {
      inflight?.delete(key);
    });
  inflight?.set(key, request);
  return request;
}

export const CACHE_TTL = {
  // Native domain purges own freshness; the hour is a failure-only backstop.
  AVAILABILITY: 3_600,
  LONG: 86_400,
  MEDIUM: 3_600,
  SHORT: 300,
} as const;
