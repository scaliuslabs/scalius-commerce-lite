// Helpers shared by the fulfilment actions. Not exported from the domain entry.
import { safeBatch, type Database } from "@scalius/database/client";
import {
    orders,
    deliveryShipments,
    OrderStatus,
} from "@scalius/database/schema";
import { sql, eq, and } from "drizzle-orm";
import { requeueShipmentClaimParkedPaymentEvents } from "../order-kernel";

export function parseShipmentMetadata(metadata: unknown): Record<string, unknown> {
    if (!metadata) return {};
    if (typeof metadata === "string") {
        try {
            const parsed = JSON.parse(metadata) as unknown;
            return parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? parsed as Record<string, unknown>
                : {};
        } catch {
            return {};
        }
    }

    return metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? metadata as Record<string, unknown>
        : {};
}

/** Ends the order's claim, and makes the payment events it parked due now. */
export async function clearShipmentClaim(db: Database, orderId: string, claimId: string): Promise<void> {
    await safeBatch(db, [
        db
            .update(orders)
            .set({
                shipmentClaimId: null,
                shipmentClaimExpiresAt: null,
                updatedAt: sql`unixepoch()`,
            })
            .where(and(
                eq(orders.id, orderId),
                eq(orders.shipmentClaimId, claimId),
            )),
        requeueShipmentClaimParkedPaymentEvents(db, orderId),
    ]);
}

export const SENDABLE_ORDER_STATUSES = new Set<string>([
    OrderStatus.CONFIRMED,
    OrderStatus.SHIPPED,
    OrderStatus.DELIVERED,
]);

export async function findShipmentByRequestKey(db: Database, orderId: string, requestKey: string) {
    const rows = await db.select({
        id: deliveryShipments.id,
        isFinalShipment: deliveryShipments.isFinalShipment,
        metadata: deliveryShipments.metadata,
    }).from(deliveryShipments).where(and(
        eq(deliveryShipments.orderId, orderId),
        eq(deliveryShipments.providerType, "manual"),
    )).all();
    return rows.find((row) => parseShipmentMetadata(row.metadata).requestKey === requestKey) ?? null;
}
