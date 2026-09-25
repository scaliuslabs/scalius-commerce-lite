// Generic notification outbox (Wave A §10). One row per notification, keyed by
// subject (an order, a conversation) and audience, written in the same batch
// as the fact it announces or right after it. The queue message carries only
// the outbox id; recipients and message text are resolved at send time, so no
// contact, message body or code ever sits in a queue payload or an outbox row.

import type { Database } from "@scalius/database/client";
import { notificationOutbox } from "@scalius/database/schema";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import type {
    NotificationAudience,
    NotificationSubjectType,
    NotificationType,
} from "./notification-types";

export type NotificationOutboxStatus =
    | "pending"
    | "enqueueing"
    | "queued"
    | "processing"
    | "sent"
    | "failed"
    | "dead_lettered";

/** The only queue message a notification sends: the outbox id. */
export interface NotificationQueueMessage {
    type: "notification";
    outboxId: string;
}

export interface NotificationQueue {
    send(message: NotificationQueueMessage): Promise<unknown>;
}

/** The scheduled flush sends in batches (Cloudflare `Queue.sendBatch`). */
export interface NotificationBatchQueue extends NotificationQueue {
    sendBatch(messages: Array<{ body: NotificationQueueMessage }>): Promise<unknown>;
}

/** Small, id-shaped facts a sender needs; never contacts, bodies, codes or tokens. */
export type NotificationData = Record<string, string | number | boolean | null>;

export interface NotificationInput {
    subjectType: NotificationSubjectType;
    subjectId: string;
    audience: NotificationAudience;
    notificationType: NotificationType;
    dedupeKey: string;
    source: string;
    data?: Record<string, unknown>;
    /**
     * Epoch seconds before which the row is not sent (a review request days
     * after delivery). It becomes the row's `next_attempt_at`, so neither the
     * enqueue nor the scheduled flush picks the row before it is due.
     */
    notBefore?: number;
}

/** What the outbox row stores as its payload. */
export interface NotificationPayload {
    notificationType: NotificationType;
    data?: NotificationData;
}

export type NotificationEnqueueSkipReason =
    | "no_queue"
    | "already_queued"
    | "already_sent"
    | "already_retryable"
    | "not_sent"
    | "busy"
    | "missing"
    | "queue_failed";

export interface RecordAndEnqueueNotificationResult {
    outboxId: string;
    dedupeKey: string;
    created: boolean;
    enqueued: boolean;
    skippedReason?: NotificationEnqueueSkipReason;
    /** Not enqueued yet: the row is due at this epoch second and the scheduled flush sends it. */
    scheduledFor?: number;
}

export interface ClaimedNotificationOutbox {
    claimed: true;
    outboxId: string;
    claimId: string;
    attempts: number;
    subjectType: NotificationSubjectType;
    subjectId: string;
    audience: NotificationAudience;
    notificationType: NotificationType;
    data: NotificationData;
}

export type NotificationOutboxRow = typeof notificationOutbox.$inferSelect;
export type NotificationOutboxInsert = typeof notificationOutbox.$inferInsert;

const ENQUEUE_LEASE_SECONDS = 5 * 60;
const PROCESSING_LEASE_SECONDS = 15 * 60;
export const STALE_QUEUED_REPLAY_SECONDS = 60 * 60;
const MAX_NOTIFICATION_OUTBOX_ATTEMPTS = 8;
/** Due rows one scheduled flush hands to the queue. */
export const MAX_FLUSH_LIMIT = 200;
/**
 * Rows claimed and sent per `sendBatch` call: within the Queues limit of 100
 * messages per batch and D1's 100 bound parameters for the claim.
 */
export const FLUSH_BATCH_SIZE = 50;
const MAX_ERROR_LENGTH = 500;
const DEAD_LETTER_NEXT_ATTEMPT_AT = 253_402_300_799;

/**
 * Keys that could carry a contact, a message body or a secret. They are
 * dropped from every payload (C6): the sender reads the live row instead.
 */
