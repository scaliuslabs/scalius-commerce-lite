// src/server/utils/kv-cache.ts
// Cloudflare KV cache – replaces Upstash Redis

// Minimum TTL enforced by KV (60 s). Values below this are clamped.
const MIN_KV_TTL = 60;
// Default cache TTL (1 hour)
const DEFAULT_CACHE_TTL = 3600;

// Short project prefix to namespace all keys inside the shared KV namespace.
// Change this if you run multiple projects in the same KV namespace.
const PROJECT_PREFIX =
  typeof process !== "undefined"
    ? process.env.PROJECT_CACHE_PREFIX || "sc"
    : "sc";

// ---------------------------------------------------------------------------
// In-memory fallback for local dev without `wrangler dev`
// ---------------------------------------------------------------------------
interface CacheEntry {
  value: unknown;
  expiry: number; // epoch ms, 0 = no expiry
}

class InMemoryCache {
  private cache = new Map<string, CacheEntry>();
  private readonly maxSize = 5000;

  set(key: string, value: unknown, ttl: number): void {
    if (this.cache.size >= this.maxSize) this.cleanup();
    const expiry = ttl > 0 ? Date.now() + ttl * 1000 : 0;
    this.cache.set(key, { value, expiry });
  }

  get(key: string): unknown | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiry > 0 && Date.now() > entry.expiry) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  deleteByPrefix(prefix: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }

  stats(): { size: number; memory: string } {
    this.cleanup();
    return {
      size: this.cache.size,
      memory: `${Math.round(JSON.stringify([...this.cache.entries()]).length / 1024)}KB`,
    };
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiry > 0 && now > entry.expiry) this.cache.delete(key);
    }
  }
}

const memCache = new InMemoryCache();

// ---------------------------------------------------------------------------
// Module-level KV binding – initialised once per isolate from middleware
// ---------------------------------------------------------------------------
let _kv: KVNamespace | undefined;

/** Called by middleware to register the KV binding for this isolate. */
export function initKv(kv: KVNamespace): void {
  _kv = kv;
}

/** Returns the registered KV binding (may be undefined in local dev). */
export function getKv(): KVNamespace | undefined {
  return _kv;
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------
function prefixedKey(key: string): string {
  return `${PROJECT_PREFIX}:${key}`;
}

// For pattern-based deletion we strip the trailing wildcard and treat it as a
// KV list prefix (KV list is always prefix-based, not glob).
function patternToPrefix(pattern: string): string {
  return prefixedKey(pattern.replace(/\*$/, ""));
}

// ---------------------------------------------------------------------------
// Cache API
// ---------------------------------------------------------------------------

/**
 * Store a value in the cache.
 * @param key    Cache key (will be automatically prefixed)
 * @param value  JSON-serialisable value
 * @param ttl    TTL in seconds (default 1 h; min 60 s for KV)
 * @param kv     Optional KV binding override; falls back to module-level binding
 */
export async function setCache(
  key: string,
  value: unknown,
  ttl: number = DEFAULT_CACHE_TTL,
  kv?: KVNamespace,
): Promise<void> {
  const ns = kv ?? _kv;
  const fullKey = prefixedKey(key);

  if (ns) {
    try {
      const expirationTtl = Math.max(MIN_KV_TTL, ttl);
      await ns.put(fullKey, JSON.stringify(value), { expirationTtl });
    } catch (err) {
      console.error(`[KV] setCache error for key "${fullKey}":`, err);
      memCache.set(fullKey, value, ttl);
    }
  } else {
    memCache.set(fullKey, value, ttl);
  }
}

/**
 * Retrieve a value from the cache.
 * Returns `null` on miss or error.
 */
export async function getCache<T>(
  key: string,
  kv?: KVNamespace,
): Promise<T | null> {
  const ns = kv ?? _kv;
  const fullKey = prefixedKey(key);

  if (ns) {
    try {
      const raw = await ns.get(fullKey);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch (err) {
      console.error(`[KV] getCache error for key "${fullKey}":`, err);
      return memCache.get(fullKey) as T | null;
    }
  } else {
    return memCache.get(fullKey) as T | null;
  }
}

/**
 * Delete a single cache entry.
 */
export async function deleteCache(
  key: string,
  kv?: KVNamespace,
): Promise<void> {
  const ns = kv ?? _kv;
  const fullKey = prefixedKey(key);

  if (ns) {
    try {
      await ns.delete(fullKey);
    } catch (err) {
      console.error(`[KV] deleteCache error for key "${fullKey}":`, err);
      memCache.delete(fullKey);
    }
  } else {
    memCache.delete(fullKey);
  }
}

/**
 * Delete all cache entries whose key starts with the given prefix pattern.
 * Use `"api:products:*"` to delete all product cache entries, or `"*"` for all.
 *
 * Note: KV does not support glob matching. The trailing `*` is stripped and
 * the remainder is used as a KV list prefix.
 */
export async function deleteCacheByPattern(
  pattern: string,
  kv?: KVNamespace,
): Promise<void> {
  const ns = kv ?? _kv;
  const prefix = patternToPrefix(pattern);

  if (ns) {
    try {
      // Paginate through all keys with the given prefix
      const keysToDelete: string[] = [];
      let cursor: string | undefined;

      do {
        const result: KVNamespaceListResult<unknown, string> = await ns.list({
          prefix,
          ...(cursor ? { cursor } : {}),
        });

        for (const k of result.keys) keysToDelete.push(k.name);

        cursor = result.list_complete ? undefined : (result as any).cursor;
      } while (cursor);

      if (keysToDelete.length > 0) {
        await Promise.all(keysToDelete.map((k) => ns.delete(k)));
        console.log(
          `[KV] Deleted ${keysToDelete.length} entries matching prefix "${prefix}"`,
        );
      }
    } catch (err) {
      console.error(
        `[KV] deleteCacheByPattern error for prefix "${prefix}":`,
        err,
      );
      memCache.deleteByPrefix(prefix);
    }
  } else {
    memCache.deleteByPrefix(prefix);
    console.log(`[MemCache] Deleted entries with prefix "${prefix}"`);
  }
}

/**
 * Get cache statistics.
 */
export async function getCacheStats(kv?: KVNamespace): Promise<{
  size: number;
  memory: string;
  uptime: string;
  cacheType: "kv" | "memory";
}> {
  const ns = kv ?? _kv;

  if (ns) {
    return {
      size: -1, // KV does not expose a count endpoint
      memory: "N/A (Cloudflare KV managed)",
      uptime: "N/A (Cloudflare KV managed)",
      cacheType: "kv",
    };
  }

  const stats = memCache.stats();
  return { ...stats, uptime: "N/A (in-memory)", cacheType: "memory" };
}

/** Returns whether a KV namespace is available. */
export function isKvAvailable(kv?: KVNamespace): boolean {
  return !!(kv ?? _kv);
}

/** Returns the cache backend type currently in use. */
export function getCacheType(kv?: KVNamespace): "kv" | "memory" {
  return isKvAvailable(kv) ? "kv" : "memory";
}
