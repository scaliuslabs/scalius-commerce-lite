// src/lib/inventory/release.ts
// Releases stock reservations when an order is cancelled or payment fails.
// Decrements reservedStock (and restores preorderStock for pre-order pool).

import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { inventoryMovements, productVariants } from "@scalius/database/schema";
import { safeBatch, type Database } from "@scalius/database/client";
import type { BatchItem } from "drizzle-orm/batch";
import { recordMovement } from "./movements";
import { checkAndAlertLowStock } from "./alerts";
import type { ReservationEntry, StockOperationResult } from "./types";
import { validatePositiveQuantity } from "./validation";

type ReservationPool = "regular" | "preorder" | "backorder";
type SQLiteBatchItem = BatchItem<"sqlite">;

interface ReleaseVariantState {
  id: string;
  stock: number;
  reservedStock: number;
  preorderStock: number;
  trackInventory: boolean;
  stockVersion: number;
}

interface ReleaseMovementStats {
  reservedQuantity: number;
  releasedQuantity: number;
  reservationGenerations: number;
}

interface ReleaseMovementClaim {
  id: string;
  variantId: string;
  orderId: string;
  quantity: number;
  previousStock: number;
  newStock: number;
  notes: string;
}

interface StrictReleaseEntry {
  variantId: string;
  quantity: number;
  pool: ReservationPool;
}

export interface ReleaseReservedStockBatchOptions {
  releaseKey?: string;
}

export interface ReleaseReservedStockBatchResult {
  success: boolean;
  results: StockOperationResult[];
  error?: string;
  manualReconciliationRequired?: boolean;
}

const DEFAULT_RELEASE_KEY = "inventory-release:v1";
const STRICT_RELEASE_RETRIES = 3;
const STRICT_RELEASE_BACKOFF_MS = 50;

/**
 * Release a reservation for a single variant.
 * Decrements reservedStock; for pre-order pool also restores preorderStock.
 * Does NOT use optimistic locking because releasing is always safe to apply
 * (we use MAX(0, ...) to guard against underflow, and a missed release
 * never causes overselling — it only over-reserves).
 */
export async function releaseReservation(
  db: Database,
  variantId: string,
  quantity: number,
  orderId?: string,
  pool: "regular" | "preorder" | "backorder" = "regular"
): Promise<StockOperationResult> {
  validatePositiveQuantity(quantity);

  const variant = await db
    .select({
      id: productVariants.id,
      stock: productVariants.stock,
      reservedStock: productVariants.reservedStock,
      preorderStock: productVariants.preorderStock,
      trackInventory: productVariants.trackInventory,
    })
    .from(productVariants)
    .where(eq(productVariants.id, variantId))
    .get();

  if (!variant) {
    return {
      success: false,
      variantId,
      previousStock: 0,
      newStock: 0,
      error: `Variant ${variantId} not found`,
    };
  }

  const previousStock = pool === "preorder" ? variant.preorderStock : variant.stock;

  if (!variant.trackInventory) {
    return { success: true, variantId, previousStock, newStock: previousStock };
  }

  await db
    .update(productVariants)
    .set({
      reservedStock: sql`MAX(0, ${productVariants.reservedStock} - ${quantity})`,
      ...(pool === "preorder"
        ? { preorderStock: sql`${productVariants.preorderStock} + ${quantity}` }
        : {}),
      stockVersion: sql`${productVariants.stockVersion} + 1`,
      updatedAt: sql`unixepoch()`,
    })
    .where(eq(productVariants.id, variantId));

  const newStock =
    pool === "preorder" ? variant.preorderStock + quantity : variant.stock;

  await recordMovement(db, {
    variantId,
    orderId,
    type: "released",
    quantity: -quantity,
    previousStock,
    newStock,
    notes: `Reservation released${orderId ? ` for order ${orderId}` : ""}`,
  });

  // Auto-resolve low stock alerts when available stock increases
  await checkAndAlertLowStock(db, variantId);

  return { success: true, variantId, previousStock, newStock };
}

