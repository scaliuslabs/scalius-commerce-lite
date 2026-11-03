// src/lib/inventory/expiry.ts
// Reservation timeout logic: releases orphaned/expired reservations.
// Designed to be called from the cron's sweep rotation.

import { catalogBuyerStateRefreshStatementsForSkus, effectiveLowStockThresholdSql } from "../products";
import { eq, and, sql, lt, gte, type SQL } from "drizzle-orm";
import {
  inventoryMovements,
  orders,
  productVariants,
} from "@scalius/database/schema";
import { safeBatch, type Database } from "@scalius/database/client";
import { buildInventoryLedgerV2Edge, ledgerVersionKeyRead, type InventoryLedgerPool } from "./ledger-v2";
import { resolveTrackedBuyerAvailabilityBand } from "@scalius/shared/buyer-availability";

export const DEFAULT_EXPIRY_SWEEP_LIMIT = 50;
export const MAX_EXPIRY_SWEEP_LIMIT = 200;
/**
 * An orphan appears within minutes of its checkout, so the routine sweep reads
 * only reservations this much older than the expiry cutoff: its cost follows
 * recent checkouts, not the whole ledger. The nightly history pass walks the
 * older reservations a bounded span at a time (`sweepExpiredReservationHistory`),
 * e.g. holds left while the sweep was down.
 */
export const EXPIRY_SWEEP_WINDOW_SECONDS = 7 * 24 * 60 * 60;
/** The history the nightly pass reads in one night, at most. */
export const EXPIRY_HISTORY_SPAN_SECONDS = 30 * 24 * 60 * 60;

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
  /** The first reservation time (unix seconds) of the last group read, for a cursor. */
  lastCreatedAt: number | null;
}

