// src/lib/inventory/reserve.ts
// Optimistic-locking stock reservation.
// Reserves stock by incrementing reservedStock WITHOUT decrementing stock.
// Stock is permanently deducted only on payment confirmation.

import { eq, and, sql, inArray, isNull } from "drizzle-orm";
import { inventoryMovements, products, productVariants } from "@scalius/database/schema";
import { safeBatch, type Database } from "@scalius/database/client";
import { recordMovement } from "./movements";
import type { ReservationEntry, StockOperationResult } from "./types";

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 50;
type ReservationPool = "regular" | "preorder" | "backorder";

/**
 * Reserve stock for a single variant using optimistic locking.
 * Uses the `version` field to detect concurrent modifications and retries.
 *
 * For pre-orders: deducts from preorderStock instead of regular stock.
 * For backorders: allows order even when stock = 0 (up to backorderLimit).
 */
export async function reserveStock(
  db: Database,
  variantId: string,
  quantity: number,
  orderId?: string,
  pool: "regular" | "preorder" | "backorder" = "regular"
): Promise<StockOperationResult> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // 1. Read current state with version
    const variant = await db
      .select({
        id: productVariants.id,
        stock: productVariants.stock,
        reservedStock: productVariants.reservedStock,
        preorderStock: productVariants.preorderStock,
        allowPreorder: productVariants.allowPreorder,
        allowBackorder: productVariants.allowBackorder,
        backorderLimit: productVariants.backorderLimit,
        stockVersion: productVariants.stockVersion,
      })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(
        and(
          eq(productVariants.id, variantId),
          isNull(productVariants.deletedAt),
          eq(products.isActive, true),
          isNull(products.deletedAt),
        ),
      )
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

    // 2. Check available stock based on pool
    if (pool === "preorder") {
      if (!variant.allowPreorder) {
        return {
          success: false,
          variantId,
          previousStock: variant.preorderStock,
          newStock: variant.preorderStock,
          error: `Pre-order not allowed for variant ${variantId}`,
        };
      }
      if (variant.preorderStock < quantity) {
        return {
          success: false,
          variantId,
          previousStock: variant.preorderStock,
          newStock: variant.preorderStock,
          error: `Insufficient pre-order stock for variant ${variantId}. Available: ${variant.preorderStock}, Requested: ${quantity}`,
        };
      }
    } else if (pool === "backorder") {
      if (!variant.allowBackorder) {
        return {
          success: false,
          variantId,
          previousStock: variant.stock,
          newStock: variant.stock,
          error: `Backorder not allowed for variant ${variantId}`,
        };
      }
      // Check backorder limit (0 = unlimited)
      if (variant.backorderLimit > 0 && variant.reservedStock + quantity > variant.backorderLimit) {
        return {
          success: false,
          variantId,
          previousStock: variant.stock,
          newStock: variant.stock,
          error: `Backorder limit exceeded for variant ${variantId}`,
        };
      }
    } else {
      // Regular stock: available = stock - reservedStock
      const available = variant.stock - variant.reservedStock;
      if (available < quantity) {
        return {
          success: false,
          variantId,
          previousStock: variant.stock,
          newStock: variant.stock,
          error: `Insufficient stock for variant ${variantId}. Available: ${available}, Requested: ${quantity}`,
        };
      }
    }

    // 3. Attempt optimistic update with version check
    const previousStock = pool === "preorder" ? variant.preorderStock : variant.stock;

    const updateSet =
      pool === "preorder"
        ? {
          preorderStock: sql`${productVariants.preorderStock} - ${quantity}`,
          reservedStock: sql`${productVariants.reservedStock} + ${quantity}`,
          stockVersion: sql`${productVariants.stockVersion} + 1`,
          updatedAt: sql`unixepoch()`,
        }
        : {
          reservedStock: sql`${productVariants.reservedStock} + ${quantity}`,
          stockVersion: sql`${productVariants.stockVersion} + 1`,
          updatedAt: sql`unixepoch()`,
        };

    const result = await db
      .update(productVariants)
      .set(updateSet)
      .where(
          and(
            eq(productVariants.id, variantId),
            isNull(productVariants.deletedAt),
            eq(productVariants.stockVersion, variant.stockVersion)
          )
        )
      .returning({ id: productVariants.id });

    if (result.length > 0) {
      // Success — log movement
      const newStock = pool === "preorder"
        ? variant.preorderStock - quantity
        : variant.stock;

      await recordMovement(db, {
        variantId,
        orderId,
        type: pool === "preorder" ? "preorder_reserved" : "reserved",
        quantity,
        previousStock,
        newStock,
        notes: `Reserved ${quantity} units for order${orderId ? ` ${orderId}` : ""}`,
      });

      return { success: true, variantId, previousStock, newStock };
    }

    // Concurrent modification detected — wait and retry
    if (attempt < MAX_RETRIES - 1) {
      const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }

  return {
    success: false,
    variantId,
    previousStock: 0,
    newStock: 0,
    error: `Failed to reserve stock after ${MAX_RETRIES} retries due to concurrent modifications`,
  };
}

