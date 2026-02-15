import type { MiddlewareHandler } from "hono";
import { getCache, setCache, getCacheType } from "../utils/redis";

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
 * Middleware for caching API responses in Redis or in-memory fallback
 *
 * @param options Cache options
 * @returns Hono middleware handler
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
    // Only cache specified HTTP methods
    if (!methods.includes(c.req.method)) {
      return next();
    }

    // Skip caching if condition is provided and returns false
    if (cacheCondition && !cacheCondition(c)) {
      return next();
    }

    // Generate cache key
    let cacheKey = `${keyPrefix}${c.req.path}`;

    // Add query parameters to cache key if enabled
    if (varyByQuery && c.req.query()) {
      const queryString = new URLSearchParams(c.req.query()).toString();
      if (queryString) {
        cacheKey += `?${queryString}`;
      }
    }

    // Add auth token to cache key if enabled
    if (varyByAuth) {
      const authHeader = c.req.header("Authorization") || "";
      if (authHeader) {
        // Use a fast simple hash to avoid expensive SHA-256 on every request
        let hash = 0;
        for (let i = 0; i < authHeader.length; i++) {
          const char = authHeader.charCodeAt(i);
          hash = ((hash << 5) - hash + char) | 0;
        }
        cacheKey += `:auth:${(hash >>> 0).toString(36)}`;
      } else {
        cacheKey += ":auth:none";
      }
    }

    // Try to get from cache
    try {
      const cachedResponse = await getCache<{
        status: number;
        headers: Record<string, string>;
        body: string;
      }>(cacheKey);

      if (cachedResponse) {
        // Add cache hit header
        const headers = new Headers(cachedResponse.headers);
        headers.set("X-Cache", "HIT");
        headers.set("X-Cache-Type", getCacheType());

        // Add Cache-Control header for browser caching
        if (!headers.has("Cache-Control")) {
          headers.set("Cache-Control", `public, max-age=${Math.min(ttl, 300)}`);
        }

        // Return cached response
        return new Response(cachedResponse.body, {
          status: cachedResponse.status,
          headers,
        });
      }
    } catch (error) {
      console.error("Error retrieving from cache:", error);
      // Continue without cache on error
    }

    // Add cache miss header
    c.header("X-Cache", "MISS");
    c.header("X-Cache-Type", getCacheType());

    // Add Cache-Control header for browser caching
    c.header("Cache-Control", `public, max-age=${Math.min(ttl, 300)}`);

    // Execute the request
    await next();

    // Get the response
    const response = c.res;

    // Don't cache if response is not ok
    if (!response.ok) {
      return;
    }

    // Don't cache if response has no-store cache-control
    const cacheControl = response.headers.get("Cache-Control");
    if (cacheControl && cacheControl.includes("no-store")) {
      return;
    }

    try {
      // Clone the response to avoid consuming it
      const clonedResponse = response.clone();

      // Get response body as text
      const body = await clonedResponse.text();

      // Don't cache empty responses unless explicitly allowed
      if (!body && !cacheNullValues) {
        return;
      }

      // Convert headers to a plain object
      const headers: Record<string, string> = {};
      clonedResponse.headers.forEach((value, key) => {
        headers[key] = value;
      });

      // Store in cache (will automatically fallback to in-memory if Redis unavailable)
      await setCache(
        cacheKey,
        {
          status: clonedResponse.status,
          headers,
          body,
        },
        ttl,
      );
    } catch (error) {
      console.error("Error caching response:", error);
      // Continue execution even if caching fails
    }
  };
};

/**
 * Helper function to create a cache key for a specific resource
 *
 * @param prefix Resource prefix (e.g., 'products')
 * @param id Resource ID or slug
 * @returns Cache key
 */
export function createResourceCacheKey(prefix: string, id: string): string {
  return `api:${prefix}:${id}`;
}

/**
 * Helper function to create a cache key pattern for a resource type
 *
 * @param prefix Resource prefix (e.g., 'products')
 * @returns Cache key pattern
 */
export function createResourceCachePattern(prefix: string): string {
  return `api:${prefix}:*`;
}
