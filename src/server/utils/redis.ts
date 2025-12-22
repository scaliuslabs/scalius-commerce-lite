import { Redis } from "@upstash/redis";

// Get environment variables from the appropriate source
function getEnv() {
  // In Cloudflare Workers, env will be passed via context
  // In local development, use process.env
  if (typeof process !== "undefined" && process.env) {
    return process.env;
  }

  // For Cloudflare Workers, this will be handled by middleware
  throw new Error(
    "Environment variables not available - should be provided by runtime context",
  );
}

// Initialize environment variables
let env: any;
try {
  env = getEnv();
} catch (error) {
  // Will be null in Cloudflare Workers context - handled by middleware
  env = {};
}

// Default TTL in seconds (1 hour)
const DEFAULT_CACHE_TTL = parseInt(env.REDIS_CACHE_TTL || "3600", 10);

// Project-specific prefix for all cache keys to ensure multi-tenancy
const PROJECT_PREFIX = env.PROJECT_CACHE_PREFIX || "default_project";

// In-memory cache fallback
interface CacheEntry {
  value: any;
  expiry: number;
}

class InMemoryCache {
  private cache = new Map<string, CacheEntry>();
  private maxSize = 1000; // Limit memory usage

  set(key: string, value: any, ttl: number): void {
    // Clean up expired entries if cache is getting large
    if (this.cache.size >= this.maxSize) {
      this.cleanup();
    }

    const expiry = ttl > 0 ? Date.now() + ttl * 1000 : 0;
    this.cache.set(key, { value, expiry });
  }

  get(key: string): any | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    // Check if expired
    if (entry.expiry > 0 && Date.now() > entry.expiry) {
      this.cache.delete(key);
      return null;
    }

    return entry.value;
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  deleteByPattern(pattern: string): void {
    const regex = new RegExp(pattern.replace(/\*/g, ".*"));
    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.cache.delete(key);
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiry > 0 && now > entry.expiry) {
        this.cache.delete(key);
      }
    }
  }

  getStats(): { size: number; memory: string; uptime: string } {
    this.cleanup(); // Clean before getting stats
    return {
      size: this.cache.size,
      memory: `${Math.round(JSON.stringify([...this.cache.entries()]).length / 1024)}KB`,
      uptime: "N/A (in-memory)",
    };
  }
}

// Create in-memory cache instance
const memoryCache = new InMemoryCache();

// Helper function to get a fully prefixed key
function getProjectPrefixedKey(key: string): string {
  return `${PROJECT_PREFIX}:${key}`;
}

// Helper function to get a fully prefixed pattern
function getProjectPrefixedPattern(pattern: string): string {
  return `${PROJECT_PREFIX}:${pattern}`;
}

// Redis client state
let redisClient: Redis | null = null;
let redisAvailable = false;

// Store the configuration used for initialization to detect changes
let initializedConfig: { url: string; token: string } | null = null;

// Initialize Redis client with environment variables
function initializeRedis(environment?: any): void {
  const envToUse = environment || env;
  const redisUrl =
    envToUse.UPSTASH_REDIS_REST_URL ||
    envToUse.UPSTASH_REDIS_URL ||
    envToUse.REDIS_URL;
  const redisToken =
    envToUse.UPSTASH_REDIS_REST_TOKEN || envToUse.UPSTASH_REDIS_TOKEN;

  // Check if we are already initialized with the same configuration
  if (
    redisClient &&
    initializedConfig &&
    initializedConfig.url === redisUrl &&
    initializedConfig.token === redisToken
  ) {
    return; // Already initialized with same config
  }

  if (!redisUrl || redisUrl.trim() === "") {
    console.log("Redis URL not provided. Using in-memory cache fallback.");
    redisAvailable = false;
    return;
  }

  if (!redisToken || redisToken.trim() === "") {
    console.log("Redis token not provided. Using in-memory cache fallback.");
    redisAvailable = false;
    return;
  }

  try {
    redisClient = new Redis({
      url: redisUrl,
      token: redisToken,
    });

    // Store config for future checks
    initializedConfig = { url: redisUrl, token: redisToken };

    // Assume Redis is available after successful client creation
    // Errors will be handled gracefully per-request with in-memory fallback
    // This avoids blocking cold start with a ping test
    redisAvailable = true;
  } catch (error) {
    console.warn(
      "Failed to initialize Redis client, using in-memory cache:",
      error,
    );
    redisAvailable = false;
    redisClient = null;
    initializedConfig = null;
  }
}

// Initialize Redis on module load (for local development)
if (env.UPSTASH_REDIS_REST_URL || env.UPSTASH_REDIS_URL || env.REDIS_URL) {
  initializeRedis();
}

// Export function to initialize Redis with specific environment (for Cloudflare Workers)
export function initializeRedisWithEnv(environment: any): void {
  initializeRedis(environment);
}

/**
 * Set a value in the cache
 * @param key Cache key
 * @param value Value to cache (will be JSON stringified)
 * @param ttl Time to live in seconds (optional, defaults to 1 hour)
 */
export async function setCache(
  key: string,
  value: any,
  ttl: number = DEFAULT_CACHE_TTL,
): Promise<void> {
  const prefixedKey = getProjectPrefixedKey(key);

  try {
    if (redisAvailable && redisClient) {
      const serializedValue = JSON.stringify(value);
      if (ttl <= 0) {
        await redisClient.set(prefixedKey, serializedValue);
      } else {
        await redisClient.set(prefixedKey, serializedValue, { ex: ttl });
      }
    } else {
      // Fallback to in-memory cache
      memoryCache.set(prefixedKey, value, ttl);
    }
  } catch (error) {
    console.error(`Error setting cache for key ${prefixedKey}:`, error);
    // Fallback to in-memory cache on Redis error
    try {
      memoryCache.set(prefixedKey, value, ttl);
    } catch (memError) {
      console.error(
        `Error setting in-memory cache for key ${prefixedKey}:`,
        memError,
      );
    }
  }
}

