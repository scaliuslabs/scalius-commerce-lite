// Order notifications from API routes and background work: each records one
// `notification_outbox` row (idempotent by dedupe key) and hands it to the
// sender, which delivers it after the response; the scheduled drain sends
// whatever is still due.
import type { Database } from "@scalius/database/client";
import { orders } from "@scalius/database/schema";
import {
    buildOrderBalancePaidNotificationDedupeKey,
    buildOrderCreatedNotificationDedupeKey,
    buildOrderStatusNotificationDedupeKey,
    buildSupportRequestStatusUpdatedNotificationDedupeKey,
    buildSupportRequestSubmittedNotificationDedupeKey,
    recordAndSendOrderNotification,
    type NotificationSender,
    type RecordNotificationResult,
} from "@scalius/core/modules/notifications";
import { type OrderNotificationType } from "@scalius/core/modules/notifications/browser";
import { eq, inArray } from "drizzle-orm";

export interface OrderStatusChange {
    orderId: string;
    previousStatus: string;
    newStatus: string;
    version?: number;
}

export interface OrderNotificationResult {
    orderId: string;
    outboxId?: string;
    enqueued: boolean;
    skippedReason?: RecordNotificationResult["skippedReason"] | "no_notification_type" | "order_missing" | "record_failed";
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
        case "refunded":
            return "order_refunded";
        default:
            return null;
    }
}

type RefundNotificationType = Extract<
    OrderNotificationType,
    "refund_processing" | "refund_failed" | "order_refunded" | "order_partially_refunded"
>;

type SupportRequestNotificationType = Extract<
    OrderNotificationType,
    "support_request_submitted" | "support_request_status_updated"
>;

async function orderExists(db: Database, orderId: string, source: string, notificationType: string): Promise<boolean> {
    const order = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order) console.warn(`[${source}] Skipped ${notificationType} notification for missing order ${orderId}`);
    return Boolean(order);
}

export async function sendOrderCreatedNotification(options: {
    db: Database;
    send: NotificationSender | undefined;
    orderId: string;
    source: string;
}): Promise<OrderNotificationResult> {
    if (!(await orderExists(options.db, options.orderId, options.source, "order_created"))) {
        return { orderId: options.orderId, enqueued: false, skippedReason: "order_missing" };
    }
    return sendOrderNotification({
        db: options.db,
        send: options.send,
        orderId: options.orderId,
        notificationType: "order_created",
        dedupeKey: buildOrderCreatedNotificationDedupeKey(options.orderId),
        source: options.source,
    });
}

export async function sendOrderBalancePaidNotification(options: {
    db: Database;
    send: NotificationSender | undefined;
    orderId: string;
    source: string;
    amount?: number;
    gateway?: string;
}): Promise<OrderNotificationResult> {
    if (!(await orderExists(options.db, options.orderId, options.source, "payment_balance_paid"))) {
        return { orderId: options.orderId, enqueued: false, skippedReason: "order_missing" };
    }
    const data = {
        ...(typeof options.amount === "number" && Number.isFinite(options.amount) ? { amount: options.amount } : {}),
        ...(options.gateway ? { gateway: options.gateway } : {}),
    };
    return sendOrderNotification({
        db: options.db,
        send: options.send,
        orderId: options.orderId,
        notificationType: "payment_balance_paid",
        data: Object.keys(data).length > 0 ? data : undefined,
        dedupeKey: buildOrderBalancePaidNotificationDedupeKey(options.orderId),
        source: options.source,
    });
}

export async function sendOrderRefundNotification(options: {
    db: Database;
    send: NotificationSender | undefined;
    orderId: string;
    notificationType: RefundNotificationType;
    dedupeKey: string;
    source: string;
    data?: Record<string, unknown>;
}): Promise<OrderNotificationResult> {
    if (!(await orderExists(options.db, options.orderId, options.source, options.notificationType))) {
        return { orderId: options.orderId, enqueued: false, skippedReason: "order_missing" };
    }
    return sendOrderNotification(options);
}

