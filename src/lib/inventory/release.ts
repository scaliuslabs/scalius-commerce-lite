// src/lib/inventory/release.ts
// Releases stock reservations when an order is cancelled or payment fails.
// Decrements reservedStock (and restores preorderStock for pre-order pool).

import { eq, sql } from "drizzle-orm";
import { productVariants } from "@/db/schema";
import type { Database } from "@/db";
import { recordMovement } from "./movements";
import type { ReservationEntry, StockOperationResult } from "./types";

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
  const variant = await db
    .select({
      id: productVariants.id,
      stock: productVariants.stock,
      reservedStock: productVariants.reservedStock,
      preorderStock: productVariants.preorderStock,
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
