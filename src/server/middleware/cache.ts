// src/server/middleware/cache.ts
import type { MiddlewareHandler } from "hono";
import { getCache, setCache, getCacheType } from "../utils/kv-cache";

// Default TTL in seconds (1 hour)
const DEFAULT_CACHE_TTL = 3600;

export interface CacheOptions {
  ttl?: number;
  keyPrefix?: string;
  cacheNullValues?: boolean;
  methods?: string[];
  varyByQuery?: boolean;
  varyByAuth?: boolean;
  cacheCondition?: (c: any) => boolean;
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
    varyByAuth = false,
    cacheCondition,
  } = options;

  return async (c, next) => {
    if (!methods.includes(c.req.method)) return next();
    if (cacheCondition && !cacheCondition(c)) return next();

    // KV namespace from Cloudflare Workers env binding
    const kv: KVNamespace | undefined = (c.env as any)?.CACHE;

    // Build cache key
    let cacheKey = `${keyPrefix}${c.req.path}`;

    if (varyByQuery && c.req.query()) {
      const qs = new URLSearchParams(c.req.query()).toString();
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

    // Try cache hit
    try {
      const cached = await getCache<{
        status: number;
        headers: Record<string, string>;
        body: string;
      }>(cacheKey, kv);

      if (cached) {
        const headers = new Headers(cached.headers);
        headers.set("X-Cache", "HIT");
        headers.set("X-Cache-Type", getCacheType(kv));
        if (!headers.has("Cache-Control")) {
          headers.set(
            "Cache-Control",
            `public, max-age=${Math.min(ttl, 300)}`,
          );
        }
        return new Response(cached.body, { status: cached.status, headers });
      }
    } catch (error) {
      console.error("[Cache] Error reading from cache:", error);
    }

    // Cache miss – add headers and execute handler
    c.header("X-Cache", "MISS");
    c.header("X-Cache-Type", getCacheType(kv));
    c.header("Cache-Control", `public, max-age=${Math.min(ttl, 300)}`);

    await next();

    const response = c.res;
    if (!response.ok) return;

    const cacheControl = response.headers.get("Cache-Control");
    if (cacheControl?.includes("no-store")) return;

    try {
      const cloned = response.clone();
      const body = await cloned.text();

      if (!body && !cacheNullValues) return;

      const headers: Record<string, string> = {};
      cloned.headers.forEach((value, key) => {
        headers[key] = value;
      });

      await setCache(cacheKey, { status: cloned.status, headers, body }, ttl, kv);
    } catch (error) {
      console.error("[Cache] Error writing to cache:", error);
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
