import { sweepExpiredRows } from "../../utils/sweep-expired-rows";
import { customerAuthOtpChallenges } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { and, eq, gt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { RateLimitError, ServiceUnavailableError, ValidationError } from "@scalius/core/errors";
import { maskOtpIdentifier } from "./otp-delivery-receipts";
import { OTP_RESEND_COOLDOWN_REASON } from "./customer-auth-rate-limit";
import {
    encryptCredential,
    otpHmacSha256Hex,
    type CredentialOwner,
} from "../../utils/credential-encryption";

export type CustomerAuthOtpMethod = "email" | "phone";
export type CustomerAuthOtpChannel = "email" | "sms" | "whatsapp";

/** How long a proven code stays usable while a new buyer adds their name and phone. */
const ACCOUNT_DETAILS_WINDOW_SECONDS = 10 * 60;
/** Rechecking or rate-limit recovery must never make one code live indefinitely. */
const MAX_CHALLENGE_LIFETIME_SECONDS = 30 * 60;

function extendedChallengeExpiry(now: number, seconds: number): SQL<number> {
    const requested = now + Math.min(Math.max(seconds, 0), MAX_CHALLENGE_LIFETIME_SECONDS);
    const absolute = sql`${customerAuthOtpChallenges.createdAt} + ${MAX_CHALLENGE_LIFETIME_SECONDS}`;
    return sql`case when ${absolute} < ${requested} then ${absolute} else ${requested} end`;
}

export const OTP_LOCKED_MESSAGE = "Too many wrong codes. Send a new code to try again.";

export interface PersistCustomerAuthOtpChallengeInput {
    otpKey: string;
    deliveryKey: string;
    method: CustomerAuthOtpMethod;
    channel: CustomerAuthOtpChannel;
    identifier: string;
    deliveryTarget: string;
    code: string;
    encryptionKey?: string;
    contactEncryptionKey?: string;
    ttlSeconds: number;
    resendCooldownSeconds: number;
    maxAttempts: number;
    /**
     * The code is held back (the store's hourly ceiling): only the resend
     * cooldown is written, through the same cooldown gate. An existing
     * challenge keeps its code, attempts and expiry, so a code already
     * delivered still works; a new row holds a code nobody receives.
     */
    holdBack?: boolean;
}

export interface PersistedCustomerAuthOtpChallenge {
    otpKey: string;
    deliveryKey: string;
    expiresAt: number;
    resendAvailableAt: number;
    /** Seconds until a resend, from the same clock reading the row was written with. */
    resendAfterSeconds: number;
}

export interface ClaimCustomerAuthOtpChallengeInput {
    otpKey: string;
    method: CustomerAuthOtpMethod;
    channel: CustomerAuthOtpChannel;
    identifier: string;
    code: string;
    encryptionKey?: string;
    /**
     * False checks the code without using it up (a new buyer still has to add
     * their details); the code then stays valid for the details step.
     */
    consume?: boolean;
}

export interface ClaimedCustomerAuthOtpChallenge {
    otpKey: string;
    method: CustomerAuthOtpMethod;
    channel: CustomerAuthOtpChannel;
    identifier: string;
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
    const expiresAt = now + Math.min(input.ttlSeconds, MAX_CHALLENGE_LIFETIME_SECONDS);
    const resendAvailableAt = now + input.resendCooldownSeconds;
    const codeHash = await hashOtpCode(input.code, input.otpKey, input.encryptionKey);
    const identifierHash = await hashCustomerAuthOtpIdentifier(input.identifier, input.encryptionKey);
    const identifierMasked = maskOtpIdentifier(input.identifier);
    const deliveryTargetEncrypted = await encryptPinnedContact(
        input.deliveryTarget,
        input.contactEncryptionKey,
        "Customer OTP delivery target",
        otpDeliveryOwner("customer_auth_otp_challenges", input.otpKey, "delivery_target_encrypted"),
    );

    const values = {
        otpKey: input.otpKey,
        deliveryKey: input.deliveryKey,
        method: input.method,
        channel: input.channel,
        identifierHash,
        identifierMasked,
        deliveryTargetEncrypted,
        deliveryNameEncrypted: null,
        codeHash,
        previousCodeHash: null,
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
            set: input.holdBack ? { resendAvailableAt: values.resendAvailableAt, updatedAt: values.updatedAt } : {
                deliveryKey: values.deliveryKey,
                method: values.method,
                channel: values.channel,
                identifierHash: values.identifierHash,
                identifierMasked: values.identifierMasked,
                deliveryTargetEncrypted: values.deliveryTargetEncrypted,
                deliveryNameEncrypted: null,
                codeHash: values.codeHash,
                previousCodeHash: sql`${customerAuthOtpChallenges.codeHash}`,
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
            resendAvailableAt: customerAuthOtpChallenges.resendAvailableAt,
        });

    const row = rows[0];
    if (!row) {
        const current = await db.select({ resendAvailableAt: customerAuthOtpChallenges.resendAvailableAt })
            .from(customerAuthOtpChallenges)
            .where(eq(customerAuthOtpChallenges.otpKey, input.otpKey))
            .get();
        throw new RateLimitError(
            "A code was just sent. Please wait before asking for another.",
            Math.max(1, (current?.resendAvailableAt ?? resendAvailableAt) - now),
            OTP_RESEND_COOLDOWN_REASON,
        );
    }

    return { ...row, resendAfterSeconds: Math.max(0, row.resendAvailableAt - now) };
}

export async function claimCustomerAuthOtpChallenge(
    db: Database,
    input: ClaimCustomerAuthOtpChallengeInput,
): Promise<ClaimedCustomerAuthOtpChallenge> {
    const now = Math.floor(Date.now() / 1000);
    const codeHash = await hashOtpCode(input.code, input.otpKey, input.encryptionKey);
    const identifierHash = await hashCustomerAuthOtpIdentifier(input.identifier, input.encryptionKey);

    const consume = input.consume !== false;
    const consumedRows = await db.update(customerAuthOtpChallenges)
        .set(consume
            ? {
                status: "consumed",
                attempts: sql`${customerAuthOtpChallenges.attempts} + 1`,
                consumedAt: now,
                updatedAt: now,
            }
            : { expiresAt: extendedChallengeExpiry(now, ACCOUNT_DETAILS_WINDOW_SECONDS), updatedAt: now })
        .where(and(
            eq(customerAuthOtpChallenges.otpKey, input.otpKey),
            eq(customerAuthOtpChallenges.method, input.method),
            eq(customerAuthOtpChallenges.channel, input.channel),
            eq(customerAuthOtpChallenges.identifierHash, identifierHash),
            eq(customerAuthOtpChallenges.status, "pending"),
            gt(customerAuthOtpChallenges.expiresAt, now),
            gt(sql`${customerAuthOtpChallenges.createdAt} + ${MAX_CHALLENGE_LIFETIME_SECONDS}`, now),
            sql`${customerAuthOtpChallenges.attempts} < ${customerAuthOtpChallenges.maxAttempts}`,
            eq(customerAuthOtpChallenges.codeHash, codeHash),
        ))
        .returning({
            otpKey: customerAuthOtpChallenges.otpKey,
            method: customerAuthOtpChallenges.method,
            channel: customerAuthOtpChallenges.channel,
        });

    const consumed = consumedRows[0];
    if (consumed) return { ...consumed, identifier: input.identifier };

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
            eq(customerAuthOtpChallenges.identifierHash, identifierHash),
            eq(customerAuthOtpChallenges.status, "pending"),
            gt(customerAuthOtpChallenges.expiresAt, now),
            gt(sql`${customerAuthOtpChallenges.createdAt} + ${MAX_CHALLENGE_LIFETIME_SECONDS}`, now),
            sql`${customerAuthOtpChallenges.attempts} < ${customerAuthOtpChallenges.maxAttempts}`,
            ne(customerAuthOtpChallenges.codeHash, codeHash),
        ))
        .returning({
            attempts: customerAuthOtpChallenges.attempts,
            maxAttempts: customerAuthOtpChallenges.maxAttempts,
            status: customerAuthOtpChallenges.status,
            previousCodeHash: customerAuthOtpChallenges.previousCodeHash,
        });

    const wrong = wrongRows[0];
    if (wrong) {
        const attemptsLeft = Math.max(0, wrong.maxAttempts - wrong.attempts);
        if (wrong.status === "locked" || attemptsLeft === 0) {
            throw new ValidationError(OTP_LOCKED_MESSAGE, { attemptsLeft: 0 });
        }
        if (wrong.previousCodeHash === codeHash) {
            throw new ValidationError("That code was replaced by a newer one. Enter the latest code we sent.", { attemptsLeft });
        }
        throw new ValidationError("That code isn't right. Check it and try again.", { attemptsLeft });
    }

    const existing = await db.select()
        .from(customerAuthOtpChallenges)
        .where(eq(customerAuthOtpChallenges.otpKey, input.otpKey))
        .get();

    if (
        !existing ||
        existing.method !== input.method ||
        existing.channel !== input.channel ||
        existing.identifierHash !== identifierHash
    ) {
        throw new ValidationError("There's no active code for this contact. Send a new code.", { attemptsLeft: 0 });
    }
    if (existing.status === "consumed") {
        throw new ValidationError("That code was already used. Send a new code.", { attemptsLeft: 0 });
    }
    if (existing.status === "locked" || existing.attempts >= existing.maxAttempts) {
        throw new ValidationError(OTP_LOCKED_MESSAGE, { attemptsLeft: 0 });
    }
    if (Math.min(existing.expiresAt, existing.createdAt + MAX_CHALLENGE_LIFETIME_SECONDS) <= now) {
        throw new ValidationError("That code has expired. Send a new code.", { attemptsLeft: 0 });
    }

    throw new ValidationError("That code couldn't be checked. Send a new code.", { attemptsLeft: 0 });
}

