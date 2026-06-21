// src/lib/inventory/restore.ts
// Restores deducted stock when a shipped/delivered order is cancelled or returned.
// For regular pool: increments `stock` (physical inventory restored).
// For preorder/backorder pool: no stock change needed (stock was never decremented).

import { eq, sql } from "drizzle-orm";
import { productVariants } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { recordMovement } from "./movements";
import { checkAndAlertLowStock } from "./alerts";
import type { ReservationEntry, StockOperationResult } from "./types";

/**
 * Restore deducted stock for a single variant.
 * Used when a post-shipment order is cancelled or returned.
 *
 * For regular pool: increments `stock` (undoes the deduction).
 * For preorder pool: restores `preorderStock`.
 * For backorder pool: no-op on stock counters (backorder never decremented).
 */
export async function restoreDeductedStock(
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

  const updateSet =
    pool === "regular"
      ? {
          stock: sql`${productVariants.stock} + ${quantity}`,
          stockVersion: sql`${productVariants.stockVersion} + 1`,
          updatedAt: sql`unixepoch()`,
        }
      : pool === "preorder"
        ? {
            preorderStock: sql`${productVariants.preorderStock} + ${quantity}`,
            stockVersion: sql`${productVariants.stockVersion} + 1`,
            updatedAt: sql`unixepoch()`,
          }
        : {
            // backorder: no stock counter to restore, just bump version
            stockVersion: sql`${productVariants.stockVersion} + 1`,
            updatedAt: sql`unixepoch()`,
          };

  await db
    .update(productVariants)
    .set(updateSet)
    .where(eq(productVariants.id, variantId));

  const newStock =
    pool === "regular"
      ? variant.stock + quantity
      : pool === "preorder"
        ? variant.preorderStock + quantity
        : variant.stock;

  await recordMovement(db, {
    variantId,
    orderId,
    type: "restored",
    quantity,
    previousStock,
    newStock,
    notes: `Deducted stock restored${orderId ? ` for order ${orderId}` : ""}`,
  });

  // Auto-resolve low stock alerts when stock is restored
  await checkAndAlertLowStock(db, variantId);

  return { success: true, variantId, previousStock, newStock };
}

/**
 * Restore deducted stock for multiple variants.
 * Best-effort: continues even if individual restores fail.
 */
export async function restoreDeductedMultiple(
  db: Database,
  entries: ReservationEntry[],
  orderId?: string
): Promise<{ success: boolean; results: StockOperationResult[]; error?: string }> {
  const results: StockOperationResult[] = [];
  let anyFailed = false;
  let lastError: string | undefined;

  for (const entry of entries) {
    const result = await restoreDeductedStock(
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
      console.error(
        `[inventory/restore] Failed to restore deducted stock for variant ${entry.variantId}: ${result.error}`
      );
    }
  }

  return {
    success: !anyFailed,
    results,
    error: anyFailed ? lastError : undefined,
  };
}
