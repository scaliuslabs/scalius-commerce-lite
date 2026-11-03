import { and, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { orders } from "@scalius/database/schema";
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
        throw new ConflictError(SHIPMENT_CLAIM_CONFLICT_MESSAGE);
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

/** Orders whose shipment claim lease has run out (the partial claim index holds only claimed orders). */
export function expiredShipmentClaimCondition() {
    return and(
        isNotNull(orders.shipmentClaimId),
        isNotNull(orders.shipmentClaimExpiresAt),
        lte(orders.shipmentClaimExpiresAt, sql`unixepoch()`),
    );
}