/**
 * Reserve stock for multiple variants atomically.
 * If any reservation fails, rolls back all successful reservations.
 */
export async function reserveMultiple(
  db: Database,
  entries: ReservationEntry[],
  orderId?: string
): Promise<{ success: boolean; results: StockOperationResult[]; error?: string }> {
  const results: StockOperationResult[] = [];
  const toRollback: ReservationEntry[] = [];

  for (const entry of entries) {
    const result = await reserveStock(db, entry.variantId, entry.quantity, orderId, entry.pool ?? "regular");
    results.push(result);

    if (!result.success) {
      // Rollback all previous successful reservations
      for (const rolledBack of toRollback) {
        await releaseReservationInternal(db, rolledBack.variantId, rolledBack.quantity, orderId, rolledBack.pool ?? "regular");
      }
      return {
        success: false,
        results,
        error: result.error ?? `Failed to reserve stock for variant ${entry.variantId}`,
      };
    }

    toRollback.push(entry);
  }

  return { success: true, results };
}

export type ReservationBatchItem = {
  variantId: string;
  quantity: number;
  orderId?: string;
  /**
   * Stable idempotency namespace for strict reservation movement claims.
   * Existing callers omit this and keep legacy random movement IDs.
   */
  reservationKey?: string;
  /**
   * Explicit movement claim ID. Prefer reservationKey for normal callers so
   * releases can advance the generated claim generation.
   */
  movementId?: string;
};

export interface ReserveStockBatchOptions {
  /**
   * Stable idempotency namespace for callers that need replay-safe reservation
   * claims. Queued checkout ingest uses this; admin/order-edit flows remain
   * non-deterministic unless they explicitly opt in.
   */
  reservationKey?: string;
}

type ReserveStockBatchResult = {
  success: boolean;
  results: StockOperationResult[];
  error?: string;
  manualReconciliationRequired?: boolean;
};

type ReservationMovementClaim = {
  id: string;
  deterministic: boolean;
  variantId: string;
  orderId?: string;
  type: "reserved" | "preorder_reserved";
  quantity: number;
  previousStock: number;
  newStock: number;
  notes: string;
};

/**
 * Atomically reserve stock for multiple variants using D1 batch.
 *
 * Unlike `reserveMultiple` (which reserves sequentially and rolls back on
 * failure), this function:
 *   1. Reads all variant states upfront
 *   2. Validates ALL stock availability before writing anything
 *   3. Batches all CAS updates into a single `db.batch()` call (atomic in D1)
 *   4. Verifies all CAS updates succeeded; batch-rolls-back on any conflict
 *
 * This prevents orphaned reservations: either ALL variants are reserved or NONE are.
 *
 * Retries the entire batch up to MAX_RETRIES times on CAS conflict.
 */
