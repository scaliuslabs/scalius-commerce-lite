import { and, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { orders } from "@scalius/database/schema";
import { ConflictError } from "@scalius/core/errors";

export const SHIPMENT_CLAIM_LEASE_SECONDS = 15 * 60;
export const SHIPMENT_CLAIM_CONFLICT_MESSAGE =
    "Order has an active shipment creation in progress. Please retry shortly.";

export type ShipmentClaimSnapshot = {
    shipmentClaimId?: string | null;
    shipmentClaimExpiresAt?: Date | number | string | null;
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

export function hasActiveShipmentClaim(
    snapshot: ShipmentClaimSnapshot,
    nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
    if (!snapshot.shipmentClaimId) return false;
    const expiresAt = toUnixSeconds(snapshot.shipmentClaimExpiresAt);
    return expiresAt === null || expiresAt > nowSeconds;
}

export function assertNoActiveShipmentClaim(snapshot: ShipmentClaimSnapshot): void {
    if (hasActiveShipmentClaim(snapshot)) {
        throw new ConflictError(SHIPMENT_CLAIM_CONFLICT_MESSAGE);
    }
}

export function noActiveShipmentClaimCondition() {
    return or(
        isNull(orders.shipmentClaimId),
        and(
            isNotNull(orders.shipmentClaimExpiresAt),
            lte(orders.shipmentClaimExpiresAt, sql`unixepoch()`),
        ),
    );
}