export interface ExpirySweepOptions {
  /** Maximum reservation groups to process in one invocation. Defaults to 50. */
  limit?: number;
  /**
   * Read reservations created in [createdFrom, createdBefore) (unix seconds)
   * instead of the recent window; `createdBefore` never passes the expiry cutoff.
   */
  createdFrom?: number;
  createdBefore?: number;
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

/** Legacy holds have no pool column; their new v2 expiry edge names the inferred pool. */
function effectiveReservationPoolSql(pool: SQL, reservationType: SQL): SQL<string> {
  return sql<string>`COALESCE(${pool}, CASE WHEN ${reservationType} = 'preorder_reserved' THEN 'preorder' ELSE 'regular' END)`;
}

/** V2 identifies the pool explicitly; only legacy rows encode it in stock snapshots. */
function terminalReservationQuantitySql(reservationType: SQL, alias: "inventory_movements" | "terminal"): SQL<number> {
  const column = (name: string) => sql.raw(`"${alias}"."${name}"`);
  return sql<number>`CASE
    WHEN ${column("type")} = CASE WHEN ${reservationType} = 'preorder_reserved' THEN 'preorder_deducted' ELSE 'deducted' END
      THEN ${column("quantity")}
    WHEN ${column("type")} = 'released' AND (
      ${column("ledger_version")} = 2
      OR (${reservationType} = 'preorder_reserved' AND ${column("new_stock")} > ${column("previous_stock")})
      OR (${reservationType} = 'reserved' AND ${column("new_stock")} = ${column("previous_stock")})
    ) THEN -${column("quantity")}
    ELSE 0
  END`;
}

async function loadReservationOutstandingQuantity(
  db: Database,
  orderId: string,
  variantId: string,
  reservationType: ReservationMovementType,
  pool: string | null,
  reservationGeneration: number | null,
): Promise<number> {
  const totals = await db
    .select({
      reservedQuantity: sql<number>`COALESCE(SUM(CASE WHEN ${inventoryMovements.type} = ${reservationType} THEN ${inventoryMovements.quantity} ELSE 0 END), 0)`,
      terminalQuantity: sql<number>`COALESCE(SUM(${terminalReservationQuantitySql(sql`${reservationType}`, "inventory_movements")}), 0)`,
    })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.orderId, orderId),
        eq(inventoryMovements.variantId, variantId),
        sql`${effectiveReservationPoolSql(sql`${inventoryMovements.pool}`, sql`${reservationType}`)}
          = ${effectiveReservationPoolSql(sql`${pool}`, sql`${reservationType}`)}`,
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
 *   2. It was created more than `maxAgeMinutes` ago, within
 *      `EXPIRY_SWEEP_WINDOW_SECONDS` before that (or the given range)
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
 * Called from the cron's sweep rotation.
 *
 * @param db - Drizzle database instance
 * @param maxAgeMinutes - Maximum age in minutes before a reservation expires (default: 30)
 * @param options.limit - Maximum reservation groups to process in one invocation (default: 50, max: 200)
 * @param options.createdFrom - With createdBefore: the range read instead of the recent window
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
    lastCreatedAt: null,
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
  // Drizzle leaves a column of a single-table select list unqualified, so an
  // outer reference rendered there inside the aliased subquery would bind to
  // `terminal` instead. The HAVING clause qualifies its columns, and the loop
  // below re-reads each group's exact outstanding quantity, so the select list
  // carries only the group key.
  const outstandingQuantitySql = sql<number>`(
    SUM(${inventoryMovements.quantity}) - COALESCE((
      SELECT SUM(${terminalReservationQuantitySql(sql`${inventoryMovements.type}`, "terminal")})
      FROM inventory_movements AS terminal
      WHERE terminal.order_id = ${inventoryMovements.orderId}
        AND terminal.variant_id = ${inventoryMovements.variantId}
        AND ${effectiveReservationPoolSql(sql`terminal.pool`, sql`${inventoryMovements.type}`)}
          = ${effectiveReservationPoolSql(sql`${inventoryMovements.pool}`, sql`${inventoryMovements.type}`)}
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
      firstCreatedAt: sql<number>`MIN(${inventoryMovements.createdAt})`,
    })
    .from(inventoryMovements)
    .where(
      and(
        sql`${inventoryMovements.type} IN ('reserved', 'preorder_reserved')`,
        lt(inventoryMovements.createdAt, new Date(Math.min(cutoffSeconds, options.createdBefore ?? cutoffSeconds) * 1000)),
        gte(inventoryMovements.createdAt, new Date((options.createdFrom ?? cutoffSeconds - EXPIRY_SWEEP_WINDOW_SECONDS) * 1000)),
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
  const lastRead = expiredReservations.at(-1)?.firstCreatedAt;
  result.lastCreatedAt = lastRead === undefined || lastRead === null ? null : Number(lastRead);

  if (expiredReservations.length === 0) {
    return result;
  }

  // Release each expired reservation
  for (const reservation of expiredReservations) {
    const { variantId, orderId } = reservation;
    const reservationType = reservation.reservationType as ReservationMovementType;
    const reservationGeneration = reservation.reservationGeneration ?? null;
    const movementPool = (reservation.pool
      ?? (reservationType === "preorder_reserved" ? "preorder" : "regular")) as InventoryLedgerPool;

    if (
      !variantId ||
      !orderId ||
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
          lowStockThreshold: effectiveLowStockThresholdSql(),
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
          unixepoch(),
          NULL
        FROM ${productVariants}
        WHERE ${productVariants.id} = ${variantId}
          AND ${productVariants.stockVersion} = ${variant.stockVersion}
          AND ${productVariants.reservedStock} >= ${outstandingQuantity}
          ${ledgerVersionKeyRead(edge.stockVersionAfter)}
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
        [
          releaseMovement,
          releaseCounterUpdate,
          // Buyer state reads the counters this batch just wrote.
          ...catalogBuyerStateRefreshStatementsForSkus(db, [variantId]),
        ] as never,
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

/**
 * The nightly history pass: reservations older than the routine window, a
 * bounded span at a time from the persisted cursor (`after`, unix seconds),
 * each night starting at the first reservation at or after it. The cursor
 * moves past what it read, failures included, and wraps to the start (null)
 * once it reaches the routine window.
 */
export async function sweepExpiredReservationHistory(
  db: Database,
  options: { after: number | null; limit?: number; spanSeconds?: number; maxAgeMinutes?: number },
): Promise<{ result: ExpiryResult | null; next: number | null }> {
  const maxAgeMinutes = options.maxAgeMinutes ?? 30;
  const windowStart = Math.floor(Date.now() / 1000) - maxAgeMinutes * 60 - EXPIRY_SWEEP_WINDOW_SECONDS;
  const after = new Date((options.after ?? 0) * 1000);
  // The first reservation of each type at or after the cursor: one index row each.
  const firsts = await Promise.all((["reserved", "preorder_reserved"] as const).map((type) =>
    db.select({ createdAt: inventoryMovements.createdAt })
      .from(inventoryMovements)
      .where(and(eq(inventoryMovements.type, type), gte(inventoryMovements.createdAt, after)))
      .orderBy(inventoryMovements.createdAt)
      .limit(1)
      .get()));
  const starts = firsts.flatMap((row) => (row?.createdAt ? [Math.floor(row.createdAt.getTime() / 1000)] : []));
  const from = starts.length > 0 ? Math.min(...starts) : null;
  if (from === null || from >= windowStart) return { result: null, next: null };
  const before = Math.min(from + (options.spanSeconds ?? EXPIRY_HISTORY_SPAN_SECONDS), windowStart);
  const result = await releaseExpiredReservations(db, maxAgeMinutes, { limit: options.limit, createdFrom: from, createdBefore: before });
  const next = result.hasMore && result.lastCreatedAt !== null ? result.lastCreatedAt + 1 : before;
  return { result, next: next >= windowStart ? null : next };
}
