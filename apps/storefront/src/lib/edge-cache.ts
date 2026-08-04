/**
 * Deduplicate identical backend reads within one Worker isolate while an SSR
 * render is in flight. Persistent public caching belongs to the native Worker
 * entrypoints; this helper never retains data after the fetch settles.
 */

interface EdgeCacheOptions {
  ttlSeconds?: number;
}

const inflight = new Map<string, Promise<unknown>>();

export async function withEdgeCache<T>(
  key: string,
  fetcher: () => Promise<T | null>,
  _options: EdgeCacheOptions = {},
): Promise<T | null> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T | null>;

  const request = fetcher()
    .catch((error: unknown) => {
      console.error(`[StorefrontData] Fetch failed for ${key}:`, error);
      return null;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, request);
  return request;
}

export const CACHE_TTL = {
  // Native domain purges own freshness; the hour is a failure-only backstop.
  AVAILABILITY: 3_600,
  LONG: 86_400,
  MEDIUM: 3_600,
  SHORT: 300,
} as const;
