// Public cache freshness: one store-wide cache generation.
//
// Every public API and storefront cache key includes the generation (see
// @scalius/shared/cache-generation). A buyer-visible write calls
// `bumpCacheGeneration(c)` after it commits; that replaces the token in the
// database and mirrors it to KV, so every old cache entry becomes unreachable.
// There are no purges, tags, warm-ups, or retry queues. Stock writes bump only
// when an availability band changes (availability-transitions.ts), so public
// stock stays band-only.
import { getDb, type Database } from "@scalius/database/client";
import { cacheGeneration } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import {
  CACHE_GENERATION_KV_KEY,
  createCacheGeneration,
  normalizeCacheGeneration,
  readCacheGenerationHint,
} from "@scalius/shared/cache-generation";

export type WaitUntilExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

export interface CacheWriteContext {
  env?: Env;
  executionCtx?: WaitUntilExecutionContext;
}

/** Generation of a store that has never had a buyer-visible write. */
const INITIAL_CACHE_GENERATION = "0";
const MIRROR_PASSES = 3;
/** KV accepts one write per second per key. */
const MIRROR_RETRY_DELAY_MS = 1_100;

export function hasDatabaseConfiguration(env?: Env): env is Env {
  if (!env) return false;
  if (env.DB || env.HYPERDRIVE) return true;
  if (
    typeof env.TURSO_DATABASE_URL === "string"
    && env.TURSO_DATABASE_URL.trim()
    && typeof env.TURSO_AUTH_TOKEN === "string"
    && env.TURSO_AUTH_TOKEN.trim()
  ) {
    return true;
  }
  return typeof env.POSTGRES_DATABASE_URL === "string"
    && Boolean(env.POSTGRES_DATABASE_URL.trim());
}

export function getOptionalExecutionContext(c: {
  executionCtx?: WaitUntilExecutionContext;
}): WaitUntilExecutionContext | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

async function readStoredCacheGeneration(db: Database): Promise<string> {
  const [row] = await db
    .select({ generation: cacheGeneration.generation })
    .from(cacheGeneration)
    .where(eq(cacheGeneration.id, "default"))
    .all();
  return normalizeCacheGeneration(row?.generation) ?? INITIAL_CACHE_GENERATION;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Copies the database generation to KV. Concurrent bumps coalesce: each pass
 * re-reads the database, and a pass that finds the value it last wrote stops.
 * A write rejected by the one-write-per-second limit, or overtaken by an older
 * mirror, is corrected on the next pass. The scheduled sync is the backstop.
 */
export async function mirrorCacheGeneration(
  env: Env,
  db: Database,
  { retryDelayMs = MIRROR_RETRY_DELAY_MS }: { retryDelayMs?: number } = {},
): Promise<void> {
  let written: string | null = null;
  let lastError: unknown;
  for (let pass = 0; pass < MIRROR_PASSES; pass += 1) {
    if (pass > 0) await sleep(retryDelayMs);
    try {
      const generation = await readStoredCacheGeneration(db);
      if (generation === written) return;
      await env.CACHE.put(CACHE_GENERATION_KV_KEY, generation);
      written = generation;
    } catch (error) {
      lastError = error;
    }
  }
  if (written === null) {
    console.error("[Cache] Generation mirror failed; the scheduled sync retries:", lastError);
  }
}

/**
 * Makes every public cache entry stale after a committed buyer-visible write.
 * Never throws: the write already succeeded, and the one-day cache ceiling
 * bounds a missed bump.
 */
export async function bumpCacheGeneration(c: CacheWriteContext): Promise<void> {
  const env = c.env;
  if (!hasDatabaseConfiguration(env)) return;
  try {
    const db = getDb(env);
    const generation = createCacheGeneration();
    const updatedAt = Math.floor(Date.now() / 1000);
    await db.insert(cacheGeneration)
      .values({ id: "default", generation, updatedAt })
      .onConflictDoUpdate({
        target: cacheGeneration.id,
        set: { generation, updatedAt },
      })
      .run();
    const mirror = mirrorCacheGeneration(env, db);
    const executionCtx = getOptionalExecutionContext(c);
    if (executionCtx) executionCtx.waitUntil(mirror);
    else await mirror;
  } catch (error) {
    console.error("[Cache] Failed to advance the public cache generation:", error);
  }
}

/**
 * The generation for a public cache key: the KV mirror, else the database
 * (re-mirrored in the background). `null` means serve uncached.
 */
export async function readCacheGeneration(
  env: Env,
  executionCtx?: WaitUntilExecutionContext,
): Promise<string | null> {
  const mirrored = await readCacheGenerationHint(env.CACHE);
  if (mirrored) return mirrored;
  if (!hasDatabaseConfiguration(env)) return null;
  try {
    const generation = await readStoredCacheGeneration(getDb(env));
    const put = env.CACHE?.put(CACHE_GENERATION_KV_KEY, generation)
      .catch(() => undefined);
    if (put) executionCtx?.waitUntil(put);
    return generation;
  } catch (error) {
    console.error("[Cache] Generation read failed; serving uncached:", error);
    return null;
  }
}

/** Scheduled backstop: repairs a KV mirror that every bump pass missed. */
export async function syncCacheGenerationMirror(
  env: Env,
  db: Database,
): Promise<boolean> {
  const [stored, mirrored] = await Promise.all([
    readStoredCacheGeneration(db),
    readCacheGenerationHint(env.CACHE),
  ]);
  if (stored === mirrored) return false;
  await env.CACHE.put(CACHE_GENERATION_KV_KEY, stored);
  return true;
}
