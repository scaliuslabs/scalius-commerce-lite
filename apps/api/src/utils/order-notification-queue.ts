import type { Database } from "@scalius/database/client";
import { orders } from "@scalius/database/schema";
import {
    buildOrderCreatedNotificationDedupeKey,
    buildOrderStatusNotificationDedupeKey,
    recordAndEnqueueOrderNotification,
    type OrderNotificationQueue,
    type OrderNotificationQueueMessage,
    type OrderNotificationType,
} from "@scalius/core/modules/notifications";
import { eq, inArray } from "drizzle-orm";

export interface OrderStatusChange {
    orderId: string;
    previousStatus: string;
    newStatus: string;
    version?: number;
}

export interface EnqueueOrderNotificationResult {
    orderId: string;
    outboxId?: string;
    enqueued: boolean;
    skippedReason?:
        | "no_queue"
        | "no_notification_type"
        | "order_missing"
        | "record_failed"
        | "queue_failed"
        | "already_queued"
        | "already_sent"
        | "busy"
        | "missing";
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

export async function enqueueOrderCreatedNotificationForOrder(options: {
    db: Database;
    queue: OrderNotificationQueue | undefined;
    orderId: string;
    source: string;
    retryOnQueueFailure?: boolean;
}): Promise<EnqueueOrderNotificationResult> {
    const orderRows = await selectSingleOrder(options.db, options.orderId);
    const order = orderRows[0];
    if (!order) {
        console.warn(`[${options.source}] Skipped order_created notification for missing order ${options.orderId}`);
        return {
            orderId: options.orderId,
            enqueued: false,
            skippedReason: "order_missing",
        };
    }

    const result = await recordAndEnqueueOrderNotification({
        db: options.db,
        queue: options.queue,
        notification: {
            dedupeKey: buildOrderCreatedNotificationDedupeKey(options.orderId),
            orderId: options.orderId,
            customerEmail: order.customerEmail ?? undefined,
            customerName: order.customerName || "Customer",
            notificationType: "order_created",
            source: options.source,
        },
    });

    if (options.retryOnQueueFailure && result.skippedReason === "queue_failed") {
        throw new Error(`order_created notification queue send failed for ${options.orderId}`);
    }

    return {
        orderId: options.orderId,
        outboxId: result.outboxId,
        enqueued: result.enqueued,
        skippedReason: result.skippedReason,
    };
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
        previousStatusByOrderId: { [options.statusChange.orderId]: options.statusChange.previousStatus },
        versionByOrderId: options.statusChange.version
            ? { [options.statusChange.orderId]: options.statusChange.version }
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
    dedupeKeyByOrderId?: Record<string, string | null | undefined>;
    previousStatusByOrderId?: Record<string, string | null | undefined>;
    versionByOrderId?: Record<string, number | null | undefined>;
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

        results.push(await enqueueOrderNotificationMessage({
            db: options.db,
            queue: options.queue,
            message,
            dedupeKey: options.dedupeKeyByOrderId?.[orderId] || buildOrderStatusNotificationDedupeKey({
                orderId,
                notificationType,
                previousStatus: options.previousStatusByOrderId?.[orderId],
                newStatus: options.newStatus,
                version: options.versionByOrderId?.[orderId],
            }),
            source: options.source,
        }));
    }

    return results;
}

export async function enqueueOrderNotificationMessage(options: {
    db: Database;
    queue: OrderNotificationQueue | undefined;
    message: OrderNotificationQueueMessage;
    dedupeKey: string;
    source: string;
}): Promise<EnqueueOrderNotificationResult> {
    try {
        const result = await recordAndEnqueueOrderNotification({
            db: options.db,
            queue: options.queue,
            notification: {
                dedupeKey: options.dedupeKey,
                orderId: options.message.orderId,
                customerEmail: options.message.customerEmail,
                customerName: options.message.customerName,
                notificationType: options.message.notificationType,
                data: options.message.data,
                source: options.source,
            },
        });

        return {
            orderId: options.message.orderId,
            outboxId: result.outboxId,
            enqueued: result.enqueued,
            skippedReason: result.skippedReason,
        };
    } catch (error: unknown) {
        console.error(
            `[${options.source}] Failed to record ${options.message.notificationType} notification for ${options.message.orderId}:`,
            error,
        );
        return {
            orderId: options.message.orderId,
            enqueued: false,
            skippedReason: "record_failed",
        };
    }
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
