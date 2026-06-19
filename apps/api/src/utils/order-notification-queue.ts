import type { Database } from "@scalius/database/client";
import { orders } from "@scalius/database/schema";
import type { OrderNotificationType } from "@scalius/core/modules/notifications";
import { eq, inArray } from "drizzle-orm";

export interface OrderStatusChange {
    orderId: string;
    previousStatus: string;
    newStatus: string;
}

interface OrderNotificationQueueMessage {
    type: "order.notification";
    orderId: string;
    customerEmail?: string;
    customerName: string;
    notificationType: OrderNotificationType;
    data?: Record<string, unknown>;
}

interface OrderNotificationQueue {
    send(message: OrderNotificationQueueMessage): Promise<unknown>;
}

export interface EnqueueOrderNotificationResult {
    orderId: string;
    enqueued: boolean;
    skippedReason?: "no_queue" | "no_notification_type" | "order_missing" | "queue_failed";
}

export function getOrderNotificationTypeForStatus(status: string): OrderNotificationType | null {
    switch (status.toLowerCase()) {
        case "shipped":
            return "order_shipped";
        case "delivered":
            return "order_delivered";
        case "cancelled":
            return "order_cancelled";
        case "returned":
            return "order_returned";
        default:
            return null;
    }
}

export async function enqueueOrderStatusChangeNotification(options: {
    db: Database;
    queue: OrderNotificationQueue | undefined;
    statusChange: OrderStatusChange | null | undefined;
    trackingId?: string | null;
    source: string;
}): Promise<EnqueueOrderNotificationResult | null> {
    if (!options.statusChange) return null;

    const [result] = await enqueueOrderNotificationsForStatus({
        db: options.db,
        queue: options.queue,
        orderIds: [options.statusChange.orderId],
        newStatus: options.statusChange.newStatus,
        trackingByOrderId: options.trackingId
            ? { [options.statusChange.orderId]: options.trackingId }
            : undefined,
        source: options.source,
    });

    return result ?? null;
}

export async function enqueueOrderNotificationsForStatus(options: {
    db: Database;
    queue: OrderNotificationQueue | undefined;
    orderIds: string[];
    newStatus: string;
    trackingByOrderId?: Record<string, string | null | undefined>;
    source: string;
}): Promise<EnqueueOrderNotificationResult[]> {
    const orderIds = Array.from(new Set(options.orderIds.filter(Boolean)));
    const notificationType = getOrderNotificationTypeForStatus(options.newStatus);

    if (orderIds.length === 0) return [];
    if (!notificationType) {
        return orderIds.map((orderId) => ({
            orderId,
            enqueued: false,
            skippedReason: "no_notification_type",
        }));
    }
    if (!options.queue) {
        return orderIds.map((orderId) => ({
            orderId,
            enqueued: false,
            skippedReason: "no_queue",
        }));
    }

    const orderRows = orderIds.length === 1
        ? await selectSingleOrder(options.db, orderIds[0]!)
        : await options.db
            .select({
                id: orders.id,
                customerEmail: orders.customerEmail,
                customerName: orders.customerName,
            })
            .from(orders)
            .where(inArray(orders.id, orderIds))
            .all();

    const ordersById = new Map(orderRows.map((order) => [order.id, order]));
    const results: EnqueueOrderNotificationResult[] = [];

    for (const orderId of orderIds) {
        const order = ordersById.get(orderId);
        if (!order) {
            console.warn(`[${options.source}] Skipped ${notificationType} notification for missing order ${orderId}`);
            results.push({ orderId, enqueued: false, skippedReason: "order_missing" });
            continue;
        }

        const trackingId = options.trackingByOrderId?.[orderId];
        const message: OrderNotificationQueueMessage = {
            type: "order.notification",
            orderId,
            customerEmail: order.customerEmail ?? undefined,
            customerName: order.customerName || "Customer",
            notificationType,
            data: trackingId ? { trackingId } : undefined,
        };

        try {
            await options.queue.send(message);
            results.push({ orderId, enqueued: true });
        } catch (error: unknown) {
            console.error(`[${options.source}] Failed to enqueue ${notificationType} notification for ${orderId}:`, error);
            results.push({ orderId, enqueued: false, skippedReason: "queue_failed" });
        }
    }

    return results;
}

async function selectSingleOrder(db: Database, orderId: string) {
    const order = await db
        .select({
            id: orders.id,
            customerEmail: orders.customerEmail,
            customerName: orders.customerName,
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .get();

    return order ? [order] : [];
}
