// Helpers shared by the fulfilment actions. Not exported from the domain entry.
import type { Database } from "@scalius/database/client";
import {
    orders,
    deliveryShipments,
    OrderStatus,
} from "@scalius/database/schema";
import { sql, eq, and } from "drizzle-orm";

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

export async function clearShipmentClaim(db: Database, orderId: string, claimId: string): Promise<void> {
    await db
        .update(orders)
        .set({
            shipmentClaimId: null,
            shipmentClaimExpiresAt: null,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(orders.id, orderId),
            eq(orders.shipmentClaimId, claimId),
        ));
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
