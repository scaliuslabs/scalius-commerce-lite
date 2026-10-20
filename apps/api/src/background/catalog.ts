// Catalogue background work, driven by durable state instead of messages:
//
// - Recommendation refresh after a catalogue write: the written products and
//   their bounded peers are recomputed right after the response, as many as
//   the plan profile allows; the rotation heals the rest.
// - The recommendation rotation: each run first refreshes the products a
//   buyer read queued (catalog/recommendation-queue.ts: a page found no
//   stored list and was served the fallback), then the next public products
//   after a persisted cursor (`system_kv`). A lap visits every public product
//   once, and the next lap starts a day after this one started, so a small
//   catalogue is not re-ranked all day and a large one still gets a lap a day
//   up to the plan's per-run size times the runs in a day.
// - The buyer-state/facet projection rebuild: a request stores its cursor in
//   `system_kv` ("" = from the start); every drain runs a bounded number of
//   keyset chunks and saves the cursor (compare-and-set, so a rebuild
//   requested meanwhile restarts instead of being overwritten) until done.
import type { Database } from "@scalius/database/client";
import { systemKv } from "@scalius/database/schema";
import { getSystemKv, putSystemKv } from "@scalius/core/utils/system-kv";
import { planLimits } from "@scalius/shared/plan-limits";
import { and, eq } from "drizzle-orm";
import { afterResponse, type BackgroundCaller } from "./after-response";

/** `system_kv`: the product id the projection rebuild continues after ("" = from the start); absent = no rebuild. */
export const PROJECTION_REBUILD_CURSOR_KEY = "catalog:projections:rebuild-cursor";
/** `system_kv`: the last product id the recommendation rotation refreshed. */
export const RECOMMENDATION_ROTATION_CURSOR_KEY = "catalog:recommendations:rotation-cursor";

/** After a catalogue write: refresh the written products' recommendations and their peers'. Never throws. */
export async function refreshRecommendationsAfterWrite(
  caller: BackgroundCaller,
  db: Database,
  productIds: readonly string[],
): Promise<void> {
  if (productIds.length === 0) return;
  await afterResponse(caller, "recommendation refresh", async () => {
    const { recommendationRefreshTargets, refreshProductRecommendations } = await import("@scalius/core/modules/catalog");
    const targets = await recommendationRefreshTargets(db, productIds);
    await refreshProductRecommendations(db, targets.slice(0, planLimits().background.recommendationProductsAfterWrite));
  });
}

/** A rotation lap starts at most this often. */
export const RECOMMENDATION_LAP_SECONDS = 86_400;

/** The rotation cursor: when the lap started, the last product it refreshed (null: none yet), and whether it is done. */
type RotationCursor = { lapStartedAt: number; after: string | null; done: boolean };

function readRotationCursor(raw: string | null): RotationCursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<RotationCursor>;
    if (typeof value.lapStartedAt !== "number" || typeof value.done !== "boolean") return null;
    return { lapStartedAt: value.lapStartedAt, after: typeof value.after === "string" ? value.after : null, done: value.done };
  } catch {
    return null;
  }
}

/**
 * One rotation step: first the products a buyer read queued (no stored list
 * yet), then the next public products of the lap, up to the plan's per-run
 * size in all. Returns how many were refreshed (0 while nothing is queued
 * and the day's lap is done).
 */
export async function rotateRecommendations(db: Database, nowSeconds = Math.floor(Date.now() / 1000)): Promise<number> {
  const catalog = await import("@scalius/core/modules/catalog");
  const limit = planLimits().background.recommendationRotationPerRun;
  // The cursor and the queue in one read.
  const state = await catalog.readRecommendationRotation(db, RECOMMENDATION_ROTATION_CURSOR_KEY, limit);
  const queued = state.queued;
  if (queued.length > 0) {
    await catalog.refreshProductRecommendations(db, queued);
    await catalog.dequeueRecommendationRefresh(db, queued);
  }
  const room = limit - queued.length;
  if (room <= 0) return queued.length;
  let cursor = readRotationCursor(state.cursor);
  if (cursor?.done && nowSeconds - cursor.lapStartedAt < RECOMMENDATION_LAP_SECONDS) return queued.length;
  if (!cursor || cursor.done) cursor = { lapStartedAt: nowSeconds, after: null, done: false };
  const ids = await catalog.recommendationRotationBatch(db, { after: cursor.after, limit: room });
  if (ids.length > 0) await catalog.refreshProductRecommendations(db, ids);
  const next: RotationCursor = { lapStartedAt: cursor.lapStartedAt, after: ids.at(-1) ?? cursor.after, done: ids.length < room };
  await putSystemKv(db, RECOMMENDATION_ROTATION_CURSOR_KEY, JSON.stringify(next));
  return queued.length + ids.length;
}

/** Starts (or restarts) the projection rebuild; the next drain runs it. */
export async function requestCatalogProjectionRebuild(db: Database): Promise<void> {
  await putSystemKv(db, PROJECTION_REBUILD_CURSOR_KEY, "");
}

/**
 * Records the rebuild request with the write (the scheduled drain runs it if
 * nothing else does) and runs its first chunks right after the response.
 * Never throws: a failed request is logged, and the nightly rebuild heals.
 */
export async function rebuildCatalogProjectionsAfterWrite(caller: BackgroundCaller, db: Database, source: string): Promise<void> {
  try {
    await requestCatalogProjectionRebuild(db);
  } catch (error) {
    console.warn(`[${source}] projection rebuild request failed`, error instanceof Error ? error.name : "unknown");
    return;
  }
  await afterResponse(caller, "projection rebuild", () => drainCatalogProjectionRebuild(db));
}

/** Whether a rebuild is requested (its cursor row exists): the scheduled drain runs only then. */
export function projectionRebuildDueProbe(db: Database) {
  return db.select({ key: systemKv.key }).from(systemKv).where(eq(systemKv.key, PROJECTION_REBUILD_CURSOR_KEY)).limit(1);
}

/** Runs up to this plan's chunks of a requested rebuild. Returns the products recomputed. */
export async function drainCatalogProjectionRebuild(db: Database): Promise<number> {
  let cursor = await getSystemKv(db, PROJECTION_REBUILD_CURSOR_KEY);
  if (cursor === null) return 0;
  const { rebuildCatalogProjections } = await import("@scalius/core/modules/products");
  const limits = planLimits().background;
  let processed = 0;
  for (let chunk = 0; chunk < limits.catalogRebuildChunksPerDrain; chunk += 1) {
    const result = await rebuildCatalogProjections(db, { afterProductId: cursor || null, limit: limits.catalogRebuildChunk });
    processed += result.processed;
    const where = and(eq(systemKv.key, PROJECTION_REBUILD_CURSOR_KEY), eq(systemKv.value, cursor));
    if (result.done) {
      // The rebuild's atomic batches advance `store` only when they repair drift.
      await db.delete(systemKv).where(where);
      return processed;
    }
    const next = result.nextAfterProductId ?? "";
    const saved = await db.update(systemKv).set({ value: next }).where(where).returning({ key: systemKv.key });
    // A rebuild requested meanwhile reset the cursor: leave it for the next drain.
    if (saved.length === 0) return processed;
    cursor = next;
  }
  return processed;
}
