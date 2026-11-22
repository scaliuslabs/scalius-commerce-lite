// A sign-in code's delivery receipt: claimed once per attempt so a code is
// sent at most once per delivery. `pending` and `failed` wait for a send
// (`processing` holds one under a lease); `accepted`, `skipped` and `expired`
// are final, the last written by the sweep once the code expired unsent
// (`sweepAuthOtpDeliveryReceipts`), which also deletes every receipt an hour
// after its code expired. The contact is kept only as the challenge's keyed
// identifier hash (`hashCustomerAuthOtpIdentifier`), which customer erasure
// computes again to delete a buyer's receipts.
import type { Database } from "@scalius/database/client";
import { authOtpDeliveryReceipts, type AuthOtpDeliveryReceiptStatus } from "@scalius/database/schema";
import { and, eq, inArray, lte, or, sql } from "drizzle-orm";
import { sha256HexSync } from "@scalius/shared/hash";
import { hashCustomerAuthOtpIdentifier } from "./customer-auth-otp-challenges";

export type { AuthOtpDeliveryReceiptStatus };
export type AuthOtpDeliveryChannel = "email" | "sms" | "whatsapp";

export interface AuthOtpDeliveryTargetInput {
    /** The credential key: the contact is kept only as its keyed hash. */
    encryptionKey: string | undefined;
    deliveryKey: string;
    purpose?: string;
    method: "email" | "phone";
    channel: AuthOtpDeliveryChannel;
    provider: string;
    identifier: string;
    identifierMasked?: string | null;
    otpExpiresAt?: number | null;
}

export interface AuthOtpDeliveryTarget extends Omit<AuthOtpDeliveryTargetInput, "encryptionKey"> {
    purpose: string;
    identifierHash: string;
    identifierMasked: string;
    otpExpiresAt: number | null;
}

export interface AuthOtpDeliveryReceiptClaim {
    id: string;
    deliveryKey: string;
    claimId: string;
    attempts: number;
}

export interface AuthOtpDeliveryReceiptResult {
    provider?: string;
    providerMessageId?: string | null;
    providerStatus?: string | null;
    rawResponse?: string | null;
}

type AuthOtpDeliveryReceiptRow = typeof authOtpDeliveryReceipts.$inferSelect;
type AuthOtpDeliveryReceiptInsert = typeof authOtpDeliveryReceipts.$inferInsert;

const PROCESSING_LEASE_SECONDS = 5 * 60;
const MAX_ERROR_LENGTH = 500;
const MAX_RAW_RESPONSE_LENGTH = 1000;
const TERMINAL_STATUSES = new Set<AuthOtpDeliveryReceiptStatus>(["accepted", "skipped", "expired"]);
/** A receipt whose code's expiry is not known ends this long after it is made (a code lives five minutes). */
const UNKNOWN_EXPIRY_SECONDS = 10 * 60;
/** How long a receipt is kept after its code expired. */
const RECEIPT_RETENTION_SECONDS = 60 * 60;

export async function createAuthOtpDeliveryTarget(
    input: AuthOtpDeliveryTargetInput,
): Promise<AuthOtpDeliveryTarget> {
    const { encryptionKey, ...target } = input;
    return {
        ...target,
        purpose: input.purpose ?? "customer_login",
        identifierHash: await hashCustomerAuthOtpIdentifier(input.identifier, encryptionKey),
        identifierMasked: input.identifierMasked ?? maskOtpIdentifier(input.identifier),
        otpExpiresAt: input.otpExpiresAt ?? null,
    };
}

export function createAuthOtpDeliveryKey(): string {
    return `otp_${createRandomId()}`;
}

/**
 * The provider's client reference for one send (GenNet's `csms_id`: at most
 * 20 alphanumerics): a digest of the whole delivery, channel and recipient, so
 * the same send keeps one reference and a different recipient or channel never
 * shares it. Cutting the joined ids instead would keep only the delivery key.
 */
export function createAuthOtpProviderClientReference(
    target: Pick<AuthOtpDeliveryTarget, "deliveryKey" | "channel" | "identifierHash">,
): string {
    return sha256HexSync(`${target.deliveryKey}\n${target.channel}\n${target.identifierHash}`).slice(0, 20);
}

export async function claimAuthOtpDeliveryReceipt(
    db: Database,
    target: AuthOtpDeliveryTarget,
): Promise<
    | { claimed: true; receipt: AuthOtpDeliveryReceiptClaim }
    | { claimed: false; reason: "accepted" | "skipped" | "expired" | "busy" | "missing"; retryAfterSeconds?: number }
