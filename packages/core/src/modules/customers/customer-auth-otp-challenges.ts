import { customerAuthOtpChallenges } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { and, eq, gt, inArray, lte, ne, or, sql } from "drizzle-orm";
import { RateLimitError, ServiceUnavailableError, ValidationError } from "@scalius/core/errors";
import { hashOtpIdentifier, maskOtpIdentifier } from "./otp-delivery-receipts";

export type CustomerAuthOtpMethod = "email" | "phone";
export type CustomerAuthOtpChannel = "email" | "sms" | "whatsapp";
export type CustomerAuthOtpIntent = "sign_in" | "sign_up";

export interface PersistCustomerAuthOtpChallengeInput {
    otpKey: string;
    deliveryKey: string;
    method: CustomerAuthOtpMethod;
    channel: CustomerAuthOtpChannel;
    intent: CustomerAuthOtpIntent;
    identifier: string;
    contactEmail?: string;
    phone?: string;
    code: string;
    encryptionKey?: string;
    ttlSeconds: number;
    resendCooldownSeconds: number;
    maxAttempts: number;
}

export interface PersistedCustomerAuthOtpChallenge {
    otpKey: string;
    deliveryKey: string;
    expiresAt: number;
}

export interface ClaimCustomerAuthOtpChallengeInput {
    otpKey: string;
    method: CustomerAuthOtpMethod;
    channel: CustomerAuthOtpChannel;
    identifier: string;
    code: string;
    encryptionKey?: string;
}

export interface ClaimedCustomerAuthOtpChallenge {
    otpKey: string;
    method: CustomerAuthOtpMethod;
    channel: CustomerAuthOtpChannel;
    intent: CustomerAuthOtpIntent;
    identifier: string;
    contactEmail?: string;
    phone?: string;
    expiresAt: number;
    attempts: number;
    maxAttempts: number;
}

export interface CleanupExpiredCustomerAuthOtpChallengesResult {
    scanned: number;
    deleted: number;
    limit: number;
    hasMore: boolean;
}

export async function persistCustomerAuthOtpChallenge(
    db: Database,
    input: PersistCustomerAuthOtpChallengeInput,
): Promise<PersistedCustomerAuthOtpChallenge> {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + input.ttlSeconds;
    const resendAvailableAt = now + input.resendCooldownSeconds;
    const codeHash = await hashOtpCode(input.code, input.otpKey, input.encryptionKey);
    const identifierHash = await hashOtpIdentifier(input.identifier);
    const identifierMasked = maskOtpIdentifier(input.identifier);

    const values = {
        otpKey: input.otpKey,
        deliveryKey: input.deliveryKey,
        method: input.method,
        channel: input.channel,
        intent: input.intent,
        identifier: input.identifier,
        identifierHash,
        identifierMasked,
        contactEmail: input.contactEmail ?? null,
        phone: input.phone ?? null,
        codeHash,
        status: "pending" as const,
        attempts: 0,
        maxAttempts: input.maxAttempts,
        resendAvailableAt,
        expiresAt,
        consumedAt: null,
        createdAt: now,
        updatedAt: now,
    };

    const rows = await db.insert(customerAuthOtpChallenges)
        .values(values)
        .onConflictDoUpdate({
            target: customerAuthOtpChallenges.otpKey,
            set: {
                deliveryKey: values.deliveryKey,
                method: values.method,
                channel: values.channel,
                intent: values.intent,
                identifier: values.identifier,
                identifierHash: values.identifierHash,
                identifierMasked: values.identifierMasked,
                contactEmail: values.contactEmail,
                phone: values.phone,
                codeHash: values.codeHash,
                status: "pending",
                attempts: 0,
                maxAttempts: values.maxAttempts,
                resendAvailableAt: values.resendAvailableAt,
                expiresAt: values.expiresAt,
                consumedAt: null,
                createdAt: values.createdAt,
                updatedAt: values.updatedAt,
            },
            where: or(
                lte(customerAuthOtpChallenges.resendAvailableAt, now),
                lte(customerAuthOtpChallenges.expiresAt, now),
                ne(customerAuthOtpChallenges.status, "pending"),
            ),
        })
        .returning({
            otpKey: customerAuthOtpChallenges.otpKey,
            deliveryKey: customerAuthOtpChallenges.deliveryKey,
            expiresAt: customerAuthOtpChallenges.expiresAt,
        });

    const row = rows[0];
    if (!row) {
        throw new RateLimitError(
            "A verification code was recently sent. Please wait a moment before requesting a new one.",
            input.resendCooldownSeconds,
        );
    }

    return row;
}

