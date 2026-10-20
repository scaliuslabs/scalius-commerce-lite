// Generic notification outbox (Wave A §10). One row per notification, keyed by
// subject (an order, a conversation) and audience, written in the same batch
// as the fact it announces or right after it. The API sends a committed row
// right after the write (`NotificationSender`, by id) and its scheduled drain
// sends every due row; recipients and message text are resolved at send time,
// so no contact, message body or code ever sits in an outbox row.
//
//   pending ──claim──▶ processing ──▶ sent
//      ▲                    │
//      └── failed ◀─────────┤ (backoff in next_attempt_at)
//                           └──▶ dead_lettered (8 attempts, or nothing it can send)

import type { Database } from "@scalius/database/client";
import { notificationOutbox } from "@scalius/database/schema";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import type {
    NotificationAudience,
    NotificationSubjectType,
    OutboxNotificationType,
} from "./notification-types";

export type NotificationOutboxStatus =
    | "pending"
    | "processing"
    | "sent"
    | "failed"
    | "dead_lettered";

/**
 * Sends committed outbox rows by id, off the response path (the API's
 * background drain). It never throws into the caller: a row it could not send
 * stays due for the scheduled drain.
 */
export type NotificationSender = (outboxIds: readonly string[]) => Promise<void>;

/** Small, id-shaped facts a sender needs; never contacts, bodies, codes or tokens. */
export type NotificationData = Record<string, string | number | boolean | null>;

export interface NotificationInput {
    subjectType: NotificationSubjectType;
    subjectId: string;
    audience: NotificationAudience;
    notificationType: OutboxNotificationType;
    dedupeKey: string;
    source: string;
    data?: Record<string, unknown>;
    /**
     * Epoch seconds before which the row is not sent (a review request days
     * after delivery). It becomes the row's `next_attempt_at`, so no drain
     * picks the row before it is due.
     */
    notBefore?: number;
}

/** What the outbox row stores as its payload. */
export interface NotificationPayload {
    notificationType: OutboxNotificationType;
    data?: NotificationData;
}

export type NotificationSendSkipReason =
    | "no_sender"
    | "already_sent"
    | "already_retryable"
    | "not_sent"
    | "busy"
    | "missing";

export interface RecordNotificationResult {
    outboxId: string;
    dedupeKey: string;
    created: boolean;
    /** Handed to the sender now; otherwise the scheduled drain sends it when due. */
    enqueued: boolean;
    skippedReason?: NotificationSendSkipReason;
    /** Not sent yet: the row is due at this epoch second and the scheduled drain sends it. */
    scheduledFor?: number;
}

export interface ClaimedNotificationOutbox {
    claimed: true;
    outboxId: string;
    claimId: string;
    attempts: number;
    // Stored subjects may outlive a sender; dispatch dead-letters unsupported ones.
    subjectType: typeof notificationOutbox.$inferSelect.subjectType;
    subjectId: string;
    audience: NotificationAudience;
    notificationType: OutboxNotificationType;
    data: NotificationData;
}

export type NotificationOutboxRow = typeof notificationOutbox.$inferSelect;
export type NotificationOutboxInsert = typeof notificationOutbox.$inferInsert;

const PROCESSING_LEASE_SECONDS = 15 * 60;
const MAX_NOTIFICATION_OUTBOX_ATTEMPTS = 8;
/** Due rows one drain may list. */
export const MAX_FLUSH_LIMIT = 200;
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
    const notificationType = (typeof record.notificationType === "string" ? record.notificationType : fallbackType) as OutboxNotificationType;
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

/** Records the row (idempotent by dedupe key), then hands it to the sender when it is due now. */
export async function recordAndSendNotification(options: {
    db: Database;
    send: NotificationSender | undefined;
    notification: NotificationInput;
}): Promise<RecordNotificationResult> {
    const recorded = await recordNotificationOutbox(options.db, options.notification);
    const base = { outboxId: recorded.row.id, dedupeKey: recorded.row.dedupeKey, created: recorded.created };

    // A scheduled row waits for the drain that finds it due.
    const scheduledFor = scheduledLaterAt(options.notification);
    if (scheduledFor !== null) return { ...base, enqueued: false, scheduledFor };
    if (recorded.row.status === "sent") return { ...base, enqueued: false, skippedReason: "already_sent" };
    if (recorded.row.status !== "pending" && recorded.row.status !== "failed") return { ...base, enqueued: false, skippedReason: "busy" };
    if (!options.send) return { ...base, enqueued: false, skippedReason: "no_sender" };
    await options.send([recorded.row.id]);
    return { ...base, enqueued: true };
}

/** Due rows (pending/failed past their time, expired leases), oldest first: the ids a drain sends next. */
export async function listDueNotificationOutbox(db: Database, limit: number): Promise<string[]> {
    const rows = await db
        .select({ id: notificationOutbox.id })
        .from(notificationOutbox)
        .where(claimableCondition())
        .orderBy(asc(notificationOutbox.nextAttemptAt), asc(notificationOutbox.createdAt))
        .limit(Math.max(1, Math.min(limit, MAX_FLUSH_LIMIT)))
        .all();
    return rows.map((row) => row.id);
}

/** A drain's lease on one row; returns what the sender needs to resolve recipients. */
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
        .where(and(eq(notificationOutbox.id, outboxId), claimableCondition()))
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
            notificationType: row.notificationType as OutboxNotificationType,
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

/** A row a drain may claim: due pending/failed, or an expired lease. */
function claimableCondition() {
    return or(
        and(
            inArray(notificationOutbox.status, ["pending", "failed"]),
            lte(notificationOutbox.nextAttemptAt, sql`unixepoch()`),
        ),
        and(
            eq(notificationOutbox.status, "processing"),
            lte(notificationOutbox.claimExpiresAt, sql`unixepoch()`),
        ),
    );
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
    return crypto.randomUUID().replace(/-/g, "");
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
