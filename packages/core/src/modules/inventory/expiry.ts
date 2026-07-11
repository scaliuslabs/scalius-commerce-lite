// src/lib/inventory/expiry.ts
// Reservation timeout logic: releases orphaned/expired reservations.
// Designed to be called from a queue consumer or cron trigger.

import { eq, and, sql, lt } from "drizzle-orm";
import {
  inventoryMovements,
  orders,
  productVariants,
} from "@scalius/database/schema";
import { safeBatch, type Database } from "@scalius/database/client";

export const DEFAULT_EXPIRY_SWEEP_LIMIT = 50;
export const MAX_EXPIRY_SWEEP_LIMIT = 200;

/**
 * Result of an expiry sweep, for observability.
 */
export interface ExpiryResult {
  /** Number of expired reservations found */
  found: number;
  /** Maximum number of reservation groups considered in this sweep */
  limit: number;
  /** True when at least one additional expired reservation group remains */
  hasMore: boolean;
  /** Number of reservations successfully released */
  released: number;
  /** Variant IDs that were released */
  releasedVariantIds: string[];
  /** Any errors encountered (non-fatal) */
  errors: string[];
}

export interface ExpirySweepOptions {
  /** Maximum reservation groups to process in one invocation. Defaults to 50. */
  limit?: number;
}

type ReservationMovementType = "reserved" | "preorder_reserved";

function normalizeExpirySweepLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_EXPIRY_SWEEP_LIMIT;
  if (!Number.isFinite(limit)) return DEFAULT_EXPIRY_SWEEP_LIMIT;
  return Math.max(1, Math.min(MAX_EXPIRY_SWEEP_LIMIT, Math.floor(limit)));
}

function createExpiredReleaseMovementId(
  orderId: string,
  variantId: string,
  reservationType: ReservationMovementType,
): string {
  const poolSuffix = reservationType === "preorder_reserved" ? ":preorder" : "";
  return `expiry_release:${orderId}:${variantId}${poolSuffix}`;
}

async function reservationOrderExists(
  db: Database,
  orderId: string
): Promise<boolean> {
  const order = await db
    .select({
      id: orders.id,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .get();

  return Boolean(order);
}

async function reservationHasTerminalMovement(
  db: Database,
  orderId: string,
  variantId: string,
  reservationType: ReservationMovementType,
): Promise<boolean> {
  const deductionType = reservationType === "preorder_reserved"
    ? "preorder_deducted"
    : "deducted";
  const releasePoolCondition = reservationType === "preorder_reserved"
    ? sql`${inventoryMovements.newStock} > ${inventoryMovements.previousStock}`
    : sql`${inventoryMovements.newStock} = ${inventoryMovements.previousStock}`;
  const movement = await db
    .select({
      movementId: inventoryMovements.id,
    })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.orderId, orderId),
        eq(inventoryMovements.variantId, variantId),
        sql`(
          ${inventoryMovements.type} = ${deductionType}
          OR (
            ${inventoryMovements.type} = 'released'
            AND ${releasePoolCondition}
          )
        )`,
      ),
    )
    .get();

  return Boolean(movement);
}

function isDuplicateExpiryReleaseClaimError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("expiry_release:") ||
    (message.includes("UNIQUE constraint failed") &&
      message.includes("inventory_movements"))
  );
}

/**
 * Find and release orphaned expired stock reservations.
 *
 * A reservation is "expired" when:
 *   1. It is an inventory_movement of type "reserved" (or "preorder_reserved")
 *   2. It was created more than `maxAgeMinutes` ago
 *   3. It is orphaned from its order row
 *   4. There is no corresponding "deducted" movement for the same order
 *      (meaning payment was never confirmed)
 *   5. There is no corresponding "released" movement for the same order
 *      (meaning it hasn't already been released)
 *
 * For each expired reservation, this function:
 *   - Decrements `reservedStock` on the variant
 *   - Restores `preorderStock` for expired preorder reservations
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
 * @param options.limit - Maximum reservation groups to process in one invocation (default: 50, max: 200)
 */
