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

/**
 * Worker version metadata (`"version_metadata": { "binding":
 * "CF_VERSION_METADATA" }` in each Worker's Wrangler config).
 *
 * The generation says when the store's data changed; the Worker version says
 * which code rendered a cached response. Every public API and storefront
 * cache key carries both, so a cached response never outlives the code that
 * produced it: a deploy (or a restart or reload of `wrangler dev`, which
 * assigns a fresh id every time) starts from an empty cache, with no purge
 * and no generation bump. The id is the same in every isolate of a version,
 * so entries are still shared across isolates and requests.
 */
export interface WorkerVersionMetadataEnv {
  CF_VERSION_METADATA?: { id?: unknown } | null;
}

const WORKER_VERSION_PATTERN = /^[0-9A-Za-z-]{1,64}$/;

/**
 * The running Worker version id, or `null` when the binding is missing (then
 * nothing is cached: an unversioned key could serve another build's payload).
 */
export function readWorkerVersion(env: WorkerVersionMetadataEnv | null | undefined): string | null {
  const id = env?.CF_VERSION_METADATA?.id;
  return typeof id === "string" && WORKER_VERSION_PATTERN.test(id) ? id : null;
}
