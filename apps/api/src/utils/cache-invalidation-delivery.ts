import { safeBatch, type Database } from "@scalius/database/client";
import { cacheInvalidationState } from "@scalius/database/schema";
import { and, eq, gt, gte, inArray, lt, sql } from "drizzle-orm";

export const CACHE_INVALIDATION_SWEEP_LIMIT = 20;

export interface CacheInvalidationGeneration {
  group: string;
  generation: number;
}

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

/** Advance one coalesced, monotonic generation per cache domain. */
export async function recordCacheInvalidationRequest(
  db: Database,
  groups: readonly string[],
): Promise<CacheInvalidationGeneration[]> {
  const normalizedGroups = [...new Set(groups)];
  if (normalizedGroups.length === 0) return [];
  const now = Math.floor(Date.now() / 1000);

  await db.insert(cacheInvalidationState)
    .values(normalizedGroups.map((group) => ({
      group,
      requestedGeneration: 1,
      appliedGeneration: 0,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    })))
    .onConflictDoUpdate({
      target: cacheInvalidationState.group,
      set: {
        requestedGeneration: sql`${cacheInvalidationState.requestedGeneration} + 1`,
        lastError: null,
        updatedAt: now,
      },
    })
    .run();

  return db.select({
    group: cacheInvalidationState.group,
    generation: cacheInvalidationState.requestedGeneration,
  })
    .from(cacheInvalidationState)
    .where(inArray(cacheInvalidationState.group, normalizedGroups))
    .all();
}

export async function readPendingCacheInvalidations(
  db: Database,
  limit: number,
): Promise<CacheInvalidationGeneration[]> {
  const boundedLimit = Math.max(
    1,
    Math.min(CACHE_INVALIDATION_SWEEP_LIMIT, Math.floor(limit)),
  );
  return db.select({
    group: cacheInvalidationState.group,
    generation: cacheInvalidationState.requestedGeneration,
  })
    .from(cacheInvalidationState)
    .where(gt(
      cacheInvalidationState.requestedGeneration,
      cacheInvalidationState.appliedGeneration,
    ))
    .limit(boundedLimit)
    .all();
}

export async function markCacheInvalidationsApplied(
  db: Database,
  generations: readonly CacheInvalidationGeneration[],
): Promise<void> {
  if (generations.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  const statements = generations.map((item) => db.update(cacheInvalidationState)
      .set({
        appliedGeneration: item.generation,
        attemptCount: 0,
        lastError: null,
        appliedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(cacheInvalidationState.group, item.group),
        gte(cacheInvalidationState.requestedGeneration, item.generation),
        lt(cacheInvalidationState.appliedGeneration, item.generation),
      )));
  await safeBatch(db, statements);
}

export async function markCacheInvalidationsFailed(
  db: Database,
  generations: readonly CacheInvalidationGeneration[],
  reason: "api" | "storefront" | "api_and_storefront",
): Promise<void> {
  if (generations.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  const statements = generations.map((item) => db.update(cacheInvalidationState)
      .set({
        attemptCount: sql`${cacheInvalidationState.attemptCount} + 1`,
        lastError: reason,
        updatedAt: now,
      })
      .where(and(
        eq(cacheInvalidationState.group, item.group),
        gt(cacheInvalidationState.requestedGeneration, cacheInvalidationState.appliedGeneration),
      )));
  await safeBatch(db, statements);
}