/**
 * Release reservations for multiple variants.
 * Best-effort: continues even if individual releases fail.
 */
export async function releaseMultiple(
  db: Database,
  entries: ReservationEntry[],
  orderId?: string
): Promise<{ success: boolean; results: StockOperationResult[]; error?: string }> {
  for (const entry of entries) validatePositiveQuantity(entry.quantity);

  const results: StockOperationResult[] = [];
  let anyFailed = false;
  let lastError: string | undefined;

  for (const entry of entries) {
    const result = await releaseReservation(
      db,
      entry.variantId,
      entry.quantity,
      orderId,
      entry.pool ?? "regular"
    );
    results.push(result);

    if (!result.success) {
      anyFailed = true;
      lastError = result.error;
      // Log but continue — partial release is better than none
      console.error(
        `[inventory/release] Failed to release reservation for variant ${entry.variantId}: ${result.error}`
      );
    }
  }

  return {
    success: !anyFailed,
    results,
    error: anyFailed ? lastError : undefined,
  };
}

export async function releaseReservedStockBatch(
  db: Database,
  entries: ReservationEntry[],
  orderId: string,
  options: ReleaseReservedStockBatchOptions = {},
): Promise<ReleaseReservedStockBatchResult> {
  for (const entry of entries) validatePositiveQuantity(entry.quantity);

  if (entries.length === 0) {
    return { success: true, results: [] };
  }

  const releaseKey = options.releaseKey ?? DEFAULT_RELEASE_KEY;
  const mergedEntries = mergeReleaseEntries(entries);

  for (let attempt = 0; attempt < STRICT_RELEASE_RETRIES; attempt++) {
    const variantLoad = await loadReleaseVariantStates(db, mergedEntries);
    if (!variantLoad.success) return variantLoad;

    const trackedEntries = mergedEntries.filter((entry) => {
      const variant = variantLoad.variants.get(entry.variantId);
      return variant?.trackInventory !== false;
    });
    if (trackedEntries.length === 0) {
      return {
        success: true,
        results: buildReleaseSuccessResults(mergedEntries, variantLoad.variants, new Map()),
      };
    }

    const stats = await loadReleaseMovementStats(db, orderId, trackedEntries);
    const entriesToRelease: StrictReleaseEntry[] = [];
    const alreadyReleasedResults: StockOperationResult[] = [];

    for (const entry of trackedEntries) {
      const stat = stats.get(entry.variantId) ?? {
        reservedQuantity: 0,
        releasedQuantity: 0,
        reservationGenerations: 0,
      };
      const outstandingQuantity = Math.max(0, stat.reservedQuantity - stat.releasedQuantity);

      if (stat.reservedQuantity <= 0) {
        return buildStrictReleaseFailure(
          mergedEntries,
          `No reservation movement found for order ${orderId} and variant ${entry.variantId}`,
          true,
        );
      }

      if (outstandingQuantity <= 0) {
        const variant = variantLoad.variants.get(entry.variantId)!;
        alreadyReleasedResults.push({
          success: true,
          variantId: entry.variantId,
          previousStock: getReleasePreviousStock(variant, entry.pool),
          newStock: getReleasePreviousStock(variant, entry.pool),
        });
        continue;
      }

      entriesToRelease.push({
        ...entry,
        quantity: Math.min(entry.quantity, outstandingQuantity),
      });
    }

    if (entriesToRelease.length === 0) {
      return {
        success: true,
        results: [
          ...buildReleaseSuccessResults(
            mergedEntries.filter((entry) => !trackedEntries.some((tracked) => tracked.variantId === entry.variantId)),
            variantLoad.variants,
            stats,
          ),
          ...alreadyReleasedResults,
        ],
      };
    }

    const claims = await Promise.all(entriesToRelease.map(async (entry) => {
      const variant = variantLoad.variants.get(entry.variantId)!;
      const stat = stats.get(entry.variantId)!;
      const previousStock = getReleasePreviousStock(variant, entry.pool);
      const newStock = entry.pool === "preorder" ? previousStock + entry.quantity : previousStock;
      return {
        id: await createReleaseMovementId({
          releaseKey,
          orderId,
          variantId: entry.variantId,
          pool: entry.pool,
          generation: stat.reservationGenerations,
        }),
        variantId: entry.variantId,
        orderId,
        quantity: -entry.quantity,
        previousStock,
        newStock,
        notes: `Released ${entry.quantity} reserved units after failed checkout commit for order ${orderId}`,
      } satisfies ReleaseMovementClaim;
    }));
    const movementQueries = claims.map((claim) =>
      buildReleaseMovementInsert(db, claim, variantLoad.variants.get(claim.variantId)!),
    );
    const updateQueries = entriesToRelease.map((entry) =>
      buildReleaseVariantUpdate(db, entry, variantLoad.variants.get(entry.variantId)!),
    );

    let batchResults: { id: string }[][];
    try {
      batchResults = await safeBatch(db, [...movementQueries, ...updateQueries] as SQLiteBatchItem[]) as { id: string }[][];
    } catch (err: unknown) {
      const duplicateResolved = await resolveDuplicateReleaseBatch(db, orderId, claims, entriesToRelease, err);
      if (duplicateResolved) {
        await alertLowStockAfterRelease(db, entriesToRelease);
        return {
          success: true,
          results: buildReleaseSuccessResults(mergedEntries, variantLoad.variants, stats),
        };
      }

      console.error(`[inventory/release] Strict release batch failed for order ${orderId}:`, err);
      if (attempt < STRICT_RELEASE_RETRIES - 1) {
        await waitForStrictReleaseRetry(attempt);
        continue;
      }
      return buildStrictReleaseFailure(mergedEntries, "Reservation release batch failed", true);
    }

    const failedMovementIndices: number[] = [];
    const insertedMovementIds: string[] = [];
    for (let i = 0; i < claims.length; i++) {
      const batchResult = batchResults[i];
      if (!batchResult || batchResult.length === 0) {
        failedMovementIndices.push(i);
      } else {
        insertedMovementIds.push(claims[i]!.id);
      }
    }

    const failedUpdateIndices: number[] = [];
    for (let i = 0; i < updateQueries.length; i++) {
      const batchResult = batchResults[movementQueries.length + i];
      if (!batchResult || batchResult.length === 0) {
        failedUpdateIndices.push(i);
      }
    }

    if (failedMovementIndices.length > 0 || failedUpdateIndices.length > 0) {
      const rollbackProven = await rollbackStrictReleaseBatch(
        db,
        claims,
        insertedMovementIds,
        entriesToRelease,
        failedUpdateIndices,
        variantLoad.variants,
      );
      if (!rollbackProven) {
        return buildStrictReleaseFailure(
          mergedEntries,
          "Reservation release rollback could not be proven; manual reconciliation is required",
          true,
        );
      }

      if (attempt < STRICT_RELEASE_RETRIES - 1) {
        await waitForStrictReleaseRetry(attempt);
        continue;
      }

      return {
        success: false,
        results: mergedEntries.map((entry) => {
          const movementFailed = failedMovementIndices.some(
            (movementIndex) => claims[movementIndex]?.variantId === entry.variantId,
          );
          const updateFailed = failedUpdateIndices.some(
            (updateIndex) => entriesToRelease[updateIndex]?.variantId === entry.variantId,
          );
          return {
            success: !movementFailed && !updateFailed,
            variantId: entry.variantId,
            previousStock: 0,
            newStock: 0,
            error: updateFailed
              ? `Reservation release CAS conflict for variant ${entry.variantId}`
              : movementFailed
                ? `Reservation release claim conflict for variant ${entry.variantId}`
                : undefined,
          };
        }),
        error: `Failed to release reserved stock after ${STRICT_RELEASE_RETRIES} retries due to concurrent modifications`,
        manualReconciliationRequired: true,
      };
    }

    await alertLowStockAfterRelease(db, entriesToRelease);
    return {
      success: true,
      results: buildReleaseSuccessResults(mergedEntries, variantLoad.variants, stats),
    };
  }

  return buildStrictReleaseFailure(
    mergedEntries,
    `Failed to release reserved stock after ${STRICT_RELEASE_RETRIES} retries`,
    true,
  );
}

