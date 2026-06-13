// src/modules/orders/orders.fulfillment.ts
// Fulfillment and status update functions for orders.

import type { Database } from "@scalius/database/client";
import {
    orders,
    orderItems,
    deliveryShipments,
    OrderStatus,
    FulfillmentStatus,
    ItemFulfillmentStatus,
    PaymentMethod,
    PaymentStatus,
    ShipmentStatus,
} from "@scalius/database/schema";
import { applyInventoryForStatusChange } from "../inventory/inventory-transitions";
import { markCODReturned, recordCODCollection, recordCODFailure, validateCODCollectionDetails } from "../payments/cod";
import { createShipment, markShipmentReconciliationRequired } from "../delivery/delivery.service";

import { sql, eq, and } from "drizzle-orm";
import { NotFoundError, ValidationError, ConflictError } from "@scalius/core/errors";
import { validateTransition } from "./order-state-machine";
import type { StatusUpdateResult } from "./orders.types";
import type { OrderNotificationType } from "../notifications/notification-types";
import {
    assertNoActiveShipmentClaim,
    hasActiveShipmentClaim,
    noActiveShipmentClaimCondition,
    SHIPMENT_CLAIM_CONFLICT_MESSAGE,
    SHIPMENT_CLAIM_LEASE_SECONDS,
} from "./shipment-claim";

async function reconcileInventoryForStatus(
    db: Database,
    orderId: string,
    status: string,
): Promise<void> {
    const newInventoryAction = await applyInventoryForStatusChange(db, orderId, status);
    await db.update(orders).set({ inventoryAction: newInventoryAction }).where(eq(orders.id, orderId));
}

