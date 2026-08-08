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
import { buildInventoryLedgerV2Edge, type InventoryLedgerPool } from "./ledger-v2";
import { resolveTrackedBuyerAvailabilityBand } from "@scalius/shared/buyer-availability";

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
  /** Released variants whose buyer-visible availability band changed. */
  availabilityTransitionVariantIds: string[];
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
  pool: string | null,
  reservationGeneration: number | null,
): string {
  const poolSuffix = reservationType === "preorder_reserved" ? ":preorder" : "";
  const generationSuffix = reservationGeneration == null
    ? ""
    : `:${pool ?? "regular"}:g${reservationGeneration}`;
  return `expiry_release:${orderId}:${variantId}${poolSuffix}${generationSuffix}`;
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

async function loadReservationOutstandingQuantity(
  db: Database,
  orderId: string,
  variantId: string,
  reservationType: ReservationMovementType,
  pool: string | null,
  reservationGeneration: number | null,
): Promise<number> {
  const deductionType = reservationType === "preorder_reserved"
    ? "preorder_deducted"
    : "deducted";
  const releasePoolCondition = reservationType === "preorder_reserved"
    ? sql`${inventoryMovements.newStock} > ${inventoryMovements.previousStock}`
    : sql`${inventoryMovements.newStock} = ${inventoryMovements.previousStock}`;
  const totals = await db
    .select({
      reservedQuantity: sql<number>`COALESCE(SUM(CASE WHEN ${inventoryMovements.type} = ${reservationType} THEN ${inventoryMovements.quantity} ELSE 0 END), 0)`,
      terminalQuantity: sql<number>`COALESCE(SUM(CASE
        WHEN ${inventoryMovements.type} = ${deductionType} THEN ${inventoryMovements.quantity}
        WHEN ${inventoryMovements.type} = 'released' AND ${releasePoolCondition} THEN -${inventoryMovements.quantity}
        ELSE 0
      END), 0)`,
    })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.orderId, orderId),
        eq(inventoryMovements.variantId, variantId),
        sql`(
          (${inventoryMovements.pool} IS NULL AND ${pool} IS NULL)
          OR ${inventoryMovements.pool} = ${pool}
        )`,
        sql`(
          (${inventoryMovements.reservationGeneration} IS NULL AND ${reservationGeneration} IS NULL)
          OR ${inventoryMovements.reservationGeneration} = ${reservationGeneration}
        )`,
      ),
    )
    .get();

  return Math.max(
    0,
    Number(totals?.reservedQuantity ?? 0) - Number(totals?.terminalQuantity ?? 0),
  );
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
 *   4. Its pool-specific reserved quantity is greater than the quantity
 *      already deducted or released
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
    availabilityTransitionVariantIds: [],
    errors: [],
  };

  // Calculate the cutoff timestamp
  // inventoryMovements.createdAt is stored as unix timestamp (seconds)
  const cutoffSeconds = Math.floor(Date.now() / 1000) - maxAgeMinutes * 60;

  // Find expired reservations: "reserved" movements older than cutoff
  // whose order row no longer exists and whose pool-specific reservation has
  // an outstanding quantity after deductions and releases.
  //
  // We use a subquery approach since D1/SQLite supports it well.
  // Group by (variantId, orderId, reservation type) to handle repeated claims
  // without mixing the regular and preorder pools. Read one sentinel row
  // beyond the processing limit so cron logs can tell whether another bounded
  // pass is needed.
  const outstandingQuantitySql = sql<number>`(
    SUM(${inventoryMovements.quantity}) - COALESCE((
      SELECT SUM(CASE
        WHEN terminal.type = CASE
          WHEN ${inventoryMovements.type} = 'preorder_reserved' THEN 'preorder_deducted'
          ELSE 'deducted'
        END THEN terminal.quantity
        WHEN terminal.type = 'released' AND (
          (${inventoryMovements.type} = 'preorder_reserved' AND terminal.new_stock > terminal.previous_stock)
          OR (${inventoryMovements.type} = 'reserved' AND terminal.new_stock = terminal.previous_stock)
        ) THEN -terminal.quantity
        ELSE 0
      END)
      FROM inventory_movements AS terminal
      WHERE terminal.order_id = ${inventoryMovements.orderId}
        AND terminal.variant_id = ${inventoryMovements.variantId}
        AND (
          (${inventoryMovements.pool} IS NULL AND terminal.pool IS NULL)
          OR terminal.pool = ${inventoryMovements.pool}
        )
        AND (
          (${inventoryMovements.reservationGeneration} IS NULL AND terminal.reservation_generation IS NULL)
          OR terminal.reservation_generation = ${inventoryMovements.reservationGeneration}
        )
    ), 0)
  )`;
  const expiredReservationCandidates = await db
    .select({
      variantId: inventoryMovements.variantId,
      orderId: inventoryMovements.orderId,
      reservationType: inventoryMovements.type,
      pool: inventoryMovements.pool,
      reservationGeneration: inventoryMovements.reservationGeneration,
      totalQuantity: outstandingQuantitySql.as("total_quantity"),
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
      )
    )
    .groupBy(
      inventoryMovements.variantId,
      inventoryMovements.orderId,
      inventoryMovements.type,
      inventoryMovements.pool,
      inventoryMovements.reservationGeneration,
    )
    .having(sql`${outstandingQuantitySql} > 0`)
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
    const reservationGeneration = reservation.reservationGeneration ?? null;
    const movementPool = (reservation.pool
      ?? (reservationType === "preorder_reserved" ? "preorder" : "regular")) as InventoryLedgerPool;

    if (
      !variantId ||
      !orderId ||
      totalQuantity <= 0 ||
      (reservationType !== "reserved" && reservationType !== "preorder_reserved")
    ) continue;

    try {
      if (await reservationOrderExists(db, orderId)) continue;
      const outstandingQuantity = await loadReservationOutstandingQuantity(
        db,
        orderId,
        variantId,
        reservationType,
        reservation.pool ?? null,
        reservationGeneration,
      );
      if (outstandingQuantity <= 0) continue;

      // Read current variant state for the movement log
      const variant = await db
        .select({
          stock: productVariants.stock,
          reservedStock: productVariants.reservedStock,
          preorderStock: productVariants.preorderStock,
          stockVersion: productVariants.stockVersion,
          trackInventory: productVariants.trackInventory,
          allowPreorder: productVariants.allowPreorder,
          lowStockThreshold: productVariants.lowStockThreshold,
        })
        .from(productVariants)
        .where(eq(productVariants.id, variantId))
        .get();

      if (!variant) {
        result.errors.push(`Variant ${variantId} not found (may have been deleted)`);
        continue;
      }

      const isPreorder = reservationType === "preorder_reserved";
      const movementId = createExpiredReleaseMovementId(
        orderId,
        variantId,
        reservationType,
        reservation.pool ?? null,
        reservationGeneration,
      );
      const edge = buildInventoryLedgerV2Edge({
        pool: movementPool,
        reservationGeneration,
        before: {
          stock: variant.stock,
          reservedStock: variant.reservedStock,
          preorderStock: variant.preorderStock,
          stockVersion: variant.stockVersion,
        },
        after: {
          stock: variant.stock,
          reservedStock: variant.reservedStock - outstandingQuantity,
          preorderStock: isPreorder
            ? variant.preorderStock + outstandingQuantity
            : variant.preorderStock,
          stockVersion: variant.stockVersion + 1,
        },
      });
      const notes = `expired ${isPreorder ? "preorder" : movementPool} reservation (age > ${maxAgeMinutes}min, order ${orderId})`;
      const releaseMovement = db.insert(inventoryMovements).select(sql`
        SELECT
          ${movementId},
          ${variantId},
          ${orderId},
          'released',
          ${-outstandingQuantity},
          ${edge.previousStock},
          ${edge.newStock},
          ${notes},
          NULL,
          ${edge.ledgerVersion},
          ${edge.pool},
          ${edge.reservationGeneration},
          ${edge.stockVersionBefore},
          ${edge.stockVersionAfter},
          ${edge.stockDelta},
          ${edge.previousReservedStock},
          ${edge.newReservedStock},
          ${edge.reservedStockDelta},
          ${edge.previousPreorderStock},
          ${edge.newPreorderStock},
          ${edge.preorderStockDelta},
          unixepoch()
        FROM ${productVariants}
        WHERE ${productVariants.id} = ${variantId}
          AND ${productVariants.stockVersion} = ${variant.stockVersion}
          AND ${productVariants.reservedStock} >= ${outstandingQuantity}
      `).returning({ id: inventoryMovements.id });

      // Decrement reservedStock (clamped to 0). The deterministic release
      // movement and stock counter update run in one D1 batch so overlapping
      // cron invocations cannot both claim and apply the same expiry release.
      const releaseCounterUpdate = db
        .update(productVariants)
        .set({
          reservedStock: sql`MAX(0, ${productVariants.reservedStock} - ${outstandingQuantity})`,
          ...(isPreorder
            ? { preorderStock: sql`${productVariants.preorderStock} + ${outstandingQuantity}` }
            : {}),
          stockVersion: sql`${productVariants.stockVersion} + 1`,
          updatedAt: sql`unixepoch()`,
        })
        .where(and(
          eq(productVariants.id, variantId),
          eq(productVariants.stockVersion, variant.stockVersion),
          sql`${productVariants.reservedStock} >= ${outstandingQuantity}`,
        ))
        .returning({ id: productVariants.id });

      const [movementRows, counterRows] = await safeBatch(
        db,
        [releaseMovement, releaseCounterUpdate] as never,
      ) as { id: string }[][];
      if (!movementRows?.length || !counterRows?.length) {
        throw new Error("Expired reservation changed concurrently; retry on the next sweep");
      }

      result.released++;
      if (!result.releasedVariantIds.includes(variantId)) {
        result.releasedVariantIds.push(variantId);
      }
      const reservedAfter = Math.max(0, variant.reservedStock - outstandingQuantity);
      const regularBefore = Math.max(0, variant.stock - variant.reservedStock);
      const regularAfter = Math.max(0, variant.stock - reservedAfter);
      const regularBandChanged = variant.trackInventory
        && resolveTrackedBuyerAvailabilityBand(regularBefore, variant.lowStockThreshold)
          !== resolveTrackedBuyerAvailabilityBand(regularAfter, variant.lowStockThreshold);
      const preorderBecameAvailable = isPreorder
        && variant.trackInventory
        && variant.allowPreorder
        && regularAfter <= 0
        && variant.preorderStock <= 0
        && variant.preorderStock + outstandingQuantity > 0;
      if (
        (regularBandChanged || preorderBecameAvailable)
        && !result.availabilityTransitionVariantIds.includes(variantId)
      ) {
        result.availabilityTransitionVariantIds.push(variantId);
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