const FORBIDDEN_DATA_KEY = /(email|phone|name|body|message|text|note|reason|address|code|token|secret|password|identifier|recipient|contact)/i;
const DATA_KEY_SHAPE = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const MAX_DATA_KEYS = 12;
const MAX_DATA_STRING_LENGTH = 200;

/** Keeps only short primitive facts under safe keys. */
export function sanitizeNotificationData(data: Record<string, unknown> | undefined): NotificationData | undefined {
    if (!data || typeof data !== "object") return undefined;
    const result: NotificationData = {};
    let kept = 0;
    for (const [key, value] of Object.entries(data)) {
        if (kept >= MAX_DATA_KEYS) break;
        if (!DATA_KEY_SHAPE.test(key) || FORBIDDEN_DATA_KEY.test(key)) continue;
        if (value === null || typeof value === "boolean") {
            result[key] = value;
        } else if (typeof value === "number") {
            if (!Number.isFinite(value)) continue;
            result[key] = value;
        } else if (typeof value === "string") {
            if (value.length > MAX_DATA_STRING_LENGTH) continue;
            result[key] = value;
        } else {
            continue;
        }
        kept += 1;
    }
    return kept > 0 ? result : undefined;
}

export function serializeNotificationPayload(input: Pick<NotificationInput, "notificationType" | "data">): string {
    const data = sanitizeNotificationData(input.data);
    const payload: NotificationPayload = { notificationType: input.notificationType, ...(data ? { data } : {}) };
    return JSON.stringify(payload);
}

export function parseNotificationPayload(payload: string, fallbackType: string): NotificationPayload {
    let parsed: unknown;
    try {
        parsed = JSON.parse(payload);
    } catch {
        parsed = {};
    }
    const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    const notificationType = (typeof record.notificationType === "string" ? record.notificationType : fallbackType) as NotificationType;
    const data = sanitizeNotificationData(record.data as Record<string, unknown> | undefined);
    return { notificationType, ...(data ? { data } : {}) };
}

/** The row's first due time: now, or the scheduled `notBefore` when later. */
function firstAttemptAt(input: Pick<NotificationInput, "notBefore">, now: number): number {
    const dueNow = Math.max(0, now - 1);
    const notBefore = input.notBefore;
    return typeof notBefore === "number" && Number.isSafeInteger(notBefore) && notBefore > dueNow ? notBefore : dueNow;
}

/** The future epoch second the row is scheduled for, or null when it is due now. */
function scheduledLaterAt(input: Pick<NotificationInput, "notBefore">): number | null {
    const now = Math.floor(Date.now() / 1000);
    const due = firstAttemptAt(input, now);
    return due > now ? due : null;
}

/** Insert values for an outbox row; safe inside a caller's batch. */
export function createNotificationOutboxInsertValues(input: NotificationInput): NotificationOutboxInsert {
    const now = Math.floor(Date.now() / 1000);
    return {
        id: createNotificationOutboxId(),
        dedupeKey: input.dedupeKey,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        orderId: input.subjectType === "order" ? input.subjectId : null,
        conversationId: input.subjectType === "conversation" ? input.subjectId : null,
        audience: input.audience,
        notificationType: input.notificationType,
        source: input.source,
        payload: serializeNotificationPayload(input),
        status: "pending",
        attempts: 0,
        nextAttemptAt: firstAttemptAt(input, now),
        createdAt: now,
        updatedAt: now,
    };
}

/** An outbox insert that keeps an existing row with the same dedupe key. */
export function buildNotificationOutboxInsert(db: Database, input: NotificationInput) {
    const values = createNotificationOutboxInsertValues(input);
    return {
        outboxId: String(values.id),
        statement: db.insert(notificationOutbox).values(values).onConflictDoNothing({ target: notificationOutbox.dedupeKey }),
    };
}