/** Keeps the latest pending code usable, at most 30 minutes from its issuance. */
export async function extendPendingCustomerAuthOtpChallenge(
    db: Database,
    otpKey: string,
    seconds: number,
): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await db.update(customerAuthOtpChallenges)
        .set({ expiresAt: extendedChallengeExpiry(now, seconds), updatedAt: now })
        .where(and(
            eq(customerAuthOtpChallenges.otpKey, otpKey),
            eq(customerAuthOtpChallenges.status, "pending"),
            gt(customerAuthOtpChallenges.expiresAt, now),
        ));
}

export async function cleanupExpiredCustomerAuthOtpChallenges(
    db: Database,
    nowSeconds = Math.floor(Date.now() / 1000),
    options: { limit?: number } = {},
): Promise<CleanupExpiredCustomerAuthOtpChallengesResult> {
    const limit = Math.max(1, Math.min(options.limit ?? 200, 500));
    const staleTerminalCutoff = nowSeconds - 60 * 60;
    const expired = or(
        lte(customerAuthOtpChallenges.expiresAt, nowSeconds),
        and(
            ne(customerAuthOtpChallenges.status, "pending"),
            lte(customerAuthOtpChallenges.updatedAt, staleTerminalCutoff),
        ),
    );
    return sweepExpiredRows(db, customerAuthOtpChallenges, customerAuthOtpChallenges.otpKey, expired, limit);
}