function mergeReleaseEntries(entries: ReservationEntry[]): StrictReleaseEntry[] {
  const merged = new Map<string, StrictReleaseEntry>();

  for (const entry of entries) {
    const pool = entry.pool ?? "regular";
    const key = `${entry.variantId}\0${pool}`;
    const existing = merged.get(key);
    if (existing) {
      existing.quantity += entry.quantity;
    } else {
      merged.set(key, {
        variantId: entry.variantId,
        quantity: entry.quantity,
        pool,
      });
    }
  }

  return Array.from(merged.values());
}

async function loadReleaseVariantStates(
  db: Database,
  entries: StrictReleaseEntry[],
): Promise<
  | { success: true; variants: Map<string, ReleaseVariantState> }
  | { success: false; results: StockOperationResult[]; error: string; manualReconciliationRequired: true }
> {
  const variantIds = [...new Set(entries.map((entry) => entry.variantId))];
  const rows = await db
    .select({
      id: productVariants.id,
      stock: productVariants.stock,
      reservedStock: productVariants.reservedStock,
      preorderStock: productVariants.preorderStock,
      trackInventory: productVariants.trackInventory,
      stockVersion: productVariants.stockVersion,
    })
    .from(productVariants)
    .where(inArray(productVariants.id, variantIds))
    .all();

  const variants = new Map<string, ReleaseVariantState>(rows.map((row) => [row.id, row]));
  const missingEntry = entries.find((entry) => !variants.has(entry.variantId));

  if (missingEntry) {
    return {
      success: false,
      results: entries.map((entry) => ({
        success: entry.variantId !== missingEntry.variantId,
        variantId: entry.variantId,
        previousStock: 0,
        newStock: 0,
        error: entry.variantId === missingEntry.variantId
          ? `Variant ${entry.variantId} not found`
          : undefined,
      })),
      error: `Variant ${missingEntry.variantId} not found`,
      manualReconciliationRequired: true,
    };
  }

  return { success: true, variants };
}