export async function claimCustomerAuthOtpChallenge(
    db: Database,
    input: ClaimCustomerAuthOtpChallengeInput,
): Promise<ClaimedCustomerAuthOtpChallenge> {
    const now = Math.floor(Date.now() / 1000);
    const codeHash = await hashOtpCode(input.code, input.otpKey, input.encryptionKey);

    const consumedRows = await db.update(customerAuthOtpChallenges)
        .set({
            status: "consumed",
            attempts: sql`${customerAuthOtpChallenges.attempts} + 1`,
            consumedAt: now,
            updatedAt: now,
        })
        .where(and(
            eq(customerAuthOtpChallenges.otpKey, input.otpKey),
            eq(customerAuthOtpChallenges.method, input.method),
            eq(customerAuthOtpChallenges.channel, input.channel),
            eq(customerAuthOtpChallenges.identifier, input.identifier),
            eq(customerAuthOtpChallenges.status, "pending"),
            gt(customerAuthOtpChallenges.expiresAt, now),
            sql`${customerAuthOtpChallenges.attempts} < ${customerAuthOtpChallenges.maxAttempts}`,
            eq(customerAuthOtpChallenges.codeHash, codeHash),
        ))
        .returning({
            otpKey: customerAuthOtpChallenges.otpKey,
            method: customerAuthOtpChallenges.method,
            channel: customerAuthOtpChallenges.channel,
            intent: customerAuthOtpChallenges.intent,
            identifier: customerAuthOtpChallenges.identifier,
            contactEmail: customerAuthOtpChallenges.contactEmail,
            phone: customerAuthOtpChallenges.phone,
            expiresAt: customerAuthOtpChallenges.expiresAt,
            attempts: customerAuthOtpChallenges.attempts,
            maxAttempts: customerAuthOtpChallenges.maxAttempts,
        });

    const consumed = consumedRows[0];
    if (consumed) return normalizeClaimedChallenge(consumed);

    const wrongRows = await db.update(customerAuthOtpChallenges)
        .set({
            attempts: sql`${customerAuthOtpChallenges.attempts} + 1`,
            status: sql`case when ${customerAuthOtpChallenges.attempts} + 1 >= ${customerAuthOtpChallenges.maxAttempts} then 'locked' else ${customerAuthOtpChallenges.status} end`,
            updatedAt: now,
        })
        .where(and(
            eq(customerAuthOtpChallenges.otpKey, input.otpKey),
            eq(customerAuthOtpChallenges.method, input.method),
            eq(customerAuthOtpChallenges.channel, input.channel),
            eq(customerAuthOtpChallenges.identifier, input.identifier),
            eq(customerAuthOtpChallenges.status, "pending"),
            gt(customerAuthOtpChallenges.expiresAt, now),
            sql`${customerAuthOtpChallenges.attempts} < ${customerAuthOtpChallenges.maxAttempts}`,
            ne(customerAuthOtpChallenges.codeHash, codeHash),
        ))
        .returning({
            attempts: customerAuthOtpChallenges.attempts,
            maxAttempts: customerAuthOtpChallenges.maxAttempts,
            status: customerAuthOtpChallenges.status,
        });

    const wrong = wrongRows[0];
    if (wrong) {
        if (wrong.status === "locked" || wrong.attempts >= wrong.maxAttempts) {
            throw new RateLimitError("Too many failed attempts. Please request a new code.");
        }
        throw new ValidationError("Incorrect code. Please try again.", {
            attemptsLeft: wrong.maxAttempts - wrong.attempts,
        });
    }

    const existing = await db.select()
        .from(customerAuthOtpChallenges)
        .where(eq(customerAuthOtpChallenges.otpKey, input.otpKey))
        .get();

    if (!existing) {
        throw new ValidationError("No verification code found. Please request a new one.");
    }
    if (
        existing.method !== input.method ||
        existing.channel !== input.channel ||
        existing.identifier !== input.identifier
    ) {
        throw new ValidationError("Verification code does not match the requested contact. Please request a new code.");
    }
    if (existing.expiresAt <= now) {
        throw new ValidationError("Verification code has expired. Please request a new one.");
    }
    if (existing.status === "locked" || existing.attempts >= existing.maxAttempts) {
        throw new RateLimitError("Too many failed attempts. Please request a new code.");
    }
    if (existing.status === "consumed") {
        throw new ValidationError("Verification code has already been used. Please request a new code.");
    }

    throw new ValidationError("Verification code could not be verified. Please request a new code.");
}

