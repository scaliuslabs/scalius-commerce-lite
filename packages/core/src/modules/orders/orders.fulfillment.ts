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
} from "@scalius/database/schema";
import { applyInventoryForStatusChange } from "../inventory/inventory-transitions";
import { markCODReturned, recordCODCollection, recordCODFailure } from "../payments/cod";
import { DeliveryService } from "../delivery/service";

import { sql, eq, and } from "drizzle-orm";
import { NotFoundError, ValidationError, ConflictError } from "@scalius/core/errors";
import { validateTransition } from "./order-state-machine";
import type { StatusUpdateResult } from "./orders.types";

const deliveryService = new DeliveryService();

export async function bulkShipOrders(db: Database, orderIds: string[], providerId: string, options: Record<string, unknown>) {
    const results = [];
    for (const orderId of orderIds) {
        try {
            const shipment = await deliveryService.createShipment(orderId, providerId, options);
            if (shipment.success) {
                const newInventoryAction = await applyInventoryForStatusChange(db, orderId, OrderStatus.SHIPPED);
                await db.update(orders).set({
                    status: OrderStatus.SHIPPED,
                    fulfillmentStatus: FulfillmentStatus.COMPLETE,
                    inventoryAction: newInventoryAction,
                    updatedAt: sql`unixepoch()`,
                }).where(eq(orders.id, orderId));
            }
            results.push({ orderId, success: shipment.success, shipment: shipment.success ? shipment : undefined, error: shipment.success ? undefined : shipment.message });
        } catch (error: unknown) {
            results.push({ orderId, success: false, error: error instanceof Error ? error.message : String(error) });
        }
    }
    return results;
}

export async function processCodAction(db: Database, orderId: string, body: Record<string, unknown>) {
    switch (body.action) {
        case "collected": {
            const colResult = await recordCODCollection(db, { orderId, collectedBy: body.collectedBy as string, collectedAmount: body.collectedAmount as number, receiptUrl: body.receiptUrl as string | undefined });
            if (!colResult.success) throw new ValidationError(colResult.error || "COD collection failed");
            await db.update(orders).set({ status: OrderStatus.DELIVERED, updatedAt: sql`unixepoch()` }).where(eq(orders.id, orderId));
            return { success: true, message: "COD collection recorded" };
        }
        case "failed": {
            const failResult = await recordCODFailure(db, { orderId, reason: body.reason as "other" | "not_home" | "refused" | "no_cash" | "wrong_address", notes: body.notes as string | undefined });
            if (!failResult.success) throw new ValidationError(failResult.error || "COD failure recording failed");
            return { success: true, message: "COD failure recorded" };
        }
        case "returned": {
            const retResult = await markCODReturned(db, orderId);
            if (!retResult.success) throw new ValidationError(retResult.error || "COD return failed");
            await applyInventoryForStatusChange(db, orderId, OrderStatus.RETURNED);
            await db.update(orders).set({ status: OrderStatus.RETURNED, updatedAt: sql`unixepoch()` }).where(eq(orders.id, orderId));
            return { success: true, message: "Order marked as returned" };
        }
        default:
            throw new ValidationError("Invalid action");
    }
}

export async function getOrderShipments(db: Database, orderId: string) {
    return db.select().from(deliveryShipments).where(eq(deliveryShipments.orderId, orderId)).all();
}

export async function createFulfillmentShipment(db: Database, orderId: string, body: Record<string, unknown>) {
    const order = await db.select({ id: orders.id, status: orders.status, fulfillmentStatus: orders.fulfillmentStatus }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order) throw new NotFoundError("Order not found");
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

    const orderUpdate: Record<string, unknown> = { fulfillmentStatus: newFulfillmentStatus, updatedAt: sql`unixepoch()` };
    if (isFinalShipment && order.status === OrderStatus.CONFIRMED) orderUpdate.status = OrderStatus.SHIPPED;

    writes.push(db.update(orders).set(orderUpdate).where(eq(orders.id, orderId)));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    await db.batch(writes as any);

    if (isFinalShipment && order.status === OrderStatus.CONFIRMED) {
        await applyInventoryForStatusChange(db, orderId, OrderStatus.SHIPPED).catch(console.error);
    }

    return { success: true, shipmentId, isFinalShipment, fulfillmentStatus: newFulfillmentStatus };
}

// Statuses that warrant a customer notification email
const NOTIFICATION_STATUSES: Record<string, "order_shipped" | "order_delivered"> = {
    shipped: "order_shipped",
    delivered: "order_delivered",
};

export async function updateOrderStatus(db: Database, orderId: string, status: string): Promise<StatusUpdateResult> {
    const existingOrder = await db.select({
        status: orders.status,
        inventoryAction: orders.inventoryAction,
        version: orders.version,
        customerName: orders.customerName,
        customerEmail: orders.customerEmail,
        paymentMethod: orders.paymentMethod,
        paymentStatus: orders.paymentStatus,
    }).from(orders).where(eq(orders.id, orderId)).get();
    if (!existingOrder) throw new NotFoundError("Order not found");
    if (existingOrder.status === status) return { message: "Status unchanged" };

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
    const newInventoryAction = await applyInventoryForStatusChange(db, orderId, status);

    // Persist the new inventory action (version was already bumped above)
    await db.update(orders).set({
        inventoryAction: newInventoryAction,
    }).where(eq(orders.id, orderId));

    // Build notification payload if the new status warrants one
    const notificationType = NOTIFICATION_STATUSES[status];
    const notification = notificationType
        ? {
            orderId,
            customerEmail: existingOrder.customerEmail ?? undefined,
            customerName: existingOrder.customerName,
            notificationType,
        }
        : undefined;

    return { message: "Order status updated successfully", notification };
}