async function loadReleaseMovementStats(
  db: Database,
  orderId: string,
  entries: StrictReleaseEntry[],
): Promise<Map<string, ReleaseMovementStats>> {
  const stats = new Map<string, ReleaseMovementStats>();

  await Promise.all(entries.map(async (entry) => {
    const row = await db
      .select({
        reservedQuantity: sql<number>`COALESCE(SUM(CASE WHEN ${inventoryMovements.type} IN ('reserved', 'preorder_reserved') THEN ${inventoryMovements.quantity} ELSE 0 END), 0)`,
        releasedQuantity: sql<number>`COALESCE(SUM(CASE WHEN ${inventoryMovements.type} = 'released' THEN -${inventoryMovements.quantity} ELSE 0 END), 0)`,
        reservationGenerations: sql<number>`COALESCE(SUM(CASE WHEN ${inventoryMovements.type} IN ('reserved', 'preorder_reserved') THEN 1 ELSE 0 END), 0)`,
      })
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.orderId, orderId),
          eq(inventoryMovements.variantId, entry.variantId),
        ),
      )
      .get();

    stats.set(entry.variantId, {
      reservedQuantity: Number(row?.reservedQuantity ?? 0),
      releasedQuantity: Number(row?.releasedQuantity ?? 0),
      reservationGenerations: Number(row?.reservationGenerations ?? 0),
    });
  }));

  return stats;
}

