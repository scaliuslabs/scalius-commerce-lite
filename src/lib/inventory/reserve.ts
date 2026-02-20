// src/lib/inventory/reserve.ts
// Optimistic-locking stock reservation.
// Reserves stock by incrementing reservedStock WITHOUT decrementing stock.
// Stock is permanently deducted only on payment confirmation.

import { eq, and, sql, gte } from "drizzle-orm";
import { productVariants } from "@/db/schema";
import type { Database } from "@/db";
import { recordMovement } from "./movements";
import type { ReservationEntry, StockOperationResult } from "./types";

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 50;

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
        version: productVariants.version,
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
            version: sql`${productVariants.version} + 1`,
            updatedAt: sql`unixepoch()`,
          }
        : {
            reservedStock: sql`${productVariants.reservedStock} + ${quantity}`,
            version: sql`${productVariants.version} + 1`,
            updatedAt: sql`unixepoch()`,
          };

    const result = await db
      .update(productVariants)
      .set(updateSet)
      .where(
        and(
          eq(productVariants.id, variantId),
          eq(productVariants.version, variant.version)
        )
      ) as unknown as { rowsAffected: number };

    if (result.rowsAffected > 0) {
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
      version: sql`${productVariants.version} + 1`,
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