> {
    await ensureAuthOtpDeliveryReceipt(db, target);
    const nowSeconds = Math.floor(Date.now() / 1000);

    const claimId = createAuthOtpReceiptClaimId();
    const rows = await db
        .update(authOtpDeliveryReceipts)
        .set({
            status: "processing",
            provider: target.provider,
            identifierMasked: target.identifierMasked,
            claimId,
            claimExpiresAt: sql`unixepoch() + ${PROCESSING_LEASE_SECONDS}`,
            attempts: sql`${authOtpDeliveryReceipts.attempts} + 1`,
            lastError: null,
            lastAttemptAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        })
        .where(
            and(
                eq(authOtpDeliveryReceipts.deliveryKey, target.deliveryKey),
                or(
                    and(
                        inArray(authOtpDeliveryReceipts.status, ["pending", "failed"]),
                        or(
                            lte(authOtpDeliveryReceipts.nextAttemptAt, sql`unixepoch()`),
                            and(
                                sql`${authOtpDeliveryReceipts.otpExpiresAt} is not null`,
                                lte(authOtpDeliveryReceipts.otpExpiresAt, sql`unixepoch()`),
                            ),
                        ),
                    ),
                    and(
                        eq(authOtpDeliveryReceipts.status, "processing"),
                        lte(authOtpDeliveryReceipts.claimExpiresAt, sql`unixepoch()`),
                    ),
                ),
            ),
        )
        .returning({
            id: authOtpDeliveryReceipts.id,
            deliveryKey: authOtpDeliveryReceipts.deliveryKey,
            claimId: authOtpDeliveryReceipts.claimId,
            attempts: authOtpDeliveryReceipts.attempts,
        });

    const row = rows[0];
    if (row?.claimId) {
        return {
            claimed: true,
            receipt: {
                id: row.id,
                deliveryKey: row.deliveryKey,
                claimId: row.claimId,
                attempts: row.attempts,
            },
        };
    }

    const existing = await selectAuthOtpDeliveryReceiptByKey(db, target.deliveryKey);
    if (!existing) return { claimed: false, reason: "missing" };
    if (TERMINAL_STATUSES.has(existing.status as AuthOtpDeliveryReceiptStatus)) {
        return { claimed: false, reason: existing.status as "accepted" | "skipped" | "expired" };
    }
    return {
        claimed: false,
        reason: "busy",
        retryAfterSeconds: getBusyRetryAfterSeconds(existing, nowSeconds),
    };
}

export async function markAuthOtpDeliveryReceiptAccepted(
    db: Database,
    receipt: AuthOtpDeliveryReceiptClaim,
    result: AuthOtpDeliveryReceiptResult = {},
): Promise<void> {
    await db
        .update(authOtpDeliveryReceipts)
        .set({
            status: "accepted",
            provider: result.provider ?? undefined,
            providerMessageId: result.providerMessageId ?? null,
            providerStatus: normalizeRawResponse(result.providerStatus ?? "accepted"),
            rawResponse: normalizeRawResponse(result.rawResponse),
            claimId: null,
            claimExpiresAt: null,
            lastError: null,
            acceptedAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(authOtpDeliveryReceipts.id, receipt.id),
            eq(authOtpDeliveryReceipts.claimId, receipt.claimId),
        ));
}

export async function markAuthOtpDeliveryReceiptFailed(
    db: Database,
    receipt: AuthOtpDeliveryReceiptClaim,
    error: unknown,
    result: AuthOtpDeliveryReceiptResult = {},
): Promise<void> {
    await db
        .update(authOtpDeliveryReceipts)
        .set({
            status: "failed",
            provider: result.provider ?? undefined,
            providerMessageId: result.providerMessageId ?? null,
            providerStatus: normalizeRawResponse(result.providerStatus),
            rawResponse: normalizeRawResponse(result.rawResponse),
            claimId: null,
            claimExpiresAt: null,
            lastError: normalizeError(error),
            nextAttemptAt: sql`unixepoch() + ${getAuthOtpDeliveryRetryDelaySeconds(receipt.attempts)}`,
            failedAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(authOtpDeliveryReceipts.id, receipt.id),
            eq(authOtpDeliveryReceipts.claimId, receipt.claimId),
        ));
}

export async function markAuthOtpDeliveryReceiptSkipped(
    db: Database,
    receipt: AuthOtpDeliveryReceiptClaim,
    reason: string,
    result: AuthOtpDeliveryReceiptResult = {},
): Promise<void> {
    await db
        .update(authOtpDeliveryReceipts)
        .set({
            status: "skipped",
            provider: result.provider ?? undefined,
            providerMessageId: result.providerMessageId ?? null,
            providerStatus: normalizeRawResponse(result.providerStatus ?? reason),
            rawResponse: normalizeRawResponse(result.rawResponse),
            claimId: null,
            claimExpiresAt: null,
            lastError: normalizeError(reason),
            skippedAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(authOtpDeliveryReceipts.id, receipt.id),
            eq(authOtpDeliveryReceipts.claimId, receipt.claimId),
        ));
}

async function ensureAuthOtpDeliveryReceipt(
    db: Database,
    target: AuthOtpDeliveryTarget,
): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const dueNow = Math.max(0, now - 1);
    const values: AuthOtpDeliveryReceiptInsert = {
        id: createAuthOtpReceiptId(),
        deliveryKey: target.deliveryKey,
        purpose: target.purpose,
        method: target.method,
        channel: target.channel,
        provider: target.provider,
        identifierHash: target.identifierHash,
        identifierMasked: target.identifierMasked,
        status: "pending",
        attempts: 0,
        nextAttemptAt: dueNow,
        // Every receipt ends: one whose code's expiry is unknown ends soon after it is made.
        otpExpiresAt: target.otpExpiresAt ?? now + UNKNOWN_EXPIRY_SECONDS,
        createdAt: now,
        updatedAt: now,
    };

    try {
        await db.insert(authOtpDeliveryReceipts).values(values);
    } catch (error) {
        const existing = await selectAuthOtpDeliveryReceiptByKey(db, target.deliveryKey);
        if (!existing) throw error;
    }
}

