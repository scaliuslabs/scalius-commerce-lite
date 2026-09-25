// Pickup (Wave A §2.4): "Mark ready for pickup" is a notification-only fact
// on the order (no stock moves); "Mark picked up" is a `pickup` fulfilment
// recorded through the ledger (recordOrderFulfilment, optionally with the
// cash taken at the counter).
import { buildBatchGuard, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import {
    notificationOutbox,
    orders,
    FulfillmentStatus,
    OrderStatus,
} from "@scalius/database/schema";
import type { BatchItem } from "drizzle-orm/batch";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import {
    buildOrderReadyForPickupNotificationDedupeKey,
    createOrderNotificationOutboxInsertValues,
} from "../notifications/order-notification-outbox";
import { assertNoActiveShipmentClaim, noActiveShipmentClaimCondition } from "../orders/shipment-claim";

const PICKUP_READY_GUARD = "ORDER_PICKUP_READY_CONFLICT";
const OPEN_PICKUP_STATUSES = [OrderStatus.PENDING, OrderStatus.PROCESSING, OrderStatus.CONFIRMED] as const;

export interface MarkReadyForPickupResult {
    orderId: string;
    pickupReadyAt: string;
    replayed: boolean;
    /** The notification row written in the same batch; enqueue it after commit. */
    notificationOutboxId: string | null;
}

function epochIso(value: Date | number | null): string {
    const date = value instanceof Date ? value : new Date((value ?? 0) * 1000);
    return date.toISOString();
}

/**
 * Marks a pickup order ready to collect (CAS on the order version) and
 * writes the `order_ready_for_pickup` notification in the same batch. A
 * repeat returns the first mark. The "Ready for pickup" list is simply
 * `pickup_ready_at IS NOT NULL AND fulfillment_status <> 'complete'`.
 */
export async function markOrderReadyForPickup(
    db: Database,
    orderId: string,
): Promise<MarkReadyForPickupResult> {
    const order = await db.select({
        status: orders.status,
        version: orders.version,
        shippingMethodKind: orders.shippingMethodKind,
        pickupReadyAt: orders.pickupReadyAt,
        fulfillmentStatus: orders.fulfillmentStatus,
        shipmentClaimId: orders.shipmentClaimId,
        shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
        deletedAt: orders.deletedAt,
    }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order || order.deletedAt) throw new NotFoundError("Order not found");
    if (order.shippingMethodKind !== "pickup") {
        throw new ValidationError("Only an order the buyer collects can be marked ready for pickup.");
    }
    if (order.pickupReadyAt) {
        return { orderId, pickupReadyAt: epochIso(order.pickupReadyAt), replayed: true, notificationOutboxId: null };
    }
    if (!(OPEN_PICKUP_STATUSES as readonly string[]).includes(order.status)) {
        throw new ValidationError(order.status === OrderStatus.CANCELLED
            ? "A cancelled order can't be marked ready."
            : "This order was already collected or closed.");
    }
    if (order.fulfillmentStatus === FulfillmentStatus.COMPLETE) {
        throw new ValidationError("This order was already collected.");
    }
    assertNoActiveShipmentClaim(order);

    const claimedVersion = order.version + 1;
    const outbox = createOrderNotificationOutboxInsertValues({
        dedupeKey: buildOrderReadyForPickupNotificationDedupeKey({ orderId, version: claimedVersion }),
        orderId,
        notificationType: "order_ready_for_pickup",
        source: "orders-pickup-ready",
    });
    const statements: BatchItem<"sqlite">[] = [
        db.update(orders).set({
            pickupReadyAt: sql`unixepoch()`,
            version: claimedVersion,
            updatedAt: sql`unixepoch()`,
        }).where(and(
            eq(orders.id, orderId),
            eq(orders.version, order.version),
            isNull(orders.pickupReadyAt),
            eq(orders.shippingMethodKind, "pickup"),
            inArray(orders.status, [...OPEN_PICKUP_STATUSES]),
            ne(orders.fulfillmentStatus, FulfillmentStatus.COMPLETE),
            noActiveShipmentClaimCondition(),
        )) as BatchItem<"sqlite">,
        buildBatchGuard(db, sql`EXISTS (
            SELECT 1 FROM ${orders} WHERE ${orders.id} = ${orderId} AND ${orders.version} = ${claimedVersion}
        )`, PICKUP_READY_GUARD),
        db.insert(notificationOutbox).values(outbox)
            .onConflictDoNothing({ target: notificationOutbox.dedupeKey }) as BatchItem<"sqlite">,
    ];
    try {
        await safeBatch(db, statements);
    } catch (error) {
        if (isBatchGuardError(error, PICKUP_READY_GUARD)) {
            const current = await db.select({ pickupReadyAt: orders.pickupReadyAt })
                .from(orders).where(eq(orders.id, orderId)).get();
            if (current?.pickupReadyAt) {
                return { orderId, pickupReadyAt: epochIso(current.pickupReadyAt), replayed: true, notificationOutboxId: null };
            }
            throw new ConflictError("This order changed. Reload to see the latest.");
        }
        throw error;
    }
    const saved = await db.select({ pickupReadyAt: orders.pickupReadyAt })
        .from(orders).where(eq(orders.id, orderId)).get();
    return {
        orderId,
        pickupReadyAt: epochIso(saved?.pickupReadyAt ?? new Date()),
        replayed: false,
        notificationOutboxId: String(outbox.id),
    };
}
