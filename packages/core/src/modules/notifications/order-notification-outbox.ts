// Order notifications on the generic outbox: `notification_outbox` rows with
// `subject_type='order'`. The sender reads the order's contact at send time
// (§10), so a row carries only ids and safe facts.

import type { Database } from "@scalius/database/client";
import { notificationDeliveryReceipts, notificationOutbox } from "@scalius/database/schema";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { OrderNotificationType } from "./notification-types";
import {
    createNotificationOutboxInsertValues,
    parseNotificationPayload,
    recordAndSendNotification,
    selectNotificationOutboxById,
    type NotificationInput,
    type NotificationOutboxInsert,
    type NotificationOutboxStatus,
    type NotificationSender,
    type RecordNotificationResult,
} from "./notification-outbox";

export type OrderNotificationOutboxStatus = NotificationOutboxStatus;

export interface OrderNotificationInput {
    dedupeKey: string;
    orderId: string;
    notificationType: OrderNotificationType;
    data?: Record<string, unknown>;
    source: string;
}

export interface OrderNotificationDeliveryReceiptView {
    id: string;
    receiptKey: string;
    channel: string;
    provider: string;
    recipientMasked: string | null;
    status: string;
    providerMessageId: string | null;
    providerStatus: string | null;
    attempts: number;
    nextAttemptAt: number | null;
    lastAttemptAt: number | null;
    lastError: string | null;
    acceptedAt: number | null;
    deliveredAt: number | null;
    failedAt: number | null;
    skippedAt: number | null;
    createdAt: number;
    updatedAt: number;
}

export interface OrderNotificationOutboxView {
    id: string;
    dedupeKey: string;
    orderId: string;
    notificationType: OrderNotificationType;
    source: string;
    status: OrderNotificationOutboxStatus;
    attempts: number;
    nextAttemptAt: number;
    lastError: string | null;
    sentAt: number | null;
    createdAt: number;
    updatedAt: number;
    receipts: OrderNotificationDeliveryReceiptView[];
}

export function buildOrderCreatedNotificationDedupeKey(orderId: string): string {
    return `order_created:${orderId}`;
}

/**
 * The id of the order_created row the checkout commit writes in its batch:
 * fixed by the order, so the commit's caller sends it without reading it back.
 */
export function orderCreatedNotificationOutboxId(orderId: string): string {
    return `ono_created_${orderId}`;
}

export function buildOrderBalancePaidNotificationDedupeKey(orderId: string): string {
    return `payment_balance_paid:${orderId}`;
}

export function buildSupportRequestSubmittedNotificationDedupeKey(requestId: string): string {
    return `support_request:${requestId}:submitted`;
}

export function buildManualOrderNotificationResendDedupeKey(options: {
    outboxId: string;
    resendRequestId: string;
}): string {
    return `manual_resend:${options.outboxId}:${options.resendRequestId}`;
}

export function buildSupportRequestStatusUpdatedNotificationDedupeKey(options: {
    requestId: string;
    status: string;
}): string {
    return `support_request:${options.requestId}:status:${options.status}`;
}

/** `order:<id>:pickup_ready:<version>` (§10). */
export function buildOrderReadyForPickupNotificationDedupeKey(options: {
    orderId: string;
    version: number;
}): string {
    return `order:${options.orderId}:pickup_ready:${options.version}`;
}

export function buildOrderStatusNotificationDedupeKey(options: {
    orderId: string;
    notificationType: OrderNotificationType;
    previousStatus?: string | null;
    newStatus: string;
    version?: number | null;
}): string {
    const transition = `${options.previousStatus ?? "unknown"}->${options.newStatus}`;
    if (typeof options.version === "number" && Number.isFinite(options.version)) {
        return `order_status:${options.orderId}:v${options.version}:${transition}`;
    }
    return `order_status:${options.orderId}:${options.notificationType}:${transition}`;
}