async function createReleaseMovementId(input: {
  releaseKey: string;
  orderId: string;
  variantId: string;
  pool: ReservationPool;
  generation: number;
}): Promise<string> {
  const payload = [
    input.releaseKey,
    input.orderId,
    input.variantId,
    input.pool,
    String(input.generation),
  ].join("\0");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `release:${hex}`;
}

function buildReleaseMovementInsert(
  db: Database,
  claim: ReleaseMovementClaim,
  variant: ReleaseVariantState,
) {
  return db
    .insert(inventoryMovements)
    .select(sql`
      SELECT
        ${claim.id},
        ${claim.variantId},
        ${claim.orderId},
        'released',
        ${claim.quantity},
        ${claim.previousStock},
        ${claim.newStock},
        ${claim.notes},
        NULL,
        unixepoch()
      FROM ${productVariants}
      WHERE ${productVariants.id} = ${claim.variantId}
        AND ${productVariants.stockVersion} = ${variant.stockVersion}
        AND ${productVariants.reservedStock} >= ${Math.abs(claim.quantity)}
    `)
    .returning({ id: inventoryMovements.id });
}

function buildReleaseVariantUpdate(
  db: Database,
  entry: StrictReleaseEntry,
  variant: ReleaseVariantState,
) {
  return db
    .update(productVariants)
    .set({
      reservedStock: sql`MAX(0, ${productVariants.reservedStock} - ${entry.quantity})`,
      ...(entry.pool === "preorder"
        ? { preorderStock: sql`${productVariants.preorderStock} + ${entry.quantity}` }
        : {}),
      stockVersion: sql`${productVariants.stockVersion} + 1`,
      updatedAt: sql`unixepoch()`,
    })
    .where(
      and(
        eq(productVariants.id, entry.variantId),
        eq(productVariants.stockVersion, variant.stockVersion),
        gte(productVariants.reservedStock, entry.quantity),
      ),
    )
    .returning({ id: productVariants.id });
}

async function rollbackStrictReleaseBatch(
  db: Database,
  claims: ReleaseMovementClaim[],
  insertedMovementIds: string[],
  entriesToRelease: StrictReleaseEntry[],
  failedUpdateIndices: number[],
  variants: Map<string, ReleaseVariantState>,
): Promise<boolean> {
  const rollbackQueries: SQLiteBatchItem[] = [];

  for (let index = 0; index < entriesToRelease.length; index++) {
    const entry = entriesToRelease[index]!;
    const claim = claims[index]!;
    const variant = variants.get(entry.variantId)!;
    const movementInserted = insertedMovementIds.includes(claim.id);
    const counterUpdated = !failedUpdateIndices.includes(index);

    if (counterUpdated) {
      rollbackQueries.push(
        db
          .update(productVariants)
          .set({
            reservedStock: sql`${productVariants.reservedStock} + ${entry.quantity}`,
            ...(entry.pool === "preorder"
              ? { preorderStock: sql`MAX(0, ${productVariants.preorderStock} - ${entry.quantity})` }
              : {}),
            stockVersion: sql`${productVariants.stockVersion} + 1`,
            updatedAt: sql`unixepoch()`,
          })
          .where(and(
            eq(productVariants.id, entry.variantId),
            eq(productVariants.stockVersion, variant.stockVersion + 1),
          ))
          .returning({ id: productVariants.id }),
      );
      if (movementInserted) {
        rollbackQueries.push(
          db.delete(inventoryMovements)
            .where(and(
              eq(inventoryMovements.id, claim.id),
              sql`EXISTS (
                SELECT 1
                FROM ${productVariants}
                WHERE ${productVariants.id} = ${entry.variantId}
                  AND ${productVariants.stockVersion} = ${variant.stockVersion + 2}
              )`,
            ))
            .returning({ id: inventoryMovements.id }),
        );
      }
    } else if (movementInserted) {
      rollbackQueries.push(
        db.delete(inventoryMovements)
          .where(eq(inventoryMovements.id, claim.id))
          .returning({ id: inventoryMovements.id }),
      );
    }
  }

  if (rollbackQueries.length === 0) return true;

  try {
    const results = await safeBatch(db, rollbackQueries) as { id: string }[][];
    return results.every((result) => Boolean(result?.length));
  } catch (err: unknown) {
    console.error("[inventory/release] Strict release rollback failed:", err);
    return false;
  }
}

