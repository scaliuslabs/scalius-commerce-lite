/**
 * In-memory layout cache. IMPORTANT: This cache is per-Worker-isolate.
 * Clearing this cache in the API worker does NOT clear it in the admin worker.
 * Each Worker isolate has its own independent cache instance.
 * Cache entries expire naturally on isolate restart or after TTL.
 *
 * Reduces DB round-trips on every admin page load.
 * TTL: 5 minutes (settings rarely change during a session).
 */
const LAYOUT_CACHE_TTL_MS = 5 * 60 * 1000;

type CacheEntry<T> = { value: T; expires: number };

const cache = new Map<string, CacheEntry<unknown>>();

function get<T>(key: string): T | null {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry || Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function set<T>(key: string, value: T): void {
  cache.set(key, {
    value,
    expires: Date.now() + LAYOUT_CACHE_TTL_MS,
  });
}

export const layoutCache = {
  get,
  set,
  /** Invalidate a specific key (only affects THIS Worker isolate) */
  invalidate: (key: string) => cache.delete(key),
  /**
   * Invalidate all entries. Call when settings are updated.
   *
   * WARNING: This only clears the cache in the current Worker isolate.
   * Other Workers (admin, storefront, API) retain their cached data
   * until their entries expire naturally (TTL) or the isolate restarts.
   */
  clear: () => {
    console.warn(
      "[layoutCache] clear() called — only affects this Worker isolate. " +
        "Other Workers retain their cached data until TTL expiry or isolate restart.",
    );
    cache.clear();
  },
};

export const CACHE_KEYS = {
  FIREBASE_CONFIG: "layout:firebase_config",
  STOREFRONT_URL: "layout:storefront_url",
} as const;
