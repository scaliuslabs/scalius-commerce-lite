import type { Database } from "@scalius/database/client";
import { orderNotificationDeliveryReceipts, orderNotificationOutbox } from "@scalius/database/schema";
import { and, asc, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import type { OrderNotificationType } from "./notification-types";

export type OrderNotificationOutboxStatus =
    | "pending"
    | "enqueueing"
    | "queued"
    | "processing"
    | "sent"
    | "failed"
    | "dead_lettered";

export interface OrderNotificationQueueMessage {
    type: "order.notification";
    outboxId?: string;
    orderId: string;
    customerEmail?: string;
    customerName: string;
    notificationType: OrderNotificationType;
    data?: Record<string, unknown>;
}

export interface OrderNotificationQueue {
    send(message: OrderNotificationQueueMessage): Promise<unknown>;
}

export interface OrderNotificationInput {
    dedupeKey: string;
    orderId: string;
    customerEmail?: string | null;
    customerName: string;
    notificationType: OrderNotificationType;
    data?: Record<string, unknown>;
    source: string;
}

export interface RecordAndEnqueueOrderNotificationResult {
    outboxId: string;
    dedupeKey: string;
    created: boolean;
    enqueued: boolean;
    skippedReason?:
        | "no_queue"
        | "already_queued"
        | "already_sent"
        | "already_retryable"
        | "not_sent"
        | "busy"
        | "missing"
        | "queue_failed";
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
    queuedAt: number | null;
    sentAt: number | null;
    createdAt: number;
    updatedAt: number;
    receipts: OrderNotificationDeliveryReceiptView[];
}

type OutboxRow = typeof orderNotificationOutbox.$inferSelect;
type OutboxInsert = typeof orderNotificationOutbox.$inferInsert;

const ENQUEUE_LEASE_SECONDS = 5 * 60;
const PROCESSING_LEASE_SECONDS = 15 * 60;
export const STALE_QUEUED_REPLAY_SECONDS = 60 * 60;
const MAX_ORDER_NOTIFICATION_OUTBOX_ATTEMPTS = 8;
const MAX_FLUSH_LIMIT = 25;
const MAX_ERROR_LENGTH = 500;
const DEAD_LETTER_NEXT_ATTEMPT_AT = 253_402_300_799;

export function buildOrderCreatedNotificationDedupeKey(orderId: string): string {
    return `order_created:${orderId}`;
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

export function createOrderNotificationOutboxInsertValues(input: OrderNotificationInput): OutboxInsert {
    const now = Math.floor(Date.now() / 1000);
    const dueNow = Math.max(0, now - 1);
    return {
        id: createOutboxId(),
        dedupeKey: input.dedupeKey,
        orderId: input.orderId,
        notificationType: input.notificationType,
        source: input.source,
        payload: serializeOrderNotificationPayload(input),
        status: "pending",
        attempts: 0,
        nextAttemptAt: dueNow,
        createdAt: now,
        updatedAt: now,
    };
}

export async function recordAndEnqueueOrderNotification(options: {
    db: Database;
    queue: OrderNotificationQueue | undefined;
    notification: OrderNotificationInput;
}): Promise<RecordAndEnqueueOrderNotificationResult> {
    const recorded = await recordOrderNotificationOutbox(options.db, options.notification);

    if (!options.queue) {
        return {
            outboxId: recorded.row.id,
            dedupeKey: recorded.row.dedupeKey,
            created: recorded.created,
            enqueued: false,
            skippedReason: "no_queue",
        };
    }

    const enqueueResult = await enqueueOrderNotificationOutboxById({
        db: options.db,
        queue: options.queue,
        outboxId: recorded.row.id,
    });

    return {
        ...enqueueResult,
        dedupeKey: recorded.row.dedupeKey,
        created: recorded.created,
    };
}

export async function enqueueOrderNotificationOutboxById(options: {
    db: Database;
    queue: OrderNotificationQueue;
    outboxId: string;
}): Promise<Omit<RecordAndEnqueueOrderNotificationResult, "dedupeKey" | "created">> {
    const claim = await claimOrderNotificationOutboxForEnqueue(options.db, options.outboxId);
    if (!claim.claimed) {
        return {
            outboxId: options.outboxId,
            enqueued: false,
            skippedReason: claim.reason,
        };
    }

    const message = {
        ...parseOrderNotificationPayload(claim.row.payload),
        outboxId: claim.row.id,
    };

    try {
        await options.queue.send(message);
    } catch (error) {
        await markOrderNotificationOutboxFailed(
            options.db,
            claim.row.id,
            claim.row.claimId,
            error,
            getRetryDelaySeconds(claim.row.attempts),
            claim.row.attempts,
        ).catch((markError: unknown) => {
            console.error("[notifications-outbox] Failed to mark queue send failure:", markError);
        });

        return {
            outboxId: claim.row.id,
            enqueued: false,
            skippedReason: "queue_failed",
        };
    }

    await markOrderNotificationOutboxQueued(options.db, claim.row.id, claim.row.claimId)
        .catch((error: unknown) => {
            // The message is already in Cloudflare Queues. Leave the row claimed;
            // the queue consumer can still process it by outboxId, and the
            // scheduled sweeper will reclaim it if delivery never happens.
            console.error("[notifications-outbox] Failed to mark notification queued:", error);
        });

    return {
        outboxId: claim.row.id,
        enqueued: true,
    };
}

export async function flushPendingOrderNotificationOutbox(options: {
    db: Database;
    queue: OrderNotificationQueue | undefined;
    limit?: number;
}): Promise<{ scanned: number; enqueued: number; failed: number; skipped: number; staleQueued: number }> {
    const limit = Math.max(1, Math.min(options.limit ?? 10, MAX_FLUSH_LIMIT));
    if (!options.queue) {
        return { scanned: 0, enqueued: 0, failed: 0, skipped: 0, staleQueued: 0 };
    }

    const dueRows = await options.db
        .select({
            id: orderNotificationOutbox.id,
            status: orderNotificationOutbox.status,
        })
        .from(orderNotificationOutbox)
        .where(
            or(
                and(
                    inArray(orderNotificationOutbox.status, ["pending", "failed"]),
                    lte(orderNotificationOutbox.nextAttemptAt, sql`unixepoch()`),
                ),
                and(
                    inArray(orderNotificationOutbox.status, ["enqueueing", "processing"]),
                    lte(orderNotificationOutbox.claimExpiresAt, sql`unixepoch()`),
                ),
                and(
                    eq(orderNotificationOutbox.status, "queued"),
                    lte(orderNotificationOutbox.queuedAt, sql`unixepoch() - ${STALE_QUEUED_REPLAY_SECONDS}`),
                ),
            ),
        )
        .orderBy(asc(orderNotificationOutbox.nextAttemptAt), asc(orderNotificationOutbox.createdAt))
        .limit(limit)
        .all();

    let enqueued = 0;
    let failed = 0;
    let skipped = 0;
    const staleQueued = dueRows.filter((row) => row.status === "queued").length;

    for (const row of dueRows) {
        const result = await enqueueOrderNotificationOutboxById({
            db: options.db,
            queue: options.queue,
            outboxId: row.id,
        });
        if (result.enqueued) enqueued += 1;
        else if (result.skippedReason === "queue_failed") failed += 1;
        else skipped += 1;
    }

    return { scanned: dueRows.length, enqueued, failed, skipped, staleQueued };
}

export async function listOrderNotificationOutboxForOrder(
    db: Database,
    orderId: string,
    options: { limit?: number } = {},
): Promise<OrderNotificationOutboxView[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 50));
    const rows = await db
        .select({
            id: orderNotificationOutbox.id,
            dedupeKey: orderNotificationOutbox.dedupeKey,
            orderId: orderNotificationOutbox.orderId,
            notificationType: orderNotificationOutbox.notificationType,
            source: orderNotificationOutbox.source,
            status: orderNotificationOutbox.status,
            attempts: orderNotificationOutbox.attempts,
            nextAttemptAt: orderNotificationOutbox.nextAttemptAt,
            lastError: orderNotificationOutbox.lastError,
            queuedAt: orderNotificationOutbox.queuedAt,
            sentAt: orderNotificationOutbox.sentAt,
            createdAt: orderNotificationOutbox.createdAt,
            updatedAt: orderNotificationOutbox.updatedAt,
        })
        .from(orderNotificationOutbox)
        .where(eq(orderNotificationOutbox.orderId, orderId))
        .orderBy(desc(orderNotificationOutbox.createdAt))
        .limit(limit);

    if (rows.length === 0) return [];

    const receipts = await db
        .select({
            id: orderNotificationDeliveryReceipts.id,
            receiptKey: orderNotificationDeliveryReceipts.receiptKey,
            outboxId: orderNotificationDeliveryReceipts.outboxId,
            channel: orderNotificationDeliveryReceipts.channel,
            provider: orderNotificationDeliveryReceipts.provider,
            recipientMasked: orderNotificationDeliveryReceipts.recipientMasked,
            status: orderNotificationDeliveryReceipts.status,
            providerMessageId: orderNotificationDeliveryReceipts.providerMessageId,
            providerStatus: orderNotificationDeliveryReceipts.providerStatus,
            attempts: orderNotificationDeliveryReceipts.attempts,
            nextAttemptAt: orderNotificationDeliveryReceipts.nextAttemptAt,
            lastAttemptAt: orderNotificationDeliveryReceipts.lastAttemptAt,
            lastError: orderNotificationDeliveryReceipts.lastError,
            acceptedAt: orderNotificationDeliveryReceipts.acceptedAt,
            deliveredAt: orderNotificationDeliveryReceipts.deliveredAt,
            failedAt: orderNotificationDeliveryReceipts.failedAt,
            skippedAt: orderNotificationDeliveryReceipts.skippedAt,
            createdAt: orderNotificationDeliveryReceipts.createdAt,
            updatedAt: orderNotificationDeliveryReceipts.updatedAt,
        })
        .from(orderNotificationDeliveryReceipts)
        .where(inArray(orderNotificationDeliveryReceipts.outboxId, rows.map((row) => row.id)))
        .orderBy(asc(orderNotificationDeliveryReceipts.createdAt));

    const receiptsByOutboxId = new Map<string, OrderNotificationDeliveryReceiptView[]>();
    for (const receipt of receipts) {
        const current = receiptsByOutboxId.get(receipt.outboxId) ?? [];
        current.push({
            id: receipt.id,
            receiptKey: receipt.receiptKey,
            channel: receipt.channel,
            provider: receipt.provider,
            recipientMasked: receipt.recipientMasked,
            status: receipt.status,
            providerMessageId: receipt.providerMessageId,
            providerStatus: receipt.providerStatus,
            attempts: receipt.attempts,
            nextAttemptAt: receipt.nextAttemptAt,
            lastAttemptAt: receipt.lastAttemptAt,
            lastError: receipt.lastError,
            acceptedAt: receipt.acceptedAt,
            deliveredAt: receipt.deliveredAt,
            failedAt: receipt.failedAt,
            skippedAt: receipt.skippedAt,
            createdAt: receipt.createdAt,
            updatedAt: receipt.updatedAt,
        });
        receiptsByOutboxId.set(receipt.outboxId, current);
    }

    return rows.map((row) => ({
        ...row,
        notificationType: row.notificationType as OrderNotificationType,
        status: row.status as OrderNotificationOutboxStatus,
        receipts: receiptsByOutboxId.get(row.id) ?? [],
    }));
}