export async function reserveStockBatch(
  db: Database,
  items: ReservationBatchItem[],
  pool: ReservationPool = "regular",
  options: ReserveStockBatchOptions = {},
): Promise<ReserveStockBatchResult> {
  if (items.length === 0) {
    return { success: true, results: [] };
  }

  // Deduplicate stock counter updates by variant. Audit movements are grouped
  // separately by variant + order so every order keeps its own reservation trail.
  const entries = mergeReservationItemsByVariant(items);
  const movementEntries = groupReservationMovementsForAudit(items);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Phase 1: Read all variant states
    const variantLoad = await loadReservationVariantStates(db, entries);
    if (!variantLoad.success) return variantLoad;
    const variants = variantLoad.variants;

    // Phase 2: Validate ALL stock availability before writing anything
    const validationErrors = getStockAvailabilityErrors(entries, variants, pool);

    if (validationErrors.length > 0) {
      return {
        success: false,
        results: validationErrors,
        error: validationErrors[0]?.error,
      };
    }

    // Phase 3: Build strict movement claims and all CAS update queries.
    const movementClaims = await buildReservationMovementClaims(
      db,
      movementEntries,
      variants,
      pool,
      options,
    );
    const movementQueries = movementClaims.map((claim) =>
      buildReservationMovementInsert(db, claim, variants.get(claim.variantId)!)
    );
    const updateQueries = entries.map((entry) => {
      const variant = variants.get(entry.variantId)!;
      const updateSet =
        pool === "preorder"
          ? {
              preorderStock: sql`${productVariants.preorderStock} - ${entry.quantity}`,
              reservedStock: sql`${productVariants.reservedStock} + ${entry.quantity}`,
              stockVersion: sql`${productVariants.stockVersion} + 1`,
              updatedAt: sql`unixepoch()`,
            }
          : {
              reservedStock: sql`${productVariants.reservedStock} + ${entry.quantity}`,
              stockVersion: sql`${productVariants.stockVersion} + 1`,
              updatedAt: sql`unixepoch()`,
            };

      return db
        .update(productVariants)
        .set(updateSet)
        .where(
          and(
            eq(productVariants.id, entry.variantId),
            isNull(productVariants.deletedAt),
            eq(productVariants.stockVersion, variant.stockVersion)
          )
        )
        .returning({ id: productVariants.id });
    });

    // Phase 4: Execute all movement claims and updates atomically via D1 batch
    let batchResults: { id: string }[][];
    try {
      batchResults = await safeBatch(db, [...movementQueries, ...updateQueries] as never) as { id: string }[][];
    } catch (err: unknown) {
      const idempotentResult = await resolveDuplicateReservationBatch(
        db,
        movementClaims,
        entries,
        variants,
        pool,
        err,
      );
      if (idempotentResult) return idempotentResult;

      console.error("[inventory/reserve] Batch execution failed:", err);
      return {
        success: false,
        results: entries.map((e) => ({
          success: false,
          variantId: e.variantId,
          previousStock: 0,
          newStock: 0,
          error: "Batch execution failed",
        })),
        error: "Batch execution failed",
      };
    }

    // Phase 5: Verify all movement claims and CAS updates succeeded
    const failedMovementIndices: number[] = [];
    const insertedMovementIds: string[] = [];
    for (let i = 0; i < movementClaims.length; i++) {
      const batchResult = batchResults[i];
      if (!batchResult || batchResult.length === 0) {
        failedMovementIndices.push(i);
      } else {
        insertedMovementIds.push(movementClaims[i]!.id);
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
      // CAS conflict on some variants — roll back all successful claims/updates
      const rollbackQueries = entries
        .filter((_, i) => !failedUpdateIndices.includes(i))
        .map((entry) => {
          return db
            .update(productVariants)
            .set({
              reservedStock: sql`MAX(0, ${productVariants.reservedStock} - ${entry.quantity})`,
              ...(pool === "preorder"
                ? { preorderStock: sql`${productVariants.preorderStock} + ${entry.quantity}` }
                : {}),
              stockVersion: sql`${productVariants.stockVersion} + 1`,
              updatedAt: sql`unixepoch()`,
            })
            .where(eq(productVariants.id, entry.variantId));
        });

      const movementRollbackQueries = insertedMovementIds.map((id) =>
        db.delete(inventoryMovements).where(eq(inventoryMovements.id, id))
      );

      if (rollbackQueries.length > 0 || movementRollbackQueries.length > 0) {
        try {
          await safeBatch(db, [...movementRollbackQueries, ...rollbackQueries] as never);
        } catch (rollbackErr: unknown) {
          console.error("[inventory/reserve] Batch rollback failed:", rollbackErr);
        }
      }

      // Retry if we haven't exhausted attempts
      if (attempt < MAX_RETRIES - 1) {
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, backoff));
        continue;
      }

      return {
        success: false,
        results: entries.map((e, i) => {
          const movementFailed = failedMovementIndices.some(
            (movementIndex) => movementClaims[movementIndex]?.variantId === e.variantId,
          );
          const updateFailed = failedUpdateIndices.includes(i);
          return {
            success: !movementFailed && !updateFailed,
            variantId: e.variantId,
            previousStock: 0,
            newStock: 0,
            error: updateFailed
              ? `CAS conflict for variant ${e.variantId}`
              : movementFailed
                ? `Reservation claim conflict for variant ${e.variantId}`
                : undefined,
          };
        }),
        error: `Failed to reserve stock batch after ${MAX_RETRIES} retries due to concurrent modifications`,
      };
    }

    // Phase 6: All succeeded
    const results: StockOperationResult[] = [];
    for (const entry of entries) {
      const variant = variants.get(entry.variantId)!;
      const previousStock = pool === "preorder" ? variant.preorderStock : variant.stock;
      const newStock = pool === "preorder"
        ? variant.preorderStock - entry.quantity
        : variant.stock;

      results.push({ success: true, variantId: entry.variantId, previousStock, newStock });
    }

    return { success: true, results };
  }

  // Should not reach here, but satisfy TypeScript
  return {
    success: false,
    results: [],
    error: `Failed to reserve stock batch after ${MAX_RETRIES} retries`,
  };
}