function isDuplicateReleaseMovementClaimError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("release:") ||
    (message.includes("UNIQUE constraint failed") &&
      message.includes("inventory_movements"))
  );
}

async function resolveDuplicateReleaseBatch(
  db: Database,
  orderId: string,
  claims: ReleaseMovementClaim[],
  entries: StrictReleaseEntry[],
  err: unknown,
): Promise<boolean> {
  if (!isDuplicateReleaseMovementClaimError(err)) return false;

  const existingRows = await db
    .select({
      id: inventoryMovements.id,
      variantId: inventoryMovements.variantId,
      orderId: inventoryMovements.orderId,
      type: inventoryMovements.type,
      quantity: inventoryMovements.quantity,
    })
    .from(inventoryMovements)
    .where(inArray(inventoryMovements.id, claims.map((claim) => claim.id)))
    .all();
  const existingById = new Map(existingRows.map((row) => [row.id, row]));
  const mismatched = claims.find((claim) => {
    const row = existingById.get(claim.id);
    return !row ||
      row.variantId !== claim.variantId ||
      row.orderId !== orderId ||
      row.type !== "released" ||
      row.quantity !== claim.quantity;
  });

  if (mismatched) {
    console.error("[inventory/release] Release claim mismatch requires manual reconciliation", {
      orderId,
      variantId: mismatched.variantId,
    });
    return false;
  }

  const stats = await loadReleaseMovementStats(db, orderId, entries);
  return entries.every((entry) => {
    const stat = stats.get(entry.variantId);
    return stat && stat.releasedQuantity >= Math.min(stat.reservedQuantity, entry.quantity);
  });
}

function buildReleaseSuccessResults(
  entries: StrictReleaseEntry[],
  variants: Map<string, ReleaseVariantState>,
  stats: Map<string, ReleaseMovementStats>,
): StockOperationResult[] {
  return entries.map((entry) => {
    const variant = variants.get(entry.variantId)!;
    const stat = stats.get(entry.variantId);
    const outstandingQuantity = stat
      ? Math.max(0, Math.min(entry.quantity, stat.reservedQuantity - stat.releasedQuantity))
      : entry.quantity;
    const releasedQuantity = variant.trackInventory === false ? 0 : outstandingQuantity;
    const previousStock = getReleasePreviousStock(variant, entry.pool);
    return {
      success: true,
      variantId: entry.variantId,
      previousStock,
      newStock: entry.pool === "preorder" ? previousStock + releasedQuantity : previousStock,
    };
  });
}

function buildStrictReleaseFailure(
  entries: StrictReleaseEntry[],
  error: string,
  manualReconciliationRequired: boolean,
): ReleaseReservedStockBatchResult {
  return {
    success: false,
    results: entries.map((entry) => ({
      success: false,
      variantId: entry.variantId,
      previousStock: 0,
      newStock: 0,
      error,
    })),
    error,
    manualReconciliationRequired,
  };
}

function getReleasePreviousStock(variant: ReleaseVariantState, pool: ReservationPool): number {
  return pool === "preorder" ? variant.preorderStock : variant.stock;
}

async function alertLowStockAfterRelease(db: Database, entries: StrictReleaseEntry[]): Promise<void> {
  await Promise.all(entries.map((entry) =>
    checkAndAlertLowStock(db, entry.variantId).catch((err: unknown) => {
      console.error(`[inventory/release] Low-stock alert refresh failed for variant ${entry.variantId}:`, err);
    }),
  ));
}

async function waitForStrictReleaseRetry(attempt: number): Promise<void> {
  const backoff = STRICT_RELEASE_BACKOFF_MS * Math.pow(2, attempt);
  await new Promise((resolve) => setTimeout(resolve, backoff));
}
