import type { Database } from "@scalius/database/client";
import { authOtpDeliveryReceipts } from "@scalius/database/schema";
import { and, eq, inArray, lte, or, sql } from "drizzle-orm";

export type AuthOtpDeliveryChannel = "email" | "sms" | "whatsapp";

export type AuthOtpDeliveryReceiptStatus =
    | "pending"
    | "processing"
    | "accepted"
    | "delivered"
    | "failed"
    | "skipped";

export interface AuthOtpDeliveryTargetInput {
    deliveryKey: string;
    purpose?: string;
    method: "email" | "phone";
    channel: AuthOtpDeliveryChannel;
    provider: string;
    identifier: string;
    identifierMasked?: string | null;
    otpExpiresAt?: number | null;
}

export interface AuthOtpDeliveryTarget extends AuthOtpDeliveryTargetInput {
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
const TERMINAL_STATUSES = new Set<AuthOtpDeliveryReceiptStatus>(["accepted", "delivered", "skipped"]);

export async function createAuthOtpDeliveryTarget(
    input: AuthOtpDeliveryTargetInput,
): Promise<AuthOtpDeliveryTarget> {
    return {
        ...input,
        purpose: input.purpose ?? "customer_login",
        identifierHash: await hashOtpIdentifier(input.identifier),
        identifierMasked: input.identifierMasked ?? maskOtpIdentifier(input.identifier),
        otpExpiresAt: input.otpExpiresAt ?? null,
    };
}

export function createAuthOtpDeliveryKey(): string {
    return `otp_${createRandomId()}`;
}

export function createAuthOtpProviderClientReference(
    target: Pick<AuthOtpDeliveryTarget, "deliveryKey" | "channel" | "identifierHash">,
): string {
    return `${target.deliveryKey}${target.channel}${target.identifierHash}`
        .replace(/[^a-zA-Z0-9]/g, "")
        .slice(0, 20);
}

export async function claimAuthOtpDeliveryReceipt(
    db: Database,
    target: AuthOtpDeliveryTarget,
): Promise<
    | { claimed: true; receipt: AuthOtpDeliveryReceiptClaim }
    | { claimed: false; reason: "accepted" | "delivered" | "skipped" | "busy" | "missing" }
> {
    await ensureAuthOtpDeliveryReceipt(db, target);

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
        return { claimed: false, reason: existing.status as "accepted" | "delivered" | "skipped" };
    }
    return { claimed: false, reason: "busy" };
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
            nextAttemptAt: sql`unixepoch() + ${getRetryDelaySeconds(receipt.attempts)}`,
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
        otpExpiresAt: target.otpExpiresAt,
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

export async function hashOtpIdentifier(identifier: string): Promise<string> {
    const normalized = identifier.trim().toLowerCase();
    if (typeof crypto !== "undefined" && crypto.subtle) {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
        return Array.from(new Uint8Array(digest))
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
    }
    return fallbackHash(normalized).padEnd(64, "0").slice(0, 64);
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
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID().replace(/-/g, "");
    }
    return `${Date.now().toString(36)}${fallbackHash(String(Date.now())).slice(0, 12)}`;
}

function fallbackHash(value: string): string {
    let hash = 5381;
    for (let index = 0; index < value.length; index += 1) {
        hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, MAX_ERROR_LENGTH);
}

function normalizeRawResponse(value: string | null | undefined): string | null {
    if (value == null) return null;
    return String(value).slice(0, MAX_RAW_RESPONSE_LENGTH);
}

function getRetryDelaySeconds(attempts: number): number {
    const normalizedAttempts = Math.max(1, Math.min(attempts, 8));
    return Math.min(60 * 60, 30 * 2 ** (normalizedAttempts - 1));
}
