// src/lib/inventory/deduct.ts
// Permanent stock deduction on payment confirmation.
// Converts a reservation into a permanent deduction:
//   - Decrements `stock` (actual inventory level)
//   - Decrements `reservedStock` (releases the hold)
// For pre-orders: stock was already pulled from preorderStock at reservation time,
//   so we only decrement reservedStock.

import { eq, and, sql } from "drizzle-orm";
import { productVariants } from "@/db/schema";
import type { Database } from "@/db";
import { recordMovement } from "./movements";
import type { ReservationEntry, StockOperationResult } from "./types";

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 50;

/**
 * Permanently deduct reserved stock after payment is confirmed.
 * Uses optimistic locking to ensure atomicity.
 *
 * For regular pool: decrements both `stock` and `reservedStock`.
 * For preorder pool: decrements only `reservedStock` (preorderStock was already
 *   pulled at reservation time).
 * For backorder pool: decrements only `reservedStock` (stock may stay negative
 *   conceptually; the merchant fulfills later).
 */
export async function deductStock(
  db: Database,
  variantId: string,
  quantity: number,
  orderId?: string,
  pool: "regular" | "preorder" | "backorder" = "regular"
): Promise<StockOperationResult> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const variant = await db
      .select({
        id: productVariants.id,
        stock: productVariants.stock,
        reservedStock: productVariants.reservedStock,
        preorderStock: productVariants.preorderStock,
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

    const previousStock = pool === "preorder" ? variant.preorderStock : variant.stock;

    // Build the update: always release the reservation; for regular pool also
    // decrement the physical stock counter.
    const updateSet =
      pool === "regular"
        ? {
            stock: sql`MAX(0, ${productVariants.stock} - ${quantity})`,
            reservedStock: sql`MAX(0, ${productVariants.reservedStock} - ${quantity})`,
            version: sql`${productVariants.version} + 1`,
            updatedAt: sql`unixepoch()`,
          }
        : {
            // preorder & backorder: physical stock counter unchanged; just release hold
            reservedStock: sql`MAX(0, ${productVariants.reservedStock} - ${quantity})`,
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
      const newStock =
        pool === "regular"
          ? Math.max(0, variant.stock - quantity)
          : pool === "preorder"
          ? variant.preorderStock
          : variant.stock;

      await recordMovement(db, {
        variantId,
        orderId,
        type: pool === "preorder" ? "preorder_deducted" : "deducted",
        quantity,
        previousStock,
        newStock,
        notes: `Stock deducted on payment confirmation${orderId ? ` for order ${orderId}` : ""}`,
      });

      return { success: true, variantId, previousStock, newStock };
    }

    // Version conflict — backoff and retry
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
    error: `Failed to deduct stock after ${MAX_RETRIES} retries due to concurrent modifications`,
  };
}

/**
 * Deduct stock for multiple variants.
 * If any deduction fails, rolls back the ones that succeeded.
 */
export async function deductMultiple(
  db: Database,
  entries: ReservationEntry[],
  orderId?: string
): Promise<{ success: boolean; results: StockOperationResult[]; error?: string }> {
  const results: StockOperationResult[] = [];
  const succeeded: ReservationEntry[] = [];

  for (const entry of entries) {
    const result = await deductStock(
      db,
      entry.variantId,
      entry.quantity,
      orderId,
      entry.pool ?? "regular"
    );
    results.push(result);

    if (!result.success) {
      // Roll back by re-adding deducted stock for those that succeeded
      for (const done of succeeded) {
        await restoreDeductedStock(db, done.variantId, done.quantity, orderId, done.pool ?? "regular");
      }
      return {
        success: false,
        results,
        error: result.error ?? `Failed to deduct stock for variant ${entry.variantId}`,
      };
    }

    succeeded.push(entry);
  }

  return { success: true, results };
}

// Internal: undo a deduction (used for rollback only)
async function restoreDeductedStock(
  db: Database,
  variantId: string,
  quantity: number,
  orderId?: string,
  pool: "regular" | "preorder" | "backorder" = "regular"
): Promise<void> {
  await db
    .update(productVariants)
    .set({
      ...(pool === "regular"
        ? { stock: sql`${productVariants.stock} + ${quantity}` }
        : {}),
      reservedStock: sql`${productVariants.reservedStock} + ${quantity}`,
      version: sql`${productVariants.version} + 1`,
      updatedAt: sql`unixepoch()`,
    })
    .where(eq(productVariants.id, variantId));

  await recordMovement(db, {
    variantId,
    orderId,
    type: "adjusted",
    quantity,
    previousStock: 0,
    newStock: 0,
    notes: `Deduction rollback (batch failure)`,
  });
}