async function selectAuthOtpDeliveryReceiptByKey(
    db: Database,
    deliveryKey: string,
): Promise<AuthOtpDeliveryReceiptRow | undefined> {
    return await db
        .select()
        .from(authOtpDeliveryReceipts)
        .where(eq(authOtpDeliveryReceipts.deliveryKey, deliveryKey))
        .get();
}

/**
 * The expiry sweep: a receipt whose code expired before a send was accepted
 * ends `expired` (a lease still held finishes first), and every receipt goes
 * an hour after its code expired. Both read `auth_otp_delivery_receipts_expires_idx`,
 * at most `limit` rows each, in one database call when there is nothing to do.
 */
export async function sweepAuthOtpDeliveryReceipts(
    db: Database,
    nowSeconds = Math.floor(Date.now() / 1000),
    options: { limit?: number } = {},
): Promise<{ expired: number; deleted: number; hasMore: boolean; limit: number }> {
    const limit = Math.max(1, Math.min(options.limit ?? 200, 500));
    const ending = and(lte(authOtpDeliveryReceipts.otpExpiresAt, nowSeconds), openReceipt(nowSeconds));
    const stale = lte(authOtpDeliveryReceipts.otpExpiresAt, nowSeconds - RECEIPT_RETENTION_SECONDS);
    const [open, old] = await db.batch([
        db.select({ id: authOtpDeliveryReceipts.id }).from(authOtpDeliveryReceipts).where(ending).limit(limit),
        db.select({ id: authOtpDeliveryReceipts.id }).from(authOtpDeliveryReceipts).where(stale).limit(limit),
    ]);
    const expired = open.length === 0 ? [] : await db.update(authOtpDeliveryReceipts).set({
        status: "expired",
        claimId: null,
        claimExpiresAt: null,
        updatedAt: sql`unixepoch()`,
    }).where(and(inArray(authOtpDeliveryReceipts.id, open.map((row) => row.id)), ending)).returning({ id: authOtpDeliveryReceipts.id });
    const deleted = old.length === 0 ? [] : await db.delete(authOtpDeliveryReceipts)
        .where(and(inArray(authOtpDeliveryReceipts.id, old.map((row) => row.id)), stale)).returning({ id: authOtpDeliveryReceipts.id });
    return { expired: expired.length, deleted: deleted.length, hasMore: open.length === limit || old.length === limit, limit };
}

/** Waiting for a send, or held by an attempt whose lease ran out. */
function openReceipt(nowSeconds: number) {
    return or(
        inArray(authOtpDeliveryReceipts.status, ["pending", "failed"]),
        and(eq(authOtpDeliveryReceipts.status, "processing"), lte(authOtpDeliveryReceipts.claimExpiresAt, nowSeconds)),
    );
}

export function maskOtpIdentifier(identifier: string): string {
    const trimmed = identifier.trim();
    if (!trimmed) return "missing";
    if (trimmed.includes("@")) {
        const [local = "", domain = ""] = trimmed.split("@");
        return `${local.slice(0, 1) || "*"}***@${domain}`;
    }
    return trimmed.length > 4 ? `***${trimmed.slice(-4)}` : "****";
}

function createAuthOtpReceiptId(): string {
    return `aor_${createRandomId()}`;
}

function createAuthOtpReceiptClaimId(): string {
    return `aorc_${createRandomId()}`;
}

function createRandomId(): string {
    return crypto.randomUUID().replace(/-/g, "");
}

function normalizeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, MAX_ERROR_LENGTH);
}

function normalizeRawResponse(value: string | null | undefined): string | null {
    if (value == null) return null;
    return String(value).slice(0, MAX_RAW_RESPONSE_LENGTH);
}

/**
 * Backoff after a failed attempt: 2 s, 6 s, 18 s, then a minute. A code lives
 * five minutes and the request that issued it retries inline, so only the
 * first waits matter; a buyer who still has no code asks for a new one.
 */
export function getAuthOtpDeliveryRetryDelaySeconds(attempts: number): number {
    const normalizedAttempts = Math.max(1, Math.min(attempts, 8));
    return Math.min(60, 2 * 3 ** (normalizedAttempts - 1));
}

function getBusyRetryAfterSeconds(
    receipt: AuthOtpDeliveryReceiptRow,
    nowSeconds: number,
): number {
    const retryAt = receipt.status === "processing"
        ? receipt.claimExpiresAt
        : receipt.nextAttemptAt;
    if (!retryAt) return getAuthOtpDeliveryRetryDelaySeconds(receipt.attempts);
    return Math.max(5, Math.min(60 * 60, retryAt - nowSeconds));
}
