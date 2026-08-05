// Cloudflare KV cache helpers. Every runtime call receives the current
// request's binding; there is intentionally no process-local fallback.

const MIN_KV_TTL = 60;
const DEFAULT_CACHE_TTL = 3600;
const PROJECT_PREFIX = "sc";

export function toProjectCacheKey(key: string): string {
  return `${PROJECT_PREFIX}:${key}`;
}

export async function setCache(
  key: string,
  value: unknown,
  ttl: number = DEFAULT_CACHE_TTL,
  kv: KVNamespace,
): Promise<void> {
  const fullKey = toProjectCacheKey(key);
  try {
    await kv.put(fullKey, JSON.stringify(value), {
      expirationTtl: Math.max(MIN_KV_TTL, ttl),
    });
  } catch (error: unknown) {
    console.error(`[KV] setCache error for key "${fullKey}":`, error);
    throw error;
  }
}

export async function getCache<T>(
  key: string,
  kv: KVNamespace,
): Promise<T | null> {
  const fullKey = toProjectCacheKey(key);
  try {
    const raw = await kv.get(fullKey);
    return raw ? JSON.parse(raw) as T : null;
  } catch (error: unknown) {
    console.error(`[KV] getCache error for key "${fullKey}":`, error);
    throw error;
  }
}

export async function getCacheStats(_kv: KVNamespace): Promise<{
  size: number;
  memory: string;
  uptime: string;
  cacheType: "kv";
}> {
  return {
    size: -1,
    memory: "N/A (Cloudflare KV managed)",
    uptime: "N/A (Cloudflare KV managed)",
    cacheType: "kv",
  };
}

export function getCacheType(_kv: KVNamespace): "kv" {
  return "kv";
}
