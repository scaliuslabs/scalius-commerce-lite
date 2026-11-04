import { and, eq, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { orders, webhookEvents } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { ConflictError } from "@scalius/core/errors";

export const SHIPMENT_CLAIM_LEASE_SECONDS = 15 * 60;
export const SHIPMENT_CLAIM_CONFLICT_MESSAGE =
    "Shipment creation or recovery is active. Check shipment history before trying again.";

export type ShipmentClaimSnapshot = {
    shipmentClaimId?: string | null;
    shipmentClaimExpiresAt?: Date | number | string | null;
    /**
     * The status of the claim's own shipment row (`null`: no such row), when
     * the caller read it. Absent: unknown, so an expired claim still locks.
     */
    shipmentClaimShipmentStatus?: string | null;
};

function toUnixSeconds(value: ShipmentClaimSnapshot["shipmentClaimExpiresAt"]): number | null {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return Math.floor(value.getTime() / 1000);
    if (typeof value === "number") return value > 1_000_000_000_000 ? Math.floor(value / 1000) : value;
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

/**
 * The claim's lease is still running: a booking may be in flight right now.
 * Only the code that resolves expired claims asks this; every other guard
 * asks `hasActiveShipmentClaim`.
 */
export function isShipmentClaimLeaseLive(
    snapshot: ShipmentClaimSnapshot,
    nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
    if (!snapshot.shipmentClaimId) return false;
    const expiresAt = toUnixSeconds(snapshot.shipmentClaimExpiresAt);
    return expiresAt === null || expiresAt > nowSeconds;
}

/**
 * A claim held for reconciliation (its lease removed): no booking is running,
 * and it stays until staff or the maintenance sweep resolve its attempt.
 */
export function isShipmentClaimHeld(snapshot: ShipmentClaimSnapshot): boolean {
    return Boolean(snapshot.shipmentClaimId) && toUnixSeconds(snapshot.shipmentClaimExpiresAt) === null;
}

/** Shipment row states that prove an attempt left nothing booked. */
const RELEASED_SHIPMENT_STATUSES = new Set(["failed", "cancelled"]);

/**
 * Whether a shipment claim locks the order. An expired lease does not unlock
 * it by itself: a booking that died after its `creating` row may have reached
 * the courier. An expired claim stops locking only once its shipment row is
 * known to be absent, failed or cancelled (`shipmentClaimShipmentStatus`,
 * `null` for no row); without that fact it still locks, and the maintenance
 * sweep resolves it (`resolveExpiredShipmentClaim`).
 */
export function hasActiveShipmentClaim(
    snapshot: ShipmentClaimSnapshot,
    nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
    if (!snapshot.shipmentClaimId) return false;
    if (isShipmentClaimLeaseLive(snapshot, nowSeconds)) return true;
    const status = snapshot.shipmentClaimShipmentStatus;
    if (status === undefined) return true;
    return status !== null && !RELEASED_SHIPMENT_STATUSES.has(status);
}

export function assertNoActiveShipmentClaim(snapshot: ShipmentClaimSnapshot): void {
    if (hasActiveShipmentClaim(snapshot)) {
        throw new ShipmentClaimConflictError();
    }
}

/**
 * The SQL form of `!hasActiveShipmentClaim` for an order row: no claim, or an
 * expired one whose shipment row is absent, failed or cancelled.
 */
export function noActiveShipmentClaimCondition() {
    // Qualified by hand: a Drizzle column directly in a single-table select
    // list renders unqualified and would bind to the inner alias.
    const claimId = sql.raw(`"orders"."shipment_claim_id"`);
    return or(
        isNull(orders.shipmentClaimId),
        and(
            isNotNull(orders.shipmentClaimExpiresAt),
            lte(orders.shipmentClaimExpiresAt, sql`unixepoch()`),
            sql`NOT EXISTS (
                SELECT 1 FROM delivery_shipments AS claim_shipment
                WHERE claim_shipment.id = ${claimId}
                  AND claim_shipment.status NOT IN ('failed', 'cancelled')
            )`,
        ),
    );
}

/**
 * Whether a shipment claim locks the order `orderId` names, for a statement
 * on another table: `noActiveShipmentClaimCondition`, negated, over that
 * order's row (its primary key), so it answers exactly as the guard does.
 */
export function shipmentClaimLocksOrderSql(orderId: SQL) {
    return sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${sql.raw(`"orders"."id"`)} = ${orderId} AND NOT (${noActiveShipmentClaimCondition()}))`;
}

/**
 * The status of an order row's claimed attempt (NULL: no claim, or no such
 * row), for an order read: select it as `shipmentClaimShipmentStatus` beside
 * the claim columns, so `hasActiveShipmentClaim` answers exactly as
 * `noActiveShipmentClaimCondition` does, in the same query.
 */
export function shipmentClaimShipmentStatusSql() {
    // Qualified by hand: it lands in single-table select lists.
    return sql<string | null>`(SELECT claim_attempt.status FROM delivery_shipments AS claim_attempt
        WHERE claim_attempt.id = ${sql.raw(`"orders"."shipment_claim_id"`)})`;
}

/** Orders whose shipment claim lease has run out (the partial claim index holds only claimed orders). */
export function expiredShipmentClaimCondition() {
    return and(
        isNotNull(orders.shipmentClaimId),
        isNotNull(orders.shipmentClaimExpiresAt),
        lte(orders.shipmentClaimExpiresAt, sql`unixepoch()`),
    );
}

/**
 * A refusal because a shipment claim locks the order (a booking in flight, or
 * a dead one waiting for the sweep or staff): nothing else was wrong, so a
 * caller that retries waits for the claim instead of counting attempts.
 */
export class ShipmentClaimConflictError extends ConflictError {
    constructor() {
        super(SHIPMENT_CLAIM_CONFLICT_MESSAGE);
    }
}

export function isShipmentClaimConflictError(error: unknown): error is ShipmentClaimConflictError {
    return error instanceof ShipmentClaimConflictError;
}

/**
 * The `result.reason` of a payment event parked because a shipment claim
 * locked its order: it waits without spending its attempts (apps/api
 * utils/webhook-idempotency.ts) until the claim goes.
 */
export const SHIPMENT_CLAIM_PARKED_PAYMENT_EVENT = "shipment_claim";

/**
 * The order's parked payment events, due now. Every write that ends an
 * order's claim sends it in the same batch (`clearShipmentClaim`, a staff
 * resolution, a deleted attempt), so a payment that waited for a booking is
 * recorded on the payment drain's next tick, not after its backstop delay.
 * The order's events only (its index); harmless when none is parked, and a
 * claim that still locks parks them again.
 */
export function requeueShipmentClaimParkedPaymentEvents(db: Database, orderId: string) {
    return db.update(webhookEvents).set({ nextAttemptAt: sql`unixepoch()` }).where(and(
        eq(webhookEvents.orderId, orderId),
        eq(webhookEvents.status, "retrying"),
        sql`json_extract(${webhookEvents.result}, '$.reason') = ${SHIPMENT_CLAIM_PARKED_PAYMENT_EVENT}`,
    ));
}