export async function retryFailedOrderNotificationOutboxById(options: {
    db: Database;
    queue: OrderNotificationQueue | undefined;
    orderId: string;
    outboxId: string;
}): Promise<RecordAndEnqueueOrderNotificationResult> {
    const existing = await selectOutboxById(options.db, options.outboxId);
    if (!existing || existing.orderId !== options.orderId) {
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
    if (!options.queue) {
        await resetRetryableOrderNotificationDeliveryReceipts(options.db, existing.id);
        await options.db
            .update(orderNotificationOutbox)
            .set({
                status: "pending",
                nextAttemptAt: sql`unixepoch()`,
                lastError: null,
                updatedAt: sql`unixepoch()`,
            })
            .where(and(
                eq(orderNotificationOutbox.id, existing.id),
                eq(orderNotificationOutbox.orderId, options.orderId),
                inArray(orderNotificationOutbox.status, ["pending", "failed", "dead_lettered"]),
            ));
        return {
            outboxId: existing.id,
            dedupeKey: existing.dedupeKey,
            created: false,
            enqueued: false,
            skippedReason: "no_queue",
        };
    }

    await resetRetryableOrderNotificationDeliveryReceipts(options.db, existing.id);

    await options.db
        .update(orderNotificationOutbox)
        .set({
            status: "pending",
            nextAttemptAt: sql`unixepoch()`,
            lastError: null,
            claimId: null,
            claimExpiresAt: null,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(orderNotificationOutbox.id, existing.id),
            eq(orderNotificationOutbox.orderId, options.orderId),
            inArray(orderNotificationOutbox.status, ["pending", "failed", "dead_lettered"]),
        ));

    const result = await enqueueOrderNotificationOutboxById({
        db: options.db,
        queue: options.queue,
        outboxId: existing.id,
    });

    return {
        ...result,
        dedupeKey: existing.dedupeKey,
        created: false,
    };
}

export async function resendTerminalOrderNotificationOutboxById(options: {
    db: Database;
    queue: OrderNotificationQueue | undefined;
    orderId: string;
    outboxId: string;
    resendRequestId: string;
}): Promise<RecordAndEnqueueOrderNotificationResult> {
    const existing = await selectOutboxById(options.db, options.outboxId);
    if (!existing || existing.orderId !== options.orderId) {
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

    const payload = parseOrderNotificationPayload(existing.payload);
    return await recordAndEnqueueOrderNotification({
        db: options.db,
        queue: options.queue,
        notification: {
            dedupeKey: buildManualOrderNotificationResendDedupeKey({
                outboxId: existing.id,
                resendRequestId: options.resendRequestId,
            }),
            orderId: existing.orderId,
            customerEmail: payload.customerEmail,
            customerName: payload.customerName,
            notificationType: payload.notificationType,
            data: payload.data,
            source: "manual_resend",
        },
    });
}

export async function markOrderNotificationOutboxDeadLettered(options: {
    db: Database;
    outboxId: string;
    error: unknown;
}): Promise<{ marked: boolean }> {
    const rows = await options.db
        .update(orderNotificationOutbox)
        .set({
            status: "dead_lettered",
            claimId: null,
            claimExpiresAt: null,
            lastError: normalizeError(options.error),
            nextAttemptAt: DEAD_LETTER_NEXT_ATTEMPT_AT,
            updatedAt: sql`unixepoch()`,
        })
        .where(eq(orderNotificationOutbox.id, options.outboxId))
        .returning({ id: orderNotificationOutbox.id });

    return { marked: rows.length > 0 };
}

export async function claimOrderNotificationOutboxForProcessing(
    db: Database,
    outboxId: string,
): Promise<
    | { claimed: true; outboxId: string; claimId: string; attempts: number }
    | { claimed: false; reason: "already_sent" | "busy" | "missing" }
> {
    const claimId = createOutboxClaimId();
    const rows = await db
        .update(orderNotificationOutbox)
        .set({
            status: "processing",
            claimId,
            claimExpiresAt: sql`unixepoch() + ${PROCESSING_LEASE_SECONDS}`,
            attempts: sql`${orderNotificationOutbox.attempts} + 1`,
            lastError: null,
            updatedAt: sql`unixepoch()`,
        })
        .where(
            and(
                eq(orderNotificationOutbox.id, outboxId),
                or(
                    and(
                        inArray(orderNotificationOutbox.status, ["pending", "failed"]),
                        lte(orderNotificationOutbox.nextAttemptAt, sql`unixepoch()`),
                    ),
                    eq(orderNotificationOutbox.status, "queued"),
                    and(
                        inArray(orderNotificationOutbox.status, ["enqueueing", "processing"]),
                        lte(orderNotificationOutbox.claimExpiresAt, sql`unixepoch()`),
                    ),
                ),
            ),
        )
        .returning({
            id: orderNotificationOutbox.id,
            attempts: orderNotificationOutbox.attempts,
        });

    const row = rows[0];
    if (row) {
        return { claimed: true, outboxId: row.id, claimId, attempts: row.attempts };
    }

    const existing = await selectOutboxById(db, outboxId);
    if (!existing) return { claimed: false, reason: "missing" };
    if (existing.status === "sent") return { claimed: false, reason: "already_sent" };
    return { claimed: false, reason: "busy" };
}

export async function markOrderNotificationOutboxSent(
    db: Database,
    outboxId: string,
    claimId: string,
): Promise<void> {
    await db
        .update(orderNotificationOutbox)
        .set({
            status: "sent",
            claimId: null,
            claimExpiresAt: null,
            lastError: null,
            sentAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(orderNotificationOutbox.id, outboxId),
            eq(orderNotificationOutbox.claimId, claimId),
        ));
}

export async function markOrderNotificationOutboxProcessingFailed(
    db: Database,
    outboxId: string,
    claimId: string,
    attempts: number,
    error: unknown,
): Promise<void> {
    await markOrderNotificationOutboxFailed(
        db,
        outboxId,
        claimId,
        error,
        getRetryDelaySeconds(attempts),
        attempts,
    );
}

async function resetRetryableOrderNotificationDeliveryReceipts(
    db: Database,
    outboxId: string,
): Promise<void> {
    await db
        .update(orderNotificationDeliveryReceipts)
        .set({
            nextAttemptAt: sql`unixepoch()`,
            claimId: null,
            claimExpiresAt: null,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(orderNotificationDeliveryReceipts.outboxId, outboxId),
            inArray(orderNotificationDeliveryReceipts.status, ["pending", "failed"]),
        ));
}

function isRetryableOutboxStatus(status: string): boolean {
    return status === "pending" || status === "failed" || status === "dead_lettered";
}

async function recordOrderNotificationOutbox(
    db: Database,
    input: OrderNotificationInput,
): Promise<{ row: OutboxRow; created: boolean }> {
    const values = createOrderNotificationOutboxInsertValues(input);

    try {
        await db.insert(orderNotificationOutbox).values(values);
        return { row: valuesToRow(values), created: true };
    } catch (error) {
        const existing = await selectOutboxByDedupeKey(db, input.dedupeKey);
        if (!existing) throw error;

        if (existing.status === "pending" || existing.status === "failed") {
            await db
                .update(orderNotificationOutbox)
                .set({
                    notificationType: input.notificationType,
                    source: input.source,
                    payload: serializeOrderNotificationPayload(input),
                    status: "pending",
                    nextAttemptAt: sql`unixepoch()`,
                    lastError: null,
                    updatedAt: sql`unixepoch()`,
                })
                .where(and(
                    eq(orderNotificationOutbox.dedupeKey, input.dedupeKey),
                    inArray(orderNotificationOutbox.status, ["pending", "failed"]),
                ));
            const refreshed = await selectOutboxByDedupeKey(db, input.dedupeKey);
            return { row: refreshed ?? existing, created: false };
        }

        return { row: existing, created: false };
    }
}

async function claimOrderNotificationOutboxForEnqueue(
    db: Database,
    outboxId: string,
): Promise<
    | { claimed: true; row: Pick<OutboxRow, "id" | "payload" | "claimId" | "attempts"> & { claimId: string } }
    | { claimed: false; reason: "already_queued" | "already_sent" | "busy" | "missing" }
> {
    const claimId = createOutboxClaimId();
    const rows = await db
        .update(orderNotificationOutbox)
        .set({
            status: "enqueueing",
            claimId,
            claimExpiresAt: sql`unixepoch() + ${ENQUEUE_LEASE_SECONDS}`,
            attempts: sql`${orderNotificationOutbox.attempts} + 1`,
            updatedAt: sql`unixepoch()`,
        })
        .where(
            and(
                eq(orderNotificationOutbox.id, outboxId),
                or(
                    and(
                        inArray(orderNotificationOutbox.status, ["pending", "failed"]),
                        lte(orderNotificationOutbox.nextAttemptAt, sql`unixepoch()`),
                    ),
                    and(
                        inArray(orderNotificationOutbox.status, ["enqueueing", "processing"]),
                        lte(orderNotificationOutbox.claimExpiresAt, sql`unixepoch()`),
                    ),
                    and(
                        eq(orderNotificationOutbox.status, "queued"),
                        lte(orderNotificationOutbox.queuedAt, sql`unixepoch() - ${STALE_QUEUED_REPLAY_SECONDS}`),
                    ),
                ),
            ),
        )
        .returning({
            id: orderNotificationOutbox.id,
            payload: orderNotificationOutbox.payload,
            claimId: orderNotificationOutbox.claimId,
            attempts: orderNotificationOutbox.attempts,
        });

    const row = rows[0];
    if (row?.claimId) {
        return { claimed: true, row: row as Pick<OutboxRow, "id" | "payload" | "claimId" | "attempts"> & { claimId: string } };
    }

    const existing = await selectOutboxById(db, outboxId);
    if (!existing) return { claimed: false, reason: "missing" };
    if (existing.status === "sent") return { claimed: false, reason: "already_sent" };
    if (existing.status === "queued") return { claimed: false, reason: "already_queued" };
    return { claimed: false, reason: "busy" };
}

async function markOrderNotificationOutboxQueued(
    db: Database,
    outboxId: string,
    claimId: string,
): Promise<void> {
    await db
        .update(orderNotificationOutbox)
        .set({
            status: "queued",
            claimId: null,
            claimExpiresAt: null,
            lastError: null,
            queuedAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(orderNotificationOutbox.id, outboxId),
            eq(orderNotificationOutbox.claimId, claimId),
        ));
}

async function markOrderNotificationOutboxFailed(
    db: Database,
    outboxId: string,
    claimId: string,
    error: unknown,
    retryDelaySeconds: number,
    attempts: number,
): Promise<void> {
    const hitAttemptLimit = attempts >= MAX_ORDER_NOTIFICATION_OUTBOX_ATTEMPTS;
    const normalizedError = normalizeError(error);
    await db
        .update(orderNotificationOutbox)
        .set({
            status: hitAttemptLimit ? "dead_lettered" : "failed",
            claimId: null,
            claimExpiresAt: null,
            lastError: hitAttemptLimit ? buildOutboxAttemptLimitReason(normalizedError) : normalizedError,
            nextAttemptAt: hitAttemptLimit ? DEAD_LETTER_NEXT_ATTEMPT_AT : sql`unixepoch() + ${retryDelaySeconds}`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(orderNotificationOutbox.id, outboxId),
            eq(orderNotificationOutbox.claimId, claimId),
        ));
}

async function selectOutboxById(db: Database, outboxId: string): Promise<OutboxRow | undefined> {
    return await db
        .select()
        .from(orderNotificationOutbox)
        .where(eq(orderNotificationOutbox.id, outboxId))
        .get();
}

async function selectOutboxByDedupeKey(db: Database, dedupeKey: string): Promise<OutboxRow | undefined> {
    return await db
        .select()
        .from(orderNotificationOutbox)
        .where(eq(orderNotificationOutbox.dedupeKey, dedupeKey))
        .get();
}

function serializeOrderNotificationPayload(input: OrderNotificationInput): string {
    const payload: OrderNotificationQueueMessage = {
        type: "order.notification",
        orderId: input.orderId,
        customerEmail: input.customerEmail ?? undefined,
        customerName: input.customerName || "Customer",
        notificationType: input.notificationType,
        data: input.data,
    };
    return JSON.stringify(payload);
}

function parseOrderNotificationPayload(payload: string): OrderNotificationQueueMessage {
    const parsed = JSON.parse(payload) as OrderNotificationQueueMessage;
    return {
        type: "order.notification",
        orderId: parsed.orderId,
        customerEmail: parsed.customerEmail,
        customerName: parsed.customerName || "Customer",
        notificationType: parsed.notificationType,
        data: parsed.data,
    };
}

function valuesToRow(values: OutboxInsert): OutboxRow {
    return {
        id: String(values.id),
        dedupeKey: String(values.dedupeKey),
        orderId: String(values.orderId),
        notificationType: String(values.notificationType),
        source: String(values.source),
        payload: String(values.payload),
        status: String(values.status ?? "pending"),
        attempts: Number(values.attempts ?? 0),
        nextAttemptAt: 0,
        claimId: null,
        claimExpiresAt: null,
        lastError: null,
        queuedAt: null,
        sentAt: null,
        createdAt: 0,
        updatedAt: 0,
    };
}

function createOutboxId(): string {
    return `ono_${createRandomId()}`;
}

function createOutboxClaimId(): string {
    return `onoc_${createRandomId()}`;
}

function createRandomId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID().replace(/-/g, "");
    }
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function getRetryDelaySeconds(attempts: number): number {
    const normalizedAttempts = Math.max(1, Math.min(attempts, 8));
    return Math.min(60 * 60, 60 * 2 ** (normalizedAttempts - 1));
}

function normalizeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}...` : message;
}

function buildOutboxAttemptLimitReason(error: string): string {
    const detail = error.trim();
    return detail
        ? `order_notification_attempt_limit_reached: ${detail}`
        : "order_notification_attempt_limit_reached";
}