export async function deleteCustomerAuthOtpChallenge(
    db: Database,
    input: { otpKey: string; deliveryKey: string },
): Promise<void> {
    await db.delete(customerAuthOtpChallenges)
        .where(and(
            eq(customerAuthOtpChallenges.otpKey, input.otpKey),
            eq(customerAuthOtpChallenges.deliveryKey, input.deliveryKey),
            eq(customerAuthOtpChallenges.status, "pending"),
        ));
}

export async function cleanupExpiredCustomerAuthOtpChallenges(
    db: Database,
    nowSeconds = Math.floor(Date.now() / 1000),
    options: { limit?: number } = {},
): Promise<CleanupExpiredCustomerAuthOtpChallengesResult> {
    const limit = Math.max(1, Math.min(options.limit ?? 200, 500));
    const staleTerminalCutoff = nowSeconds - 60 * 60;
    const rows = await db.select({ otpKey: customerAuthOtpChallenges.otpKey })
        .from(customerAuthOtpChallenges)
        .where(or(
            lte(customerAuthOtpChallenges.expiresAt, nowSeconds),
            and(
                ne(customerAuthOtpChallenges.status, "pending"),
                lte(customerAuthOtpChallenges.updatedAt, staleTerminalCutoff),
            ),
        ))
        .limit(limit + 1);

    const deleteIds = rows.slice(0, limit).map((row) => row.otpKey);
    if (deleteIds.length > 0) {
        await db.delete(customerAuthOtpChallenges)
            .where(inArray(customerAuthOtpChallenges.otpKey, deleteIds));
    }

    return {
        scanned: Math.min(rows.length, limit),
        deleted: deleteIds.length,
        limit,
        hasMore: rows.length > limit,
    };
}

async function hashOtpCode(code: string, otpKey: string, encryptionKey: string | undefined): Promise<string> {
    const secret = requireOtpHashKey(encryptionKey);
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`${otpKey}:${code.trim()}`),
    );
    return Array.from(new Uint8Array(signature))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

function requireOtpHashKey(encryptionKey: string | undefined): string {
    const key = encryptionKey?.trim();
    if (!key) {
        throw new ServiceUnavailableError("Customer OTP signing key is not configured.");
    }
    return key;
}

function normalizeClaimedChallenge(
    row: Pick<
        typeof customerAuthOtpChallenges.$inferSelect,
        "otpKey" | "method" | "channel" | "intent" | "identifier" | "contactEmail" | "phone" | "expiresAt" | "attempts" | "maxAttempts"
    >,
): ClaimedCustomerAuthOtpChallenge {
    return {
        otpKey: row.otpKey,
        method: row.method,
        channel: row.channel,
        intent: row.intent,
        identifier: row.identifier,
        contactEmail: row.contactEmail ?? undefined,
        phone: row.phone ?? undefined,
        expiresAt: row.expiresAt,
        attempts: row.attempts,
        maxAttempts: row.maxAttempts,
    };
}