/**
 * Get a value from the cache
 * @param key Cache key
 * @returns The cached value or null if not found
 */
export async function getCache<T>(key: string): Promise<T | null> {
  const prefixedKey = getProjectPrefixedKey(key);

  try {
    if (redisAvailable && redisClient) {
      const cachedValue = await redisClient.get(prefixedKey);
      if (!cachedValue) return null;

      // Upstash Redis may return the value already parsed in some cases
      if (typeof cachedValue === "string") {
        return JSON.parse(cachedValue) as T;
      }
      return cachedValue as T;
    } else {
      // Fallback to in-memory cache
      return memoryCache.get(prefixedKey) as T | null;
    }
  } catch (error) {
    console.error(`Error getting cache for key ${prefixedKey}:`, error);
    // Fallback to in-memory cache on Redis error
    try {
      return memoryCache.get(prefixedKey) as T | null;
    } catch (memError) {
      console.error(
        `Error getting in-memory cache for key ${prefixedKey}:`,
        memError,
      );
      return null;
    }
  }
}

/**
 * Delete a value from the cache
 * @param key Cache key
 */
export async function deleteCache(key: string): Promise<void> {
  const prefixedKey = getProjectPrefixedKey(key);

  try {
    if (redisAvailable && redisClient) {
      await redisClient.del(prefixedKey);
    } else {
      // Fallback to in-memory cache
      memoryCache.delete(prefixedKey);
    }
  } catch (error) {
    console.error(`Error deleting cache for key ${prefixedKey}:`, error);
    // Fallback to in-memory cache on Redis error
    try {
      memoryCache.delete(prefixedKey);
    } catch (memError) {
      console.error(
        `Error deleting in-memory cache for key ${prefixedKey}:`,
        memError,
      );
    }
  }
}

/**
 * Delete multiple values from the cache using a pattern (uses SCAN)
 * @param pattern Pattern to match keys (e.g., "products:*")
 */
export async function deleteCacheByPattern(pattern: string): Promise<void> {
  const prefixedPattern = getProjectPrefixedPattern(pattern);

  try {
    if (redisAvailable && redisClient) {
      let cursor: string | number = 0;
      const keysToDelete: string[] = [];
      const scanCount = 100;

      do {
        const result: [string | number, string[]] = await redisClient.scan(
          cursor,
          {
            match: prefixedPattern,
            count: scanCount,
          },
        );

        // Upstash Redis scan returns [nextCursor, keys]
        const [nextCursor, keys]: [string | number, string[]] = result;
        keysToDelete.push(...keys);
        cursor = nextCursor;
      } while (cursor !== 0 && cursor !== "0");

      if (keysToDelete.length > 0) {
        // Delete in batches to avoid too many keys in one command
        const batchSize = 100;
        for (let i = 0; i < keysToDelete.length; i += batchSize) {
          const batch = keysToDelete.slice(i, i + batchSize);
          await redisClient.del(...batch);
        }
        console.log(
          `Deleted ${keysToDelete.length} cache entries matching pattern: ${prefixedPattern}`,
        );
      }
    } else {
      // Fallback to in-memory cache
      memoryCache.deleteByPattern(prefixedPattern);
      console.log(
        `Deleted in-memory cache entries matching pattern: ${prefixedPattern}`,
      );
    }
  } catch (error) {
    console.error(`Error deleting cache by pattern ${prefixedPattern}:`, error);
    // Fallback to in-memory cache on Redis error
    try {
      memoryCache.deleteByPattern(prefixedPattern);
      console.log(
        `Fallback: Deleted in-memory cache entries matching pattern: ${prefixedPattern}`,
      );
    } catch (memError) {
      console.error(
        `Error deleting in-memory cache by pattern ${prefixedPattern}:`,
        memError,
      );
    }
  }
}

/**
 * Get cache statistics
 * @returns Object with cache statistics
 */
export async function getCacheStats(): Promise<{
  size: number;
  memory: string;
  hitRate?: string;
  missRate?: string;
  uptime: string;
  cacheType: "redis" | "memory";
}> {
  try {
    if (redisAvailable && redisClient) {
      // Upstash Redis doesn't have the same INFO command as regular Redis
      // We'll provide basic stats
      const dbSize = await redisClient.dbsize();

      return {
        size: dbSize,
        memory: "N/A (Upstash managed)",
        uptime: "N/A (Upstash managed)",
        cacheType: "redis",
      };
    } else {
      // Fallback to in-memory cache stats
      const memStats = memoryCache.getStats();
      return {
        ...memStats,
        cacheType: "memory",
      };
    }
  } catch (error) {
    console.error("Error getting cache stats:", error);
    // Return in-memory cache stats as fallback
    const memStats = memoryCache.getStats();
    return {
      ...memStats,
      cacheType: "memory",
    };
  }
}

/**
 * Check if Redis is available
 * @returns boolean indicating Redis availability
 */
export function isRedisAvailable(): boolean {
  return redisAvailable;
}

/**
 * Get cache type being used
 * @returns "redis" or "memory"
 */
export function getCacheType(): "redis" | "memory" {
  return redisAvailable ? "redis" : "memory";
}

export default redisClient;