/** Records the row (idempotent by dedupe key), then hands it to the queue. */
export async function recordAndEnqueueNotification(options: {
    db: Database;
    queue: NotificationQueue | undefined;
    notification: NotificationInput;
}): Promise<RecordAndEnqueueNotificationResult> {
    const recorded = await recordNotificationOutbox(options.db, options.notification);

    // A scheduled row waits for the flush that finds it due.
    const scheduledFor = scheduledLaterAt(options.notification);
    if (scheduledFor !== null) {
        return {
            outboxId: recorded.row.id,
            dedupeKey: recorded.row.dedupeKey,
            created: recorded.created,
            enqueued: false,
            scheduledFor,
        };
    }

    if (!options.queue) {
        return {
            outboxId: recorded.row.id,
            dedupeKey: recorded.row.dedupeKey,
            created: recorded.created,
            enqueued: false,
            skippedReason: "no_queue",
        };
    }

    const enqueueResult = await enqueueNotificationOutboxById({
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

export async function enqueueNotificationOutboxById(options: {
    db: Database;
    queue: NotificationQueue;
    outboxId: string;
}): Promise<Omit<RecordAndEnqueueNotificationResult, "dedupeKey" | "created">> {
    const claim = await claimNotificationOutboxForEnqueue(options.db, options.outboxId);
    if (!claim.claimed) {
        return {
            outboxId: options.outboxId,
            enqueued: false,
            skippedReason: claim.reason,
        };
    }

    const message: NotificationQueueMessage = { type: "notification", outboxId: claim.row.id };

    try {
        await options.queue.send(message);
    } catch (error) {
        await markNotificationOutboxFailed(
            options.db,
            claim.row.id,
            claim.row.claimId,
            error,
            getRetryDelaySeconds(claim.row.attempts),
            claim.row.attempts,
        ).catch((markError: unknown) => {
            console.error("[notifications-outbox] Failed to mark queue send failure:", normalizeError(markError));
        });

        return {
            outboxId: claim.row.id,
            enqueued: false,
            skippedReason: "queue_failed",
        };
    }

    await markNotificationOutboxQueued(options.db, claim.row.id, claim.row.claimId)
        .catch((error: unknown) => {
            // The message is already in Cloudflare Queues. Leave the row claimed;
            // the consumer can still process it by outboxId, and the scheduled
            // sweeper reclaims it if delivery never happens.
            console.error("[notifications-outbox] Failed to mark notification queued:", normalizeError(error));
        });

    return {
        outboxId: claim.row.id,
        enqueued: true,
    };
}

/**
 * Scheduled durable retry: due pending/failed rows (scheduled rows once their
 * time comes), expired leases and stale queued rows. Up to 200 per run, in
 * chunks of 50: each chunk is claimed in one statement (the same guard as a
 * single enqueue, so a row another worker holds is skipped), handed to the
 * queue in one `sendBatch` of `{ type: "notification", outboxId }` messages,
 * then marked queued. A failed batch marks its rows failed with backoff.
 */
export async function flushPendingNotificationOutbox(options: {
    db: Database;
    queue: NotificationBatchQueue | undefined;
    limit?: number;
}): Promise<{ scanned: number; enqueued: number; failed: number; skipped: number; staleQueued: number }> {
    const limit = Math.max(1, Math.min(options.limit ?? 10, MAX_FLUSH_LIMIT));
    if (!options.queue) {
        return { scanned: 0, enqueued: 0, failed: 0, skipped: 0, staleQueued: 0 };
    }

    const dueRows = await options.db
        .select({
            id: notificationOutbox.id,
            status: notificationOutbox.status,
        })
        .from(notificationOutbox)
        .where(enqueueClaimableCondition())
        .orderBy(asc(notificationOutbox.nextAttemptAt), asc(notificationOutbox.createdAt))
        .limit(limit)
        .all();

    let enqueued = 0;
    let failed = 0;
    let skipped = 0;
    const staleQueued = dueRows.filter((row) => row.status === "queued").length;

    for (let start = 0; start < dueRows.length; start += FLUSH_BATCH_SIZE) {
        const ids = dueRows.slice(start, start + FLUSH_BATCH_SIZE).map((row) => row.id);
        const claimId = createNotificationOutboxClaimId();
        const claimed = await options.db
            .update(notificationOutbox)
            .set({
                status: "enqueueing",
                claimId,
                claimExpiresAt: sql`unixepoch() + ${ENQUEUE_LEASE_SECONDS}`,
                attempts: sql`${notificationOutbox.attempts} + 1`,
                updatedAt: sql`unixepoch()`,
            })
            .where(and(inArray(notificationOutbox.id, ids), enqueueClaimableCondition()))
            .returning({ id: notificationOutbox.id, attempts: notificationOutbox.attempts });
        skipped += ids.length - claimed.length;
        if (claimed.length === 0) continue;

        try {
            await options.queue.sendBatch(claimed.map((row) => ({
                body: { type: "notification" as const, outboxId: row.id },
            })));
        } catch (error) {
            failed += claimed.length;
            for (const row of claimed) {
                await markNotificationOutboxFailed(
                    options.db,
                    row.id,
                    claimId,
                    error,
                    getRetryDelaySeconds(row.attempts),
                    row.attempts,
                ).catch((markError: unknown) => {
                    console.error("[notifications-outbox] Failed to mark queue send failure:", normalizeError(markError));
                });
            }
            continue;
        }

        enqueued += claimed.length;
        try {
            await options.db
                .update(notificationOutbox)
                .set({
                    status: "queued",
                    claimId: null,
                    claimExpiresAt: null,
                    lastError: null,
                    queuedAt: sql`unixepoch()`,
                    updatedAt: sql`unixepoch()`,
                })
                .where(and(
                    inArray(notificationOutbox.id, claimed.map((row) => row.id)),
                    eq(notificationOutbox.claimId, claimId),
                ));
        } catch (error) {
            // The messages are already in Cloudflare Queues: leave the rows
            // claimed; the consumer processes them by id, and a later flush
            // reclaims an expired lease if delivery never happens.
            console.error("[notifications-outbox] Failed to mark notifications queued:", normalizeError(error));
        }
    }

    return { scanned: dueRows.length, enqueued, failed, skipped, staleQueued };
}

/** The consumer's lease on one row; returns what the sender needs to resolve recipients. */
export async function claimNotificationOutboxForProcessing(
    db: Database,
    outboxId: string,
): Promise<ClaimedNotificationOutbox | { claimed: false; reason: "already_sent" | "busy" | "missing" }> {
    const claimId = createNotificationOutboxClaimId();
    const rows = await db
        .update(notificationOutbox)
        .set({
            status: "processing",
            claimId,
            claimExpiresAt: sql`unixepoch() + ${PROCESSING_LEASE_SECONDS}`,
            attempts: sql`${notificationOutbox.attempts} + 1`,
            lastError: null,
            updatedAt: sql`unixepoch()`,
        })
        .where(
            and(
                eq(notificationOutbox.id, outboxId),
                or(
                    and(
                        inArray(notificationOutbox.status, ["pending", "failed"]),
                        lte(notificationOutbox.nextAttemptAt, sql`unixepoch()`),
                    ),
                    eq(notificationOutbox.status, "queued"),
                    and(
                        inArray(notificationOutbox.status, ["enqueueing", "processing"]),
                        lte(notificationOutbox.claimExpiresAt, sql`unixepoch()`),
                    ),
                ),
            ),
        )
        .returning({
            id: notificationOutbox.id,
            attempts: notificationOutbox.attempts,
            subjectType: notificationOutbox.subjectType,
            subjectId: notificationOutbox.subjectId,
            audience: notificationOutbox.audience,
            notificationType: notificationOutbox.notificationType,
            payload: notificationOutbox.payload,
        });

    const row = rows[0];
    if (row) {
        const payload = parseNotificationPayload(row.payload, row.notificationType);
        return {
            claimed: true,
            outboxId: row.id,
            claimId,
            attempts: row.attempts,
            subjectType: row.subjectType,
            subjectId: row.subjectId,
            audience: row.audience,
            notificationType: row.notificationType as NotificationType,
            data: payload.data ?? {},
        };
    }

    const existing = await selectNotificationOutboxById(db, outboxId);
    if (!existing) return { claimed: false, reason: "missing" };
    if (existing.status === "sent") return { claimed: false, reason: "already_sent" };
    return { claimed: false, reason: "busy" };
}

export async function markNotificationOutboxSent(
    db: Database,
    outboxId: string,
    claimId: string,
): Promise<void> {
    await db
        .update(notificationOutbox)
        .set({
            status: "sent",
            claimId: null,
            claimExpiresAt: null,
            lastError: null,
            sentAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(notificationOutbox.id, outboxId),
            eq(notificationOutbox.claimId, claimId),
        ));
}

export async function markNotificationOutboxProcessingFailed(
    db: Database,
    outboxId: string,
    claimId: string,
    attempts: number,
    error: unknown,
): Promise<void> {
    await markNotificationOutboxFailed(
        db,
        outboxId,
        claimId,
        error,
        getRetryDelaySeconds(attempts),
        attempts,
    );
}

export async function markNotificationOutboxDeadLettered(options: {
    db: Database;
    outboxId: string;
    error: unknown;
}): Promise<{ marked: boolean }> {
    const rows = await options.db
        .update(notificationOutbox)
        .set({
            status: "dead_lettered",
            claimId: null,
            claimExpiresAt: null,
            lastError: normalizeError(options.error),
            nextAttemptAt: DEAD_LETTER_NEXT_ATTEMPT_AT,
            updatedAt: sql`unixepoch()`,
        })
        .where(eq(notificationOutbox.id, options.outboxId))
        .returning({ id: notificationOutbox.id });

    return { marked: rows.length > 0 };
}

export async function selectNotificationOutboxById(
    db: Database,
    outboxId: string,
): Promise<NotificationOutboxRow | undefined> {
    return await db
        .select()
        .from(notificationOutbox)
        .where(eq(notificationOutbox.id, outboxId))
        .get();
}

async function selectNotificationOutboxByDedupeKey(
    db: Database,
    dedupeKey: string,
): Promise<NotificationOutboxRow | undefined> {
    return await db
        .select()
        .from(notificationOutbox)
        .where(eq(notificationOutbox.dedupeKey, dedupeKey))
        .get();
}

export async function recordNotificationOutbox(
    db: Database,
    input: NotificationInput,
): Promise<{ row: NotificationOutboxRow; created: boolean }> {
    const values = createNotificationOutboxInsertValues(input);

    try {
        await db.insert(notificationOutbox).values(values);
        return { row: valuesToRow(values), created: true };
    } catch (error) {
        const existing = await selectNotificationOutboxByDedupeKey(db, input.dedupeKey);
        if (!existing) throw error;

        if (existing.status === "pending" || existing.status === "failed") {
            await db
                .update(notificationOutbox)
                .set({
                    notificationType: input.notificationType,
                    source: input.source,
                    payload: serializeNotificationPayload(input),
                    status: "pending",
                    nextAttemptAt: scheduledLaterAt(input) ?? sql`unixepoch()`,
                    lastError: null,
                    updatedAt: sql`unixepoch()`,
                })
                .where(and(
                    eq(notificationOutbox.dedupeKey, input.dedupeKey),
                    inArray(notificationOutbox.status, ["pending", "failed"]),
                ));
            const refreshed = await selectNotificationOutboxByDedupeKey(db, input.dedupeKey);
            return { row: refreshed ?? existing, created: false };
        }

        return { row: existing, created: false };
    }
}

/**
 * A row the enqueue may claim: due pending/failed, an expired lease, or a
 * queued row whose message never arrived. One guard for the single enqueue
 * and the batched flush.
 */
function enqueueClaimableCondition() {
    return or(
        and(
            inArray(notificationOutbox.status, ["pending", "failed"]),
            lte(notificationOutbox.nextAttemptAt, sql`unixepoch()`),
        ),
        and(
            inArray(notificationOutbox.status, ["enqueueing", "processing"]),
            lte(notificationOutbox.claimExpiresAt, sql`unixepoch()`),
        ),
        and(
            eq(notificationOutbox.status, "queued"),
            lte(notificationOutbox.queuedAt, sql`unixepoch() - ${STALE_QUEUED_REPLAY_SECONDS}`),
        ),
    );
}

async function claimNotificationOutboxForEnqueue(
    db: Database,
    outboxId: string,
): Promise<
    | { claimed: true; row: { id: string; claimId: string; attempts: number } }
    | { claimed: false; reason: "already_queued" | "already_sent" | "busy" | "missing" }
> {
    const claimId = createNotificationOutboxClaimId();
    const rows = await db
        .update(notificationOutbox)
        .set({
            status: "enqueueing",
            claimId,
            claimExpiresAt: sql`unixepoch() + ${ENQUEUE_LEASE_SECONDS}`,
            attempts: sql`${notificationOutbox.attempts} + 1`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(eq(notificationOutbox.id, outboxId), enqueueClaimableCondition()))
        .returning({
            id: notificationOutbox.id,
            claimId: notificationOutbox.claimId,
            attempts: notificationOutbox.attempts,
        });

    const row = rows[0];
    if (row?.claimId) {
        return { claimed: true, row: { id: row.id, claimId: row.claimId, attempts: row.attempts } };
    }

    const existing = await selectNotificationOutboxById(db, outboxId);
    if (!existing) return { claimed: false, reason: "missing" };
    if (existing.status === "sent") return { claimed: false, reason: "already_sent" };
    if (existing.status === "queued") return { claimed: false, reason: "already_queued" };
    return { claimed: false, reason: "busy" };
}

async function markNotificationOutboxQueued(
    db: Database,
    outboxId: string,
    claimId: string,
): Promise<void> {
    await db
        .update(notificationOutbox)
        .set({
            status: "queued",
            claimId: null,
            claimExpiresAt: null,
            lastError: null,
            queuedAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(notificationOutbox.id, outboxId),
            eq(notificationOutbox.claimId, claimId),
        ));
}

export async function markNotificationOutboxFailed(
    db: Database,
    outboxId: string,
    claimId: string,
    error: unknown,
    retryDelaySeconds: number,
    attempts: number,
): Promise<void> {
    const hitAttemptLimit = attempts >= MAX_NOTIFICATION_OUTBOX_ATTEMPTS;
    const normalizedError = normalizeError(error);
    await db
        .update(notificationOutbox)
        .set({
            status: hitAttemptLimit ? "dead_lettered" : "failed",
            claimId: null,
            claimExpiresAt: null,
            lastError: hitAttemptLimit ? buildOutboxAttemptLimitReason(normalizedError) : normalizedError,
            nextAttemptAt: hitAttemptLimit ? DEAD_LETTER_NEXT_ATTEMPT_AT : sql`unixepoch() + ${retryDelaySeconds}`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(notificationOutbox.id, outboxId),
            eq(notificationOutbox.claimId, claimId),
        ));
}

function valuesToRow(values: NotificationOutboxInsert): NotificationOutboxRow {
    return {
        id: String(values.id),
        dedupeKey: String(values.dedupeKey),
        subjectType: values.subjectType,
        subjectId: String(values.subjectId),
        orderId: values.orderId ?? null,
        conversationId: values.conversationId ?? null,
        audience: values.audience,
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

export function createNotificationOutboxId(): string {
    return `ono_${createRandomId()}`;
}

function createNotificationOutboxClaimId(): string {
    return `onoc_${createRandomId()}`;
}

function createRandomId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID().replace(/-/g, "");
    }
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

export function getRetryDelaySeconds(attempts: number): number {
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
        ? `notification_attempt_limit_reached: ${detail}`
        : "notification_attempt_limit_reached";
}
