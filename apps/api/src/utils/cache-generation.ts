// Public cache freshness: one store-wide cache generation.
//
// Every public API and storefront cache key includes the generation (see
// @scalius/shared/cache-generation). A buyer-visible write calls
// `bumpCacheGeneration(c)` after it commits; that replaces the token in the
// database and mirrors it to KV, so every old cache entry becomes unreachable.
// There are no purges, tags, warm-ups, or retry queues. Stock writes bump only
// when an availability band changes, so public stock stays band-only.
import { getDb, type Database } from "@scalius/database/client";
import { cacheGeneration, productVariants } from "@scalius/database/schema";
import { effectiveRegularReservedStockSql } from "@scalius/database/inventory-authority";
import { eq, inArray } from "drizzle-orm";
import { resolveTrackedBuyerAvailabilityBand } from "@scalius/shared/buyer-availability";
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

// ---------------------------------------------------------------------------
// Availability-band transitions (band-only public stock)
// ---------------------------------------------------------------------------

export interface CheckoutReservationAvailabilityInput {
  variantId: string;
  quantity: number;
}

export interface StockAvailabilityMutationInput {
  variantId: string;
  previousStock: number;
  newStock: number;
  pool?: "stock" | "preorderStock";
}

interface BuyerAvailabilityRow {
  id: string;
  stock: number;
  preorderStock: number;
  reservedStock: number;
  trackInventory: boolean;
  allowPreorder: boolean;
  lowStockThreshold: number | null;
}

export function hasBuyerAvailabilityBandTransition(input: {
  availableBefore: number;
  availableAfter: number;
  lowStockThreshold: number | null;
}): boolean {
  return resolveTrackedBuyerAvailabilityBand(
    input.availableBefore,
    input.lowStockThreshold,
  ) !== resolveTrackedBuyerAvailabilityBand(
    input.availableAfter,
    input.lowStockThreshold,
  );
}

async function loadBuyerAvailabilityRows(
  db: Database,
  variantIds: readonly string[],
): Promise<BuyerAvailabilityRow[]> {
  const rows: BuyerAvailabilityRow[] = [];
  for (let offset = 0; offset < variantIds.length; offset += 90) {
    rows.push(...await db
      .select({
        id: productVariants.id,
        stock: productVariants.stock,
        preorderStock: productVariants.preorderStock,
        reservedStock: effectiveRegularReservedStockSql(),
        trackInventory: productVariants.trackInventory,
        allowPreorder: productVariants.allowPreorder,
        lowStockThreshold: productVariants.lowStockThreshold,
      })
      .from(productVariants)
      .where(inArray(productVariants.id, variantIds.slice(offset, offset + 90)))
      .all());
  }
  return rows;
}

/**
 * Direct checkout is the compatibility lane; the high-throughput coordinator
 * reports transitions without this read. Conservatively return every affected
 * variant if authority cannot be read after the commit.
 */
export async function findCheckoutReservationAvailabilityTransitions(
  db: Database,
  entries: readonly CheckoutReservationAvailabilityInput[],
): Promise<string[]> {
  const quantities = new Map<string, number>();
  for (const entry of entries) {
    if (
      !entry.variantId
      || entry.variantId.length > 180
      || !Number.isSafeInteger(entry.quantity)
      || entry.quantity <= 0
    ) {
      continue;
    }
    quantities.set(
      entry.variantId,
      (quantities.get(entry.variantId) ?? 0) + entry.quantity,
    );
  }
  const variantIds = [...quantities.keys()];
  if (variantIds.length === 0) return [];

  try {
    const rows = await loadBuyerAvailabilityRows(db, variantIds);
    const found = new Set(rows.map((row) => row.id));
    const transitions = rows.filter((row) => {
      if (!row.trackInventory) return false;
      const availableAfter = Math.max(0, row.stock - row.reservedStock);
      return hasBuyerAvailabilityBandTransition({
        availableBefore: availableAfter + quantities.get(row.id)!,
        availableAfter,
        lowStockThreshold: row.lowStockThreshold,
      });
    }).map((row) => row.id);
    for (const variantId of variantIds) {
      if (!found.has(variantId)) transitions.push(variantId);
    }
    return [...new Set(transitions)];
  } catch (error) {
    console.error(
      "[Cache] Checkout availability transition read failed; bumping conservatively:",
      error,
    );
    return variantIds;
  }
}

/** Manual stock writes bump only when a buyer-visible band changes. */
export async function findStockMutationAvailabilityTransitions(
  db: Database,
  mutations: readonly StockAvailabilityMutationInput[],
): Promise<string[]> {
  const byVariant = new Map<string, StockAvailabilityMutationInput>();
  for (const mutation of mutations) {
    if (
      !mutation.variantId
      || mutation.variantId.length > 180
      || !Number.isSafeInteger(mutation.previousStock)
      || !Number.isSafeInteger(mutation.newStock)
    ) {
      continue;
    }
    byVariant.set(mutation.variantId, mutation);
  }
  const variantIds = [...byVariant.keys()];
  if (variantIds.length === 0) return [];

  try {
    const rows = await loadBuyerAvailabilityRows(db, variantIds);
    const found = new Set(rows.map((row) => row.id));
    const transitions = rows.filter((row) => {
      if (!row.trackInventory) return false;
      const mutation = byVariant.get(row.id)!;
      if (mutation.pool === "preorderStock") {
        if (!row.allowPreorder) return false;
        return (mutation.previousStock > 0) !== (mutation.newStock > 0);
      }
      return hasBuyerAvailabilityBandTransition({
        availableBefore: Math.max(
          0,
          mutation.previousStock - row.reservedStock,
        ),
        availableAfter: Math.max(0, mutation.newStock - row.reservedStock),
        lowStockThreshold: row.lowStockThreshold,
      });
    }).map((row) => row.id);
    for (const variantId of variantIds) {
      if (!found.has(variantId)) transitions.push(variantId);
    }
    return [...new Set(transitions)];
  } catch (error) {
    console.error(
      "[Cache] Stock availability transition read failed; bumping conservatively:",
      error,
    );
    return variantIds;
  }
}