function orderNotificationInput(input: OrderNotificationInput): NotificationInput {
    return {
        subjectType: "order",
        subjectId: input.orderId,
        audience: "customer",
        notificationType: input.notificationType,
        dedupeKey: input.dedupeKey,
        source: input.source,
        data: input.data,
    };
}

/** Insert values for an order notification row (for callers that write it in their own batch). */
export function createOrderNotificationOutboxInsertValues(input: OrderNotificationInput): NotificationOutboxInsert {
    return createNotificationOutboxInsertValues(orderNotificationInput(input));
}

export async function recordAndSendOrderNotification(options: {
    db: Database;
    send: NotificationSender | undefined;
    notification: OrderNotificationInput;
}): Promise<RecordNotificationResult> {
    return await recordAndSendNotification({
        db: options.db,
        send: options.send,
        notification: orderNotificationInput(options.notification),
    });
}

export async function listOrderNotificationOutboxForOrder(
    db: Database,
    orderId: string,
    options: { limit?: number } = {},
): Promise<OrderNotificationOutboxView[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 50));
    const rows = await db
        .select({
            id: notificationOutbox.id,
            dedupeKey: notificationOutbox.dedupeKey,
            orderId: notificationOutbox.orderId,
            notificationType: notificationOutbox.notificationType,
            source: notificationOutbox.source,
            status: notificationOutbox.status,
            attempts: notificationOutbox.attempts,
            nextAttemptAt: notificationOutbox.nextAttemptAt,
            lastError: notificationOutbox.lastError,
            sentAt: notificationOutbox.sentAt,
            createdAt: notificationOutbox.createdAt,
            updatedAt: notificationOutbox.updatedAt,
        })
        .from(notificationOutbox)
        .where(and(
            eq(notificationOutbox.orderId, orderId),
            eq(notificationOutbox.subjectType, "order"),
        ))
        .orderBy(desc(notificationOutbox.createdAt))
        .limit(limit);

    if (rows.length === 0) return [];

    const receipts = await db
        .select({
            id: notificationDeliveryReceipts.id,
            receiptKey: notificationDeliveryReceipts.receiptKey,
            outboxId: notificationDeliveryReceipts.outboxId,
            channel: notificationDeliveryReceipts.channel,
            provider: notificationDeliveryReceipts.provider,
            recipientMasked: notificationDeliveryReceipts.recipientMasked,
            status: notificationDeliveryReceipts.status,
            providerMessageId: notificationDeliveryReceipts.providerMessageId,
            providerStatus: notificationDeliveryReceipts.providerStatus,
            attempts: notificationDeliveryReceipts.attempts,
            nextAttemptAt: notificationDeliveryReceipts.nextAttemptAt,
            lastAttemptAt: notificationDeliveryReceipts.lastAttemptAt,
            lastError: notificationDeliveryReceipts.lastError,
            acceptedAt: notificationDeliveryReceipts.acceptedAt,
            deliveredAt: notificationDeliveryReceipts.deliveredAt,
            failedAt: notificationDeliveryReceipts.failedAt,
            skippedAt: notificationDeliveryReceipts.skippedAt,
            createdAt: notificationDeliveryReceipts.createdAt,
            updatedAt: notificationDeliveryReceipts.updatedAt,
        })
        .from(notificationDeliveryReceipts)
        .where(inArray(notificationDeliveryReceipts.outboxId, rows.map((row) => row.id)))
        .orderBy(asc(notificationDeliveryReceipts.createdAt));

    const receiptsByOutboxId = new Map<string, OrderNotificationDeliveryReceiptView[]>();
    for (const { outboxId, ...receipt } of receipts) {
        const current = receiptsByOutboxId.get(outboxId) ?? [];
        current.push(receipt);
        receiptsByOutboxId.set(outboxId, current);
    }

    return rows.map((row) => ({
        ...row,
        orderId: row.orderId ?? orderId,
        notificationType: row.notificationType as OrderNotificationType,
        status: row.status as OrderNotificationOutboxStatus,
        receipts: receiptsByOutboxId.get(row.id) ?? [],
    }));
}

