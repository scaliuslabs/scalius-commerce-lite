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
// - The buyer-state/facet projection rebuild: a request stores a lap in
//   `system_kv`; every drain runs a bounded number of keyset chunks and
//   saves the lap (compare-and-set, so a request that lands meanwhile wins)
//   until done. A request while a lap runs keeps its position and moves its
//   end to where it is, one circle later, so requests that keep arriving
//   never send it back to the first product. A band-only lap (a store-wide
//   band input changed) recomputes stored bands alone, in larger chunks.
import type { Database } from "@scalius/database/client";
import { systemKv } from "@scalius/database/schema";
import { getSystemKv, putSystemKv } from "@scalius/core/utils/system-kv";
import { planLimits } from "@scalius/shared/plan-limits";
import { and, eq } from "drizzle-orm";
import type { CatalogProjectionRebuildResult } from "@scalius/core/modules/products";
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

/**
 * What a rebuild lap recomputes: `full` both projections; `bands` only the
 * stored availability band of each product (a store-wide input of the band
 * changed: the default low-stock level), one cheap statement per chunk.
 */
export type CatalogRebuildMode = "full" | "bands";

/**
 * The durable state of a rebuild lap (`system_kv`, JSON). The lap walks
 * product ids upward from `after`; with `stop` set it wraps once at the end
 * and finishes at `stop`, so it visits every product once after the latest
 * request without going back over the products it already did.
 */
export interface CatalogRebuildState {
  mode: CatalogRebuildMode;
  /** The last product id done (null: from the first product). */
  after: string | null;
  /** Where a wrapped lap ends (inclusive); null: at the last product. */
  stop: string | null;
  /** The lap passed the last product and continues from the first. */
  wrapped: boolean;
  /** Recount the public facet counts before the next chunk (a full request asked for it). */
  repairCounts: boolean;
}

/** Reads the stored lap; the pre-lap cursor ("" or a product id) reads as a full lap from it. */
export function parseCatalogRebuildState(raw: string | null): CatalogRebuildState | null {
  if (raw === null) return null;
  if (!raw.startsWith("{")) return { mode: "full", after: raw || null, stop: null, wrapped: false, repairCounts: raw === "" };
  try {
    const value = JSON.parse(raw) as Partial<CatalogRebuildState>;
    const id = (field: unknown) => (typeof field === "string" && field !== "" ? field : null);
    return {
      mode: value.mode === "bands" ? "bands" : "full",
      after: id(value.after),
      stop: id(value.stop),
      wrapped: value.wrapped === true,
      repairCounts: value.repairCounts === true,
    };
  } catch {
    return { mode: "full", after: null, stop: null, wrapped: false, repairCounts: true };
  }
}

/**
 * The lap after a new request. A running lap keeps its position and now
 * ends where it is, one circle later: every product is visited after the
 * request and none twice. A full request turns a band lap into a full one.
 */
export function nextCatalogRebuildState(current: CatalogRebuildState | null, mode: CatalogRebuildMode): CatalogRebuildState {
  const lapMode: CatalogRebuildMode = mode === "full" || current?.mode === "full" ? "full" : "bands";
  const repairCounts = mode === "full" || current?.repairCounts === true;
  if (!current || (current.after === null && !current.wrapped)) {
    return { mode: lapMode, after: null, stop: null, wrapped: false, repairCounts };
  }
  return { mode: lapMode, after: current.after, stop: current.after, wrapped: false, repairCounts };
}

/**
 * Requests a rebuild lap (`full` unless only bands changed); the next drain
 * runs it. A lap already running keeps its progress, so requests that keep
 * arriving never send it back to the first product.
 */
export async function requestCatalogProjectionRebuild(db: Database, mode: CatalogRebuildMode = "full"): Promise<void> {
  const current = parseCatalogRebuildState(await getSystemKv(db, PROJECTION_REBUILD_CURSOR_KEY));
  await putSystemKv(db, PROJECTION_REBUILD_CURSOR_KEY, JSON.stringify(nextCatalogRebuildState(current, mode)));
}

/**
 * Records the rebuild request with the write (the scheduled drain runs it if
 * nothing else does) and runs its first chunks right after the response.
 * Never throws: a failed request is logged, and the nightly drift check heals.
 */
export async function rebuildCatalogProjectionsAfterWrite(
  caller: BackgroundCaller,
  db: Database,
  source: string,
  mode: CatalogRebuildMode = "full",
): Promise<void> {
  try {
    await requestCatalogProjectionRebuild(db, mode);
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

/**
 * Runs up to this plan's chunks of a requested lap. Returns the products
 * recomputed. Each save is a compare-and-set on the stored state: a request
 * that lands meanwhile wins, and the next drain continues from it.
 */
export async function drainCatalogProjectionRebuild(db: Database): Promise<number> {
  let raw = await getSystemKv(db, PROJECTION_REBUILD_CURSOR_KEY);
  let state = parseCatalogRebuildState(raw);
  if (raw === null || state === null) return 0;
  const products = await import("@scalius/core/modules/products");
  const limits = planLimits().background;
  let processed = 0;
  for (let chunk = 0; chunk < limits.catalogRebuildChunksPerDrain; chunk += 1) {
    const range = { afterProductId: state.after, untilProductId: state.wrapped ? state.stop : null };
    const result: CatalogProjectionRebuildResult = state.mode === "bands"
      ? await products.refreshCatalogAvailabilityBands(db, { ...range, limit: limits.catalogBandRefreshChunk })
      : await products.rebuildCatalogProjections(db, { ...range, limit: limits.catalogRebuildChunk, repairFacetCounts: state.repairCounts });
    processed += result.processed;
    const where = and(eq(systemKv.key, PROJECTION_REBUILD_CURSOR_KEY), eq(systemKv.value, raw));
    let next: CatalogRebuildState | null = null;
    if (!result.done) next = { ...state, after: result.nextAfterProductId, repairCounts: false };
    // At the last product a lap with a stop wraps to the first product, once.
    else if (state.stop !== null && !state.wrapped) next = { ...state, after: null, wrapped: true, repairCounts: false };
    if (next === null) {
      // The rebuild's atomic batches advance `store` only when they repair drift.
      await db.delete(systemKv).where(where);
      return processed;
    }
    const value = JSON.stringify(next);
    const saved = await db.update(systemKv).set({ value }).where(where).returning({ key: systemKv.key });
    // A request landed meanwhile: its state is the next drain's.
    if (saved.length === 0) return processed;
    raw = value;
    state = next;
  }
  return processed;
}
