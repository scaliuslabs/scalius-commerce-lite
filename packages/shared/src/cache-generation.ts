/**
 * Public cache generation shared by the API and storefront Workers.
 *
 * The store has one cache generation: an opaque random token stored in the
 * relational database (`cache_generation`) and mirrored to the `CACHE` KV
 * namespace. Every buyer-visible write replaces it, and every public API and
 * storefront cache key includes it, so a write makes the old entries
 * unreachable instead of purging them. Old entries simply age out.
 *
 * The token is random, not a counter: nobody can pre-seed a cache entry for a
 * future generation, and a database restore never re-activates old entries.
 */

/** KV key in the `CACHE` namespace that mirrors the database generation. */
export const CACHE_GENERATION_KV_KEY = "cache:generation";

/**
 * Header the storefront sets on its API sub-requests so an HTML page and the
 * API responses it is built from use the same generation, even while KV
 * propagation is still in flight.
 */
export const CACHE_GENERATION_HEADER = "X-Scalius-Cache-Generation";

/** KV edge cache for generation reads; 30 s is the KV minimum. */
export const CACHE_GENERATION_READ_TTL_SECONDS = 30;

/**
 * Edge lifetime of any generation-keyed public response. Freshness comes from
 * the generation; this ceiling only bounds a missed write to one day.
 */
export const PUBLIC_CACHE_MAX_AGE_SECONDS = 86_400;

const GENERATION_PATTERN = /^[0-9a-z]{1,32}$/;

interface CacheGenerationKv {
  get(key: string, options: { cacheTtl: number }): Promise<string | null>;
}

export function normalizeCacheGeneration(value: unknown): string | null {
  return typeof value === "string" && GENERATION_PATTERN.test(value) ? value : null;
}

/** A new unguessable generation token (64 random bits, hex). */
export function createCacheGeneration(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The mirrored generation, or `null` when KV is missing, empty, or failing. */
export async function readCacheGenerationHint(
  kv: CacheGenerationKv | null | undefined,
): Promise<string | null> {
  if (!kv) return null;
  try {
    return normalizeCacheGeneration(
      await kv.get(CACHE_GENERATION_KV_KEY, {
        cacheTtl: CACHE_GENERATION_READ_TTL_SECONDS,
      }),
    );
  } catch {
    return null;
  }
}