export async function releaseExpiredReservations(
  db: Database,
  maxAgeMinutes = 30,
  options: ExpirySweepOptions = {},
): Promise<ExpiryResult> {
  const limit = normalizeExpirySweepLimit(options.limit);
  const result: ExpiryResult = {
    found: 0,
    limit,
    hasMore: false,
    released: 0,
    releasedVariantIds: [],
    errors: [],
  };

  // Calculate the cutoff timestamp
  // inventoryMovements.createdAt is stored as unix timestamp (seconds)
  const cutoffSeconds = Math.floor(Date.now() / 1000) - maxAgeMinutes * 60;

  // Find expired reservations: "reserved" movements older than cutoff
  // whose order row no longer exists, and do NOT have a corresponding
  // "deducted" or "released" movement for the same order.
  //
  // We use a subquery approach since D1/SQLite supports it well.
  // Group by (variantId, orderId, reservation type) to handle repeated claims
  // without mixing the regular and preorder pools. Read one sentinel row
  // beyond the processing limit so cron logs can tell whether another bounded
  // pass is needed.
  const expiredReservationCandidates = await db
    .select({
      variantId: inventoryMovements.variantId,
      orderId: inventoryMovements.orderId,
      reservationType: inventoryMovements.type,
      totalQuantity: sql<number>`SUM(${inventoryMovements.quantity})`.as("total_quantity"),
    })
    .from(inventoryMovements)
    .where(
      and(
        sql`${inventoryMovements.type} IN ('reserved', 'preorder_reserved')`,
        lt(inventoryMovements.createdAt, new Date(cutoffSeconds * 1000)),
        sql`${inventoryMovements.orderId} IS NOT NULL`,
        // Active/live orders may remain reserved for longer than the checkout
        // timeout. Order cancellation must go through order transition logic;
        // this sweeper only cleans up inventory movements whose order row was
        // never committed or has otherwise disappeared.
        sql`NOT EXISTS (
          SELECT 1 FROM orders AS o
          WHERE o.id = ${inventoryMovements}.order_id
        )`,
        // No corresponding pool-specific deduction for this order. A regular
        // deduction must not hide an expired preorder claim (or vice versa).
        sql`NOT EXISTS (
          SELECT 1 FROM inventory_movements AS im2
          WHERE im2.order_id = ${inventoryMovements}.order_id
            AND im2.variant_id = ${inventoryMovements}.variant_id
            AND im2.type = CASE
              WHEN ${inventoryMovements}.type = 'preorder_reserved' THEN 'preorder_deducted'
              ELSE 'deducted'
            END
        )`,
        // No corresponding release from the same pool. Preorder release rows
        // increase the tracked pool (new_stock > previous_stock); regular and
        // backorder releases leave physical stock unchanged.
        sql`NOT EXISTS (
          SELECT 1 FROM inventory_movements AS im3
          WHERE im3.order_id = ${inventoryMovements}.order_id
            AND im3.variant_id = ${inventoryMovements}.variant_id
            AND im3.type = 'released'
            AND (
              (${inventoryMovements}.type = 'preorder_reserved' AND im3.new_stock > im3.previous_stock)
              OR (${inventoryMovements}.type = 'reserved' AND im3.new_stock = im3.previous_stock)
            )
        )`
      )
    )
    .groupBy(
      inventoryMovements.variantId,
      inventoryMovements.orderId,
      inventoryMovements.type,
    )
    .orderBy(sql`MIN(${inventoryMovements.createdAt})`)
    .limit(limit + 1)
    .all();

  const expiredReservations = expiredReservationCandidates.slice(0, limit);
  result.found = expiredReservations.length;
  result.hasMore = expiredReservationCandidates.length > limit;

  if (expiredReservations.length === 0) {
    return result;
  }

  // Release each expired reservation
  for (const reservation of expiredReservations) {
    const { variantId, orderId, totalQuantity } = reservation;
    const reservationType = reservation.reservationType as ReservationMovementType;

    if (
      !variantId ||
      !orderId ||
      totalQuantity <= 0 ||
      (reservationType !== "reserved" && reservationType !== "preorder_reserved")
    ) continue;

    try {
      if (await reservationOrderExists(db, orderId)) continue;
      if (await reservationHasTerminalMovement(
        db,
        orderId,
        variantId,
        reservationType,
      )) continue;

      // Read current variant state for the movement log
      const variant = await db
        .select({
          stock: productVariants.stock,
          reservedStock: productVariants.reservedStock,
          preorderStock: productVariants.preorderStock,
        })
        .from(productVariants)
        .where(eq(productVariants.id, variantId))
        .get();

      if (!variant) {
        result.errors.push(`Variant ${variantId} not found (may have been deleted)`);
        continue;
      }

      const isPreorder = reservationType === "preorder_reserved";
      const previousStock = isPreorder ? variant.preorderStock : variant.stock;
      const newStock = isPreorder
        ? variant.preorderStock + totalQuantity
        : variant.stock;
      const movementId = createExpiredReleaseMovementId(
        orderId,
        variantId,
        reservationType,
      );
      const releaseMovement = db.insert(inventoryMovements).values({
        id: movementId,
        variantId,
        orderId,
        type: "released",
        quantity: -totalQuantity,
        previousStock,
        newStock,
        notes: `expired ${isPreorder ? "preorder" : "regular"} reservation (age > ${maxAgeMinutes}min, order ${orderId})`,
        createdBy: null,
        createdAt: new Date(),
      });

      // Decrement reservedStock (clamped to 0). The deterministic release
      // movement and stock counter update run in one D1 batch so overlapping
      // cron invocations cannot both claim and apply the same expiry release.
      const releaseCounterUpdate = db
        .update(productVariants)
        .set({
          reservedStock: sql`MAX(0, ${productVariants.reservedStock} - ${totalQuantity})`,
          ...(isPreorder
            ? { preorderStock: sql`${productVariants.preorderStock} + ${totalQuantity}` }
            : {}),
          stockVersion: sql`${productVariants.stockVersion} + 1`,
          updatedAt: sql`unixepoch()`,
        })
        .where(eq(productVariants.id, variantId));

      await safeBatch(db, [releaseMovement, releaseCounterUpdate]);

      result.released++;
      if (!result.releasedVariantIds.includes(variantId)) {
        result.releasedVariantIds.push(variantId);
      }
    } catch (err: unknown) {
      if (isDuplicateExpiryReleaseClaimError(err)) continue;

      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Failed to release variant ${variantId}: ${msg}`);
      console.error(`[inventory/expiry] Failed to release expired reservation for variant ${variantId}:`, err);
    }
  }

  if (result.released > 0) {
    console.log(
      `[inventory/expiry] Released ${result.released}/${result.found} expired reservations ` +
        `(maxAge=${maxAgeMinutes}min, limit=${result.limit}, hasMore=${result.hasMore}, ` +
        `variants: ${result.releasedVariantIds.join(", ")})`
    );
  }

  return result;
}