async function hashOtpCode(code: string, otpKey: string, encryptionKey: string | undefined): Promise<string> {
    return otpHmacSha256Hex(requireOtpHashKey(encryptionKey), `${otpKey}:${code.trim()}`);
}

export async function buildCustomerAuthOtpStorageKey(
    channel: CustomerAuthOtpChannel,
    normalizedIdentifier: string,
    encryptionKey: string | undefined,
): Promise<string> {
    return `cust_otp:${channel}:${await hashCustomerAuthOtpIdentifier(normalizedIdentifier, encryptionKey)}`;
}

export async function hashCustomerAuthOtpIdentifier(identifier: string, encryptionKey: string | undefined): Promise<string> {
    return otpHmacSha256Hex(
        requireOtpHashKey(encryptionKey),
        `customer-auth-otp-identifier:${identifier.trim().toLowerCase()}`,
    );
}

function requireOtpHashKey(encryptionKey: string | undefined): string {
    const key = encryptionKey?.trim();
    if (!key) {
        throw new ServiceUnavailableError("Customer OTP signing key is not configured.");
    }
    return key;
}

/** Where a one-time code's contact is stored: it decrypts only on that challenge row and field. */
export function otpDeliveryOwner(
    table: "customer_auth_otp_challenges" | "order_payment_recovery_challenges",
    challengeKey: string,
    field: "delivery_target_encrypted" | "delivery_name_encrypted",
): CredentialOwner {
    return { table, row: challengeKey, field };
}

async function encryptPinnedContact(
    value: string | undefined,
    encryptionKey: string | undefined,
    label: string,
    owner: CredentialOwner,
): Promise<string | null> {
    const trimmed = value?.trim();
    if (!trimmed) return null;
    const key = requirePinnedContactEncryptionKey(encryptionKey, label);
    return encryptCredential(trimmed, key, owner);
}

function requirePinnedContactEncryptionKey(encryptionKey: string | undefined, label: string): string {
    const key = encryptionKey?.trim();
    if (!key) {
        throw new ServiceUnavailableError(`${label} encryption key is not configured.`);
    }
    return key;
}