export async function retryFailedOrderNotificationOutboxById(options: {
    db: Database;
    send: NotificationSender | undefined;
    orderId: string;
    outboxId: string;
}): Promise<RecordNotificationResult> {
    const existing = await selectNotificationOutboxById(options.db, options.outboxId);
    if (!existing || existing.subjectType !== "order" || existing.orderId !== options.orderId) {
        return {
            outboxId: options.outboxId,
            dedupeKey: "",
            created: false,
            enqueued: false,
            skippedReason: "missing",
        };
    }
    if (existing.status === "sent") {
        return {
            outboxId: existing.id,
            dedupeKey: existing.dedupeKey,
            created: false,
            enqueued: false,
            skippedReason: "already_sent",
        };
    }
    if (existing.status !== "failed" && existing.status !== "pending" && existing.status !== "dead_lettered") {
        return {
            outboxId: existing.id,
            dedupeKey: existing.dedupeKey,
            created: false,
            enqueued: false,
            skippedReason: "busy",
        };
    }

    await resetRetryableNotificationDeliveryReceipts(options.db, existing.id);
    await options.db
        .update(notificationOutbox)
        .set({
            status: "pending",
            nextAttemptAt: sql`unixepoch()`,
            lastError: null,
            claimId: null,
            claimExpiresAt: null,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(notificationOutbox.id, existing.id),
            eq(notificationOutbox.orderId, options.orderId),
            inArray(notificationOutbox.status, ["pending", "failed", "dead_lettered"]),
        ));

    const base = { outboxId: existing.id, dedupeKey: existing.dedupeKey, created: false };
    if (!options.send) return { ...base, enqueued: false, skippedReason: "no_sender" };
    await options.send([existing.id]);
    return { ...base, enqueued: true };
}

export async function resendTerminalOrderNotificationOutboxById(options: {
    db: Database;
    send: NotificationSender | undefined;
    orderId: string;
    outboxId: string;
    resendRequestId: string;
}): Promise<RecordNotificationResult> {
    const existing = await selectNotificationOutboxById(options.db, options.outboxId);
    if (!existing || existing.subjectType !== "order" || existing.orderId !== options.orderId) {
        return {
            outboxId: options.outboxId,
            dedupeKey: "",
            created: false,
            enqueued: false,
            skippedReason: "missing",
        };
    }

    if (existing.status !== "sent") {
        return {
            outboxId: existing.id,
            dedupeKey: existing.dedupeKey,
            created: false,
            enqueued: false,
            skippedReason: isRetryableOutboxStatus(existing.status) ? "already_retryable" : "not_sent",
        };
    }

    const payload = parseNotificationPayload(existing.payload, existing.notificationType);
    return await recordAndSendOrderNotification({
        db: options.db,
        send: options.send,
        notification: {
            dedupeKey: buildManualOrderNotificationResendDedupeKey({
                outboxId: existing.id,
                resendRequestId: options.resendRequestId,
            }),
            orderId: options.orderId,
            notificationType: payload.notificationType as OrderNotificationType,
            data: payload.data,
            source: "manual_resend",
        },
    });
}

async function resetRetryableNotificationDeliveryReceipts(
    db: Database,
    outboxId: string,
): Promise<void> {
    await db
        .update(notificationDeliveryReceipts)
        .set({
            nextAttemptAt: sql`unixepoch()`,
            claimId: null,
            claimExpiresAt: null,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(notificationDeliveryReceipts.outboxId, outboxId),
            inArray(notificationDeliveryReceipts.status, ["pending", "failed"]),
        ));
}

function isRetryableOutboxStatus(status: string): boolean {
    return status === "pending" || status === "failed" || status === "dead_lettered";
}