export async function sendOrderSupportRequestNotification(options: {
    db: Database;
    send: NotificationSender | undefined;
    orderId: string;
    requestId: string;
    notificationType: SupportRequestNotificationType;
    source: string;
    status?: string | null;
    data?: Record<string, unknown>;
}): Promise<OrderNotificationResult> {
    if (!(await orderExists(options.db, options.orderId, options.source, options.notificationType))) {
        return { orderId: options.orderId, enqueued: false, skippedReason: "order_missing" };
    }
    const dedupeKey = options.notificationType === "support_request_submitted"
        ? buildSupportRequestSubmittedNotificationDedupeKey(options.requestId)
        : buildSupportRequestStatusUpdatedNotificationDedupeKey({
            requestId: options.requestId,
            status: options.status ?? String(options.data?.supportRequestStatus ?? "updated"),
        });
    return sendOrderNotification({
        db: options.db,
        send: options.send,
        orderId: options.orderId,
        notificationType: options.notificationType,
        data: { supportRequestId: options.requestId, ...(options.data ?? {}) },
        dedupeKey,
        source: options.source,
    });
}

export async function sendOrderStatusChangeNotification(options: {
    db: Database;
    send: NotificationSender | undefined;
    statusChange: OrderStatusChange | null | undefined;
    trackingId?: string | null;
    source: string;
}): Promise<OrderNotificationResult | null> {
    if (!options.statusChange) return null;

    const [result] = await sendOrderNotificationsForStatus({
        db: options.db,
        send: options.send,
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

export async function sendOrderNotificationsForStatus(options: {
    db: Database;
    send: NotificationSender | undefined;
    orderIds: string[];
    newStatus: string;
    trackingByOrderId?: Record<string, string | null | undefined>;
    dedupeKeyByOrderId?: Record<string, string | null | undefined>;
    previousStatusByOrderId?: Record<string, string | null | undefined>;
    versionByOrderId?: Record<string, number | null | undefined>;
    source: string;
}): Promise<OrderNotificationResult[]> {
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

    const found = await options.db
        .select({ id: orders.id })
        .from(orders)
        .where(inArray(orders.id, orderIds))
        .all();
    const existing = new Set(found.map((order) => order.id));
    const results: OrderNotificationResult[] = [];

    for (const orderId of orderIds) {
        if (!existing.has(orderId)) {
            console.warn(`[${options.source}] Skipped ${notificationType} notification for missing order ${orderId}`);
            results.push({ orderId, enqueued: false, skippedReason: "order_missing" });
            continue;
        }
        const trackingId = options.trackingByOrderId?.[orderId];
        results.push(await sendOrderNotification({
            db: options.db,
            send: options.send,
            orderId,
            notificationType,
            data: trackingId ? { trackingId } : undefined,
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

export async function sendOrderNotification(options: {
    db: Database;
    send: NotificationSender | undefined;
    orderId: string;
    notificationType: OrderNotificationType;
    data?: Record<string, unknown>;
    dedupeKey: string;
    source: string;
}): Promise<OrderNotificationResult> {
    try {
        const result = await recordAndSendOrderNotification({
            db: options.db,
            send: options.send,
            notification: {
                dedupeKey: options.dedupeKey,
                orderId: options.orderId,
                notificationType: options.notificationType,
                data: options.data,
                source: options.source,
            },
        });
        return {
            orderId: options.orderId,
            outboxId: result.outboxId,
            enqueued: result.enqueued,
            skippedReason: result.skippedReason,
        };
    } catch (error: unknown) {
        console.error(
            `[${options.source}] Failed to record ${options.notificationType} notification for ${options.orderId}:`,
            error instanceof Error ? error.message : "unknown error",
        );
        return { orderId: options.orderId, enqueued: false, skippedReason: "record_failed" };
    }
}