function createShipmentClaimId(): string {
    return `shp_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

async function clearShipmentClaim(db: Database, orderId: string, claimId: string): Promise<void> {
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

async function holdShipmentClaimForReconciliation(db: Database, orderId: string, claimId: string): Promise<void> {
    await db
        .update(orders)
        .set({
            shipmentClaimExpiresAt: null,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(orders.id, orderId),
            eq(orders.shipmentClaimId, claimId),
        ));
}

async function resolveExpiredShipmentClaim(
    db: Database,
    orderId: string,
    claimId: string,
): Promise<{ blocked: true; result: Record<string, unknown> } | { blocked: false }> {
    const shipment = await db
        .select({
            id: deliveryShipments.id,
            status: deliveryShipments.status,
            externalId: deliveryShipments.externalId,
            trackingId: deliveryShipments.trackingId,
            metadata: deliveryShipments.metadata,
        })
        .from(deliveryShipments)
        .where(eq(deliveryShipments.id, claimId))
        .get();

    if (!shipment || shipment.status === ShipmentStatus.FAILED || shipment.status === ShipmentStatus.CANCELLED) {
        await clearShipmentClaim(db, orderId, claimId);
        return { blocked: false };
    }

    await markShipmentReconciliationRequired(
        db,
        claimId,
        "expired_order_shipment_claim",
        {
            externalId: shipment.externalId ?? undefined,
            trackingId: shipment.trackingId ?? undefined,
            status: shipment.status,
        },
    );
    await holdShipmentClaimForReconciliation(db, orderId, claimId);
    return {
        blocked: true,
        result: {
            orderId,
            success: false,
            reconciliationRequired: true,
            shipmentId: claimId,
            error: "Previous shipment creation attempt requires reconciliation before retry.",
        },
    };
}

export async function bulkShipOrders(
    db: Database,
    orderIds: string[],
    providerId: string,
    options: Record<string, unknown>,
    encryptionKey?: string,
) {
    const results = [];
    for (const orderId of orderIds) {
        try {
            const order = await db.select({
                status: orders.status,
                version: orders.version,
                shipmentClaimId: orders.shipmentClaimId,
                shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
            }).from(orders).where(eq(orders.id, orderId)).get();
            if (!order) throw new NotFoundError(`Order ${orderId} not found`);
            if (order.status === OrderStatus.SHIPPED) {
                if (order.shipmentClaimId) {
                    await clearShipmentClaim(db, orderId, order.shipmentClaimId);
                }
                await reconcileInventoryForStatus(db, orderId, OrderStatus.SHIPPED);
                results.push({ orderId, success: true, message: "Order already shipped; inventory reconciled" });
                continue;
            }
            if (hasActiveShipmentClaim(order)) {
                results.push({ orderId, success: false, error: SHIPMENT_CLAIM_CONFLICT_MESSAGE });
                continue;
            }
            if (order.shipmentClaimId) {
                const expiredClaim = await resolveExpiredShipmentClaim(db, orderId, order.shipmentClaimId);
                if (expiredClaim.blocked) {
                    results.push(expiredClaim.result);
                    continue;
                }
            }
            validateTransition("order", order.status, OrderStatus.SHIPPED);

            const claimId = createShipmentClaimId();
            const claimResult = await db.update(orders).set({
                shipmentClaimId: claimId,
                shipmentClaimExpiresAt: sql`unixepoch() + ${SHIPMENT_CLAIM_LEASE_SECONDS}`,
                version: order.version + 1,
                updatedAt: sql`unixepoch()`,
            }).where(and(
                eq(orders.id, orderId),
                eq(orders.version, order.version),
                eq(orders.status, order.status),
                noActiveShipmentClaimCondition(),
            )).returning({ id: orders.id });

            if (claimResult.length === 0) {
                results.push({ orderId, success: false, error: "Order was modified concurrently" });
                continue;
            }

            const shipment = await createShipment(db, orderId, providerId, options, encryptionKey, { shipmentId: claimId });
            if (shipment.reconciliationRequired) {
                await holdShipmentClaimForReconciliation(db, orderId, claimId);
                results.push({
                    orderId,
                    success: false,
                    shipmentId: claimId,
                    reconciliationRequired: true,
                    error: shipment.message,
                });
                continue;
            }
            if (shipment.success) {
                // CAS update first — only apply inventory if we win the version check
                const casResult = await db.update(orders).set({
                    status: OrderStatus.SHIPPED,
                    fulfillmentStatus: FulfillmentStatus.COMPLETE,
                    shipmentClaimId: null,
                    shipmentClaimExpiresAt: null,
                    version: order.version + 2,
                    updatedAt: sql`unixepoch()`,
                }).where(and(
                    eq(orders.id, orderId),
                    eq(orders.version, order.version + 1),
                    eq(orders.shipmentClaimId, claimId),
                )).returning({ id: orders.id });

                if (casResult.length === 0) {
                    await markShipmentReconciliationRequired(
                        db,
                        claimId,
                        "order_final_cas_conflict",
                        shipment.data,
                        "Order was modified concurrently after provider shipment creation",
                    );
                    await holdShipmentClaimForReconciliation(db, orderId, claimId);
                    results.push({
                        orderId,
                        success: false,
                        shipmentId: claimId,
                        reconciliationRequired: true,
                        error: "Shipment was created but order finalization requires reconciliation",
                    });
                    continue;
                }

                await reconcileInventoryForStatus(db, orderId, OrderStatus.SHIPPED);
            } else {
                await clearShipmentClaim(db, orderId, claimId);
            }
            results.push({ orderId, success: shipment.success, shipment: shipment.success ? shipment : undefined, error: shipment.success ? undefined : shipment.message });
        } catch (error: unknown) {
            results.push({ orderId, success: false, error: error instanceof Error ? error.message : String(error) });
        }
    }
    return results;
}

export async function processCodAction(db: Database, orderId: string, body: Record<string, unknown>) {
    const order = await db.select({
        status: orders.status,
        version: orders.version,
        totalAmount: orders.totalAmount,
        paidAmount: orders.paidAmount,
        balanceDue: orders.balanceDue,
        shipmentClaimId: orders.shipmentClaimId,
        shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
    }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order) throw new NotFoundError("Order not found");
    assertNoActiveShipmentClaim(order);

    switch (body.action) {
        case "collected": {
            const collection = validateCODCollectionDetails(order, {
                collectedBy: body.collectedBy as string,
                collectedAmount: body.collectedAmount as number,
            });

            // Validate transition to DELIVERED. If current status is CONFIRMED,
            // transition through SHIPPED first (COD collection implies delivery).
            let currentVersion = order.version;
            let currentStatus = order.status;
            if (order.status === OrderStatus.CONFIRMED) {
                validateTransition("order", order.status, OrderStatus.SHIPPED);
                const shipResult = await db.update(orders).set({ status: OrderStatus.SHIPPED, version: currentVersion + 1, updatedAt: sql`unixepoch()` }).where(and(eq(orders.id, orderId), eq(orders.version, currentVersion))).returning({ id: orders.id });
                if (shipResult.length === 0) throw new ConflictError("Order was modified by another request. Please reload and try again.");
                currentVersion += 1;
                currentStatus = OrderStatus.SHIPPED;
            }
            if (currentStatus !== OrderStatus.DELIVERED) {
                validateTransition("order", currentStatus, OrderStatus.DELIVERED);
                const delResult = await db.update(orders).set({ status: OrderStatus.DELIVERED, version: currentVersion + 1, updatedAt: sql`unixepoch()` }).where(and(eq(orders.id, orderId), eq(orders.version, currentVersion))).returning({ id: orders.id });
                if (delResult.length === 0) throw new ConflictError("Order was modified by another request. Please reload and try again.");
            }
            await reconcileInventoryForStatus(db, orderId, OrderStatus.DELIVERED);
            const colResult = await recordCODCollection(db, { orderId, collectedBy: collection.collectedBy, collectedAmount: collection.collectedAmount, receiptUrl: body.receiptUrl as string | undefined });
            if (!colResult.success) throw new ValidationError(colResult.error || "COD collection failed");
            return { message: "COD collection recorded" };
        }
        case "failed": {
            const failResult = await recordCODFailure(db, { orderId, reason: body.reason as "other" | "not_home" | "refused" | "no_cash" | "wrong_address", notes: body.notes as string | undefined });
            if (!failResult.success) throw new ValidationError(failResult.error || "COD failure recording failed");
            return { message: "COD failure recorded" };
        }
        case "returned": {
            if (order.status !== OrderStatus.RETURNED) {
                validateTransition("order", order.status, OrderStatus.RETURNED);
                const retCasResult = await db.update(orders).set({ status: OrderStatus.RETURNED, version: order.version + 1, updatedAt: sql`unixepoch()` }).where(and(eq(orders.id, orderId), eq(orders.version, order.version))).returning({ id: orders.id });
                if (retCasResult.length === 0) throw new ConflictError("Order was modified by another request. Please reload and try again.");
            }
            const retResult = await markCODReturned(db, orderId);
            if (!retResult.success) throw new ValidationError(retResult.error || "COD return failed");
            await reconcileInventoryForStatus(db, orderId, OrderStatus.RETURNED);
            return { message: "Order marked as returned" };
        }
        default:
            throw new ValidationError("Invalid action");
    }
}

export async function getOrderShipments(db: Database, orderId: string) {
    return db.select().from(deliveryShipments).where(eq(deliveryShipments.orderId, orderId)).all();
}

export async function createFulfillmentShipment(db: Database, orderId: string, body: Record<string, unknown>) {
    const order = await db.select({
        id: orders.id,
        status: orders.status,
        fulfillmentStatus: orders.fulfillmentStatus,
        version: orders.version,
        shipmentClaimId: orders.shipmentClaimId,
        shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
    }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order) throw new NotFoundError("Order not found");
    assertNoActiveShipmentClaim(order);
    if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.RETURNED) {
        throw new ValidationError("Cannot fulfill a cancelled/returned order");
    }

    const allItems = await db.select({ id: orderItems.id, fulfillmentStatus: orderItems.fulfillmentStatus }).from(orderItems).where(eq(orderItems.orderId, orderId)).all();
    const shipmentItemIds = (body.itemIds as string[] | undefined) ?? allItems.map((i) => i.id);

    const alreadyFulfilled = allItems.filter((i) => (shipmentItemIds as string[]).includes(i.id) && (i.fulfillmentStatus === ItemFulfillmentStatus.SHIPPED || i.fulfillmentStatus === ItemFulfillmentStatus.DELIVERED));
    if (alreadyFulfilled.length > 0) throw new ConflictError(`Items already shipped: ${alreadyFulfilled.map((i) => i.id).join(", ")}`);

    const shipmentId = `shp_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const now = new Date();
    const unfulfilledItemIds = allItems.filter((i) => i.fulfillmentStatus === ItemFulfillmentStatus.PENDING || i.fulfillmentStatus === ItemFulfillmentStatus.PICKED || i.fulfillmentStatus === ItemFulfillmentStatus.PACKED).map((i) => i.id);
    const isFinalShipment = (body.isFinalShipment as boolean | undefined) ?? ((shipmentItemIds as string[]).every((sid: string) => unfulfilledItemIds.includes(sid)) && unfulfilledItemIds.every((uid) => (shipmentItemIds as string[]).includes(uid)));

    const newFulfillmentStatus = isFinalShipment ? FulfillmentStatus.COMPLETE : FulfillmentStatus.PARTIAL;
    const orderUpdate: Record<string, unknown> = {
        fulfillmentStatus: newFulfillmentStatus,
        version: order.version + 1,
        updatedAt: sql`unixepoch()`,
    };
    const shouldShipOrder = isFinalShipment && order.status === OrderStatus.CONFIRMED;
    if (shouldShipOrder) {
        validateTransition("order", order.status, OrderStatus.SHIPPED);
        orderUpdate.status = OrderStatus.SHIPPED;
    }

    const orderClaim = await db.update(orders).set(orderUpdate).where(and(
        eq(orders.id, orderId),
        eq(orders.version, order.version),
        eq(orders.status, order.status),
        eq(orders.fulfillmentStatus, order.fulfillmentStatus),
    )).returning({ id: orders.id });

    if (orderClaim.length === 0) {
        throw new ConflictError("Order was modified by another request. Please reload and try again.");
    }

    // Drizzle D1 batch() requires specific tuple types
    const writes: unknown[] = [];

    writes.push(db.insert(deliveryShipments).values({
        id: shipmentId, orderId, trackingId: (body.trackingId as string | undefined) ?? null, trackingUrl: (body.trackingUrl as string | undefined) ?? null,
        courierName: (body.courierName as string | undefined) ?? null, status: "processing", note: (body.note as string | undefined) ?? null,
        shipmentItems: JSON.stringify(shipmentItemIds), shipmentAmount: (body.shipmentAmount as number | undefined) ?? null, isFinalShipment,
        createdAt: now, updatedAt: now,
    }));

    for (const itemId of shipmentItemIds as string[]) {
        writes.push(db.update(orderItems).set({ fulfillmentStatus: ItemFulfillmentStatus.SHIPPED }).where(eq(orderItems.id, itemId)));
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    await db.batch(writes as any);

    const shouldReconcileShipmentInventory =
        isFinalShipment &&
        (shouldShipOrder || order.status === OrderStatus.SHIPPED || order.status === OrderStatus.DELIVERED);

    if (shouldReconcileShipmentInventory) {
        await reconcileInventoryForStatus(
            db,
            orderId,
            order.status === OrderStatus.DELIVERED ? OrderStatus.DELIVERED : OrderStatus.SHIPPED,
        );
    }

    return { shipmentId, isFinalShipment, fulfillmentStatus: newFulfillmentStatus };
}

// Statuses that warrant a customer notification email
const NOTIFICATION_STATUSES: Record<string, OrderNotificationType> = {
    pending: "order_created",
    confirmed: "order_confirmed",
    processing: "order_processing",
    shipped: "order_shipped",
    delivered: "order_delivered",
    completed: "order_completed",
    cancelled: "order_cancelled",
    returned: "order_returned",
    refunded: "order_refunded",
};

export async function updateOrderStatus(db: Database, orderId: string, status: string, data?: { trackingId?: string }): Promise<StatusUpdateResult> {
    const existingOrder = await db.select({
        status: orders.status,
        inventoryAction: orders.inventoryAction,
        version: orders.version,
        customerName: orders.customerName,
        customerEmail: orders.customerEmail,
        paymentMethod: orders.paymentMethod,
        paymentStatus: orders.paymentStatus,
        shipmentClaimId: orders.shipmentClaimId,
        shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
    }).from(orders).where(eq(orders.id, orderId)).get();
    if (!existingOrder) throw new NotFoundError("Order not found");
    assertNoActiveShipmentClaim(existingOrder);
    if (existingOrder.status === status) {
        await reconcileInventoryForStatus(db, orderId, status);
        return { message: "Status unchanged; inventory reconciled" };
    }

    // Validate the status transition before applying any side effects
    validateTransition("order", existingOrder.status, status);

    // Auto-sync payment status for COD orders when delivered/completed
    const isCod = existingOrder.paymentMethod === PaymentMethod.COD;
    const isDeliveredOrCompleted = status === OrderStatus.DELIVERED || status === OrderStatus.COMPLETED;
    const shouldMarkPaid = isCod && isDeliveredOrCompleted && existingOrder.paymentStatus !== PaymentStatus.PAID;

    // Optimistic locking: CAS update FIRST — only proceed with side effects
    // if we win the version check. This prevents the race condition where two
    // concurrent callers (e.g. admin + webhook) both apply inventory before
    // either detects the conflict.
    const result = await db.update(orders).set({
        status,
        version: existingOrder.version + 1,
        updatedAt: sql`unixepoch()`,
        ...(shouldMarkPaid ? { paymentStatus: PaymentStatus.PAID } : {}),
    }).where(and(
        eq(orders.id, orderId),
        eq(orders.version, existingOrder.version),
    )).returning({ id: orders.id });

    if (result.length === 0) {
        throw new ConflictError("Order was modified by another request. Please reload and try again.");
    }

    // CAS succeeded — we own this transition. Now apply inventory side effects.
    await reconcileInventoryForStatus(db, orderId, status);

    // Build notification payload if the new status warrants one
    const notificationType = NOTIFICATION_STATUSES[status];
    const notification = notificationType
        ? {
            orderId,
            customerEmail: existingOrder.customerEmail ?? undefined,
            customerName: existingOrder.customerName,
            notificationType,
            ...(status === OrderStatus.SHIPPED && data?.trackingId
                ? { trackingId: data.trackingId }
                : {}),
        }
        : undefined;

    return { message: "Order status updated successfully", notification };
}