type ReservationVariantState = {
  id: string;
  stock: number;
  reservedStock: number;
  preorderStock: number;
  allowPreorder: boolean;
  allowBackorder: boolean;
  backorderLimit: number;
  stockVersion: number;
};

function reservationMovementType(pool: ReservationPool): "reserved" | "preorder_reserved" {
  return pool === "preorder" ? "preorder_reserved" : "reserved";
}

async function createReservationMovementId(input: {
  reservationKey: string;
  orderId: string;
  variantId: string;
  pool: ReservationPool;
  generation: number;
}): Promise<string> {
  const payload = [
    input.reservationKey,
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
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `reservation:${hex}`;
}

async function loadReservationReleaseGeneration(
  db: Database,
  orderId: string,
  variantId: string,
): Promise<number> {
  const result = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.orderId, orderId),
        eq(inventoryMovements.variantId, variantId),
        eq(inventoryMovements.type, "released"),
      ),
    )
    .get();

  return result?.count ?? 0;
}

async function buildReservationMovementClaims(
  db: Database,
  movementEntries: ReservationBatchItem[],
  variants: Map<string, ReservationVariantState>,
  pool: ReservationPool,
  options: ReserveStockBatchOptions,
): Promise<ReservationMovementClaim[]> {
  const claims: ReservationMovementClaim[] = [];
  const type = reservationMovementType(pool);
  const preorderRunningStock = new Map<string, number>();

  for (const entry of movementEntries) {
    const variant = variants.get(entry.variantId)!;
    const previousStock = pool === "preorder"
      ? preorderRunningStock.get(entry.variantId) ?? variant.preorderStock
      : variant.stock;
    const newStock = pool === "preorder" ? previousStock - entry.quantity : variant.stock;
    const reservationKey = entry.reservationKey ?? options.reservationKey;
    const deterministic = Boolean(entry.movementId || (reservationKey && entry.orderId));
    const generation = reservationKey && entry.orderId && !entry.movementId
      ? await loadReservationReleaseGeneration(db, entry.orderId, entry.variantId)
      : 0;
    const id = entry.movementId
      ?? (reservationKey && entry.orderId
        ? await createReservationMovementId({
            reservationKey,
            orderId: entry.orderId,
            variantId: entry.variantId,
            pool,
            generation,
          })
        : crypto.randomUUID());

    if (pool === "preorder") {
      preorderRunningStock.set(entry.variantId, newStock);
    }

    claims.push({
      id,
      deterministic,
      variantId: entry.variantId,
      orderId: entry.orderId,
      type,
      quantity: entry.quantity,
      previousStock,
      newStock,
      notes: `Reserved ${entry.quantity} units (batch)${entry.orderId ? ` for order ${entry.orderId}` : ""}`,
    });
  }

  return claims;
}

