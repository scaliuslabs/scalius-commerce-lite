// src/lib/inventory/expiry.ts
// Reservation timeout logic: releases orphaned/expired reservations.
// Designed to be called from a queue consumer or cron trigger.

import { eq, and, sql, lt } from "drizzle-orm";
import { inventoryMovements, productVariants } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { recordMovement } from "./movements";

/**
 * Result of an expiry sweep, for observability.
 */
export interface ExpiryResult {
  /** Number of expired reservations found */
  found: number;
  /** Number of reservations successfully released */
  released: number;
  /** Variant IDs that were released */
  releasedVariantIds: string[];
  /** Any errors encountered (non-fatal) */
  errors: string[];
}

/**
 * Find and release expired stock reservations.
 *
 * A reservation is "expired" when:
 *   1. It is an inventory_movement of type "reserved" (or "preorder_reserved")
 *   2. It was created more than `maxAgeMinutes` ago
 *   3. There is no corresponding "deducted" movement for the same order
 *      (meaning payment was never confirmed)
 *   4. There is no corresponding "released" movement for the same order
 *      (meaning it hasn't already been released)
 *
 * For each expired reservation, this function:
 *   - Decrements `reservedStock` on the variant
 *   - Records a "released" movement with note "expired reservation"
 *
 * This function is IDEMPOTENT: running it multiple times will not
 * double-release, because released reservations get a matching "released"
 * movement that excludes them from future sweeps.
 *
 * Designed to be called from a Cloudflare Queue consumer or Cron Trigger.
 *
 * @param db - Drizzle database instance
 * @param maxAgeMinutes - Maximum age in minutes before a reservation expires (default: 30)
 */
export async function releaseExpiredReservations(
  db: Database,
  maxAgeMinutes = 30
): Promise<ExpiryResult> {
  const result: ExpiryResult = {
    found: 0,
    released: 0,
    releasedVariantIds: [],
    errors: [],
  };

  // Calculate the cutoff timestamp
  // inventoryMovements.createdAt is stored as unix timestamp (seconds)
  const cutoffSeconds = Math.floor(Date.now() / 1000) - maxAgeMinutes * 60;

  // Find expired reservations: "reserved" movements older than cutoff
  // that do NOT have a corresponding "deducted" or "released" movement
  // for the same order.
  //
  // We use a subquery approach since D1/SQLite supports it well.
  // Group by (variantId, orderId) to handle cases where multiple
  // reservation movements exist for the same order+variant.
  const expiredReservations = await db
    .select({
      variantId: inventoryMovements.variantId,
      orderId: inventoryMovements.orderId,
      totalQuantity: sql<number>`SUM(${inventoryMovements.quantity})`.as("total_quantity"),
    })
    .from(inventoryMovements)
    .where(
      and(
        sql`${inventoryMovements.type} IN ('reserved', 'preorder_reserved')`,
        lt(inventoryMovements.createdAt, new Date(cutoffSeconds * 1000)),
        sql`${inventoryMovements.orderId} IS NOT NULL`,
        // No corresponding deduction for this order
        sql`NOT EXISTS (
          SELECT 1 FROM inventory_movements AS im2
          WHERE im2.order_id = ${inventoryMovements}.order_id
            AND im2.variant_id = ${inventoryMovements}.variant_id
            AND im2.type IN ('deducted', 'preorder_deducted')
        )`,
        // No corresponding release for this order (prevents double-release)
        sql`NOT EXISTS (
          SELECT 1 FROM inventory_movements AS im3
          WHERE im3.order_id = ${inventoryMovements}.order_id
            AND im3.variant_id = ${inventoryMovements}.variant_id
            AND im3.type = 'released'
            AND im3.notes LIKE '%expired reservation%'
        )`
      )
    )
    .groupBy(inventoryMovements.variantId, inventoryMovements.orderId)
    .all();

  result.found = expiredReservations.length;

  if (expiredReservations.length === 0) {
    return result;
  }

  // Release each expired reservation
  for (const reservation of expiredReservations) {
    const { variantId, orderId, totalQuantity } = reservation;

    if (!variantId || totalQuantity <= 0) continue;

    try {
      // Read current variant state for the movement log
      const variant = await db
        .select({
          stock: productVariants.stock,
          reservedStock: productVariants.reservedStock,
        })
        .from(productVariants)
        .where(eq(productVariants.id, variantId))
        .get();

      if (!variant) {
        result.errors.push(`Variant ${variantId} not found (may have been deleted)`);
        continue;
      }

      // Decrement reservedStock (clamped to 0)
      await db
        .update(productVariants)
        .set({
          reservedStock: sql`MAX(0, ${productVariants.reservedStock} - ${totalQuantity})`,
          version: sql`${productVariants.version} + 1`,
          updatedAt: sql`unixepoch()`,
        })
        .where(eq(productVariants.id, variantId));

      // Record the release movement
      const previousReserved = variant.reservedStock;
      const newReserved = Math.max(0, previousReserved - totalQuantity);

      await recordMovement(db, {
        variantId,
        orderId: orderId ?? undefined,
        type: "released",
        quantity: -totalQuantity,
        previousStock: variant.stock,
        newStock: variant.stock, // physical stock doesn't change
        notes: `expired reservation (age > ${maxAgeMinutes}min, order ${orderId ?? "unknown"})`,
      });

      result.released++;
      result.releasedVariantIds.push(variantId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Failed to release variant ${variantId}: ${msg}`);
      console.error(`[inventory/expiry] Failed to release expired reservation for variant ${variantId}:`, err);
    }
  }

  if (result.released > 0) {
    console.log(
      `[inventory/expiry] Released ${result.released}/${result.found} expired reservations ` +
        `(maxAge=${maxAgeMinutes}min, variants: ${result.releasedVariantIds.join(", ")})`
    );
  }

  return result;
}