function buildReservationMovementInsert(
  db: Database,
  claim: ReservationMovementClaim,
  variant: ReservationVariantState,
) {
  return db
    .insert(inventoryMovements)
    .select(sql`
      SELECT
        ${claim.id},
        ${claim.variantId},
        ${claim.orderId ?? null},
        ${claim.type},
        ${claim.quantity},
        ${claim.previousStock},
        ${claim.newStock},
        ${claim.notes},
        NULL,
        unixepoch()
      FROM ${productVariants}
      WHERE ${productVariants.id} = ${claim.variantId}
        AND ${productVariants.stockVersion} = ${variant.stockVersion}
    `)
    .returning({ id: inventoryMovements.id });
}

function isDuplicateReservationMovementClaimError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("reservation:") ||
    (message.includes("UNIQUE constraint failed") &&
      message.includes("inventory_movements"))
  );
}

async function resolveDuplicateReservationBatch(
  db: Database,
  movementClaims: ReservationMovementClaim[],
  entries: ReservationBatchItem[],
  variants: Map<string, ReservationVariantState>,
  pool: ReservationPool,
  err: unknown,
): Promise<ReserveStockBatchResult | null> {
  const deterministicClaims = movementClaims.filter((claim) => claim.deterministic);
  if (
    deterministicClaims.length === 0 ||
    deterministicClaims.length !== movementClaims.length ||
    !isDuplicateReservationMovementClaimError(err)
  ) {
    return null;
  }

  const existingRows = await db
    .select({
      id: inventoryMovements.id,
      variantId: inventoryMovements.variantId,
      orderId: inventoryMovements.orderId,
      type: inventoryMovements.type,
      quantity: inventoryMovements.quantity,
    })
    .from(inventoryMovements)
    .where(inArray(inventoryMovements.id, deterministicClaims.map((claim) => claim.id)))
    .all();
  const existingById = new Map(existingRows.map((row) => [row.id, row]));
  const mismatched = deterministicClaims.find((claim) => {
    const row = existingById.get(claim.id);
    return !row ||
      row.variantId !== claim.variantId ||
      row.orderId !== (claim.orderId ?? null) ||
      row.type !== claim.type ||
      row.quantity !== claim.quantity;
  });

  if (mismatched) {
    return {
      success: false,
      results: entries.map((entry) => ({
        success: false,
        variantId: entry.variantId,
        previousStock: 0,
        newStock: 0,
        error: "Reservation claim mismatch requires manual inventory reconciliation",
      })),
      error: "Reservation claim mismatch requires manual inventory reconciliation",
      manualReconciliationRequired: true,
    };
  }

  return {
    success: true,
    results: entries.map((entry) => {
      const variant = variants.get(entry.variantId)!;
      return {
        success: true,
        variantId: entry.variantId,
        previousStock: pool === "preorder" ? variant.preorderStock : variant.stock,
        newStock: pool === "preorder"
          ? variant.preorderStock - entry.quantity
          : variant.stock,
      };
    }),
  };
}

export async function validateStockBatchAvailability(
  db: Database,
  items: ReservationBatchItem[],
  pool: ReservationPool = "regular",
): Promise<{ success: boolean; results: StockOperationResult[]; error?: string }> {
  if (items.length === 0) {
    return { success: true, results: [] };
  }

  const entries = mergeReservationItemsByVariant(items);
  const variantLoad = await loadReservationVariantStates(db, entries);
  if (!variantLoad.success) return variantLoad;

  const validationErrors = getStockAvailabilityErrors(entries, variantLoad.variants, pool);
  if (validationErrors.length > 0) {
    return {
      success: false,
      results: validationErrors,
      error: validationErrors[0]?.error,
    };
  }

  return {
    success: true,
    results: entries.map((entry) => {
      const variant = variantLoad.variants.get(entry.variantId)!;
      return {
        success: true,
        variantId: entry.variantId,
        previousStock: pool === "preorder" ? variant.preorderStock : variant.stock,
        newStock:
          pool === "preorder"
            ? variant.preorderStock - entry.quantity
            : variant.stock,
      };
    }),
  };
}

function mergeReservationItemsByVariant(items: ReservationBatchItem[]): ReservationBatchItem[] {
  const merged = new Map<string, ReservationBatchItem>();
  for (const item of items) {
    const existing = merged.get(item.variantId);
    if (existing) {
      existing.quantity += item.quantity;
    } else {
      merged.set(item.variantId, { ...item });
    }
  }
  return Array.from(merged.values());
}

async function loadReservationVariantStates(
  db: Database,
  entries: ReservationBatchItem[],
): Promise<
  | { success: true; variants: Map<string, ReservationVariantState> }
  | { success: false; results: StockOperationResult[]; error: string }
> {
  const variants = new Map<string, ReservationVariantState>();

  for (const entry of entries) {
    const variant = await db
      .select({
        id: productVariants.id,
        stock: productVariants.stock,
        reservedStock: productVariants.reservedStock,
        preorderStock: productVariants.preorderStock,
        allowPreorder: productVariants.allowPreorder,
        allowBackorder: productVariants.allowBackorder,
        backorderLimit: productVariants.backorderLimit,
        stockVersion: productVariants.stockVersion,
      })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(
        and(
          eq(productVariants.id, entry.variantId),
          isNull(productVariants.deletedAt),
          eq(products.isActive, true),
          isNull(products.deletedAt),
        ),
      )
      .get();

    if (!variant) {
      return {
        success: false,
        results: [{
          success: false,
          variantId: entry.variantId,
          previousStock: 0,
          newStock: 0,
          error: `Variant ${entry.variantId} not found`,
        }],
        error: `Variant ${entry.variantId} not found`,
      };
    }
    variants.set(entry.variantId, variant);
  }

  return { success: true, variants };
}

function getStockAvailabilityErrors(
  entries: ReservationBatchItem[],
  variants: Map<string, ReservationVariantState>,
  pool: "regular" | "preorder" | "backorder",
): StockOperationResult[] {
  const validationErrors: StockOperationResult[] = [];
  for (const entry of entries) {
    const variant = variants.get(entry.variantId)!;
    const error = validateStockAvailability(variant, entry.quantity, pool);
    if (error) {
      validationErrors.push({
        success: false,
        variantId: entry.variantId,
        previousStock: pool === "preorder" ? variant.preorderStock : variant.stock,
        newStock: pool === "preorder" ? variant.preorderStock : variant.stock,
        error,
      });
    }
  }
  return validationErrors;
}

export function groupReservationMovementsForAudit(
  items: ReservationBatchItem[],
): ReservationBatchItem[] {
  const grouped = new Map<string, ReservationBatchItem>();

  for (const item of items) {
    const orderKey = item.orderId ?? "";
    const key = `${item.variantId}\0${orderKey}`;
    const existing = grouped.get(key);

    if (existing) {
      existing.quantity += item.quantity;
    } else {
      grouped.set(key, { ...item });
    }
  }

  return Array.from(grouped.values());
}

/**
 * Validate stock availability for a single variant.
 * Returns an error string if insufficient, or null if OK.
 */
function validateStockAvailability(
  variant: {
    id: string;
    stock: number;
    reservedStock: number;
    preorderStock: number;
    allowPreorder: boolean;
    allowBackorder: boolean;
    backorderLimit: number;
  },
  quantity: number,
  pool: "regular" | "preorder" | "backorder"
): string | null {
  if (pool === "preorder") {
    if (!variant.allowPreorder) {
      return `Pre-order not allowed for variant ${variant.id}`;
    }
    if (variant.preorderStock < quantity) {
      return `Insufficient pre-order stock for variant ${variant.id}. Available: ${variant.preorderStock}, Requested: ${quantity}`;
    }
  } else if (pool === "backorder") {
    if (!variant.allowBackorder) {
      return `Backorder not allowed for variant ${variant.id}`;
    }
    if (variant.backorderLimit > 0 && variant.reservedStock + quantity > variant.backorderLimit) {
      return `Backorder limit exceeded for variant ${variant.id}`;
    }
  } else {
    const available = variant.stock - variant.reservedStock;
    if (available < quantity) {
      return `Insufficient stock for variant ${variant.id}. Available: ${available}, Requested: ${quantity}`;
    }
  }
  return null;
}

// Internal helper to avoid circular import with release module
async function releaseReservationInternal(
  db: Database,
  variantId: string,
  quantity: number,
  orderId?: string,
  pool: "regular" | "preorder" | "backorder" = "regular"
): Promise<void> {
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

  // Log the rollback
  await recordMovement(db, {
    variantId,
    orderId,
    type: "released",
    quantity: -quantity,
    previousStock: 0, // Approximate — not critical for rollback logs
    newStock: 0,
    notes: `Reservation rollback (batch failure)`,
  });
}
