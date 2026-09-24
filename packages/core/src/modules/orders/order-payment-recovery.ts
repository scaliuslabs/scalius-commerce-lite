import { and, desc, eq, gt, inArray, like, lte, ne, or, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import {
    orderPaymentRecoveryChallenges,
    orders,
} from "@scalius/database/schema";
import { AppError, RateLimitError, ServiceUnavailableError, ValidationError } from "@scalius/core/errors";
import type { CustomerAuthOtpChannel } from "@scalius/shared/customer-auth-policy";
import { isReady } from "@scalius/shared/readiness";
import { getEmailProviderReadiness, type EmailRuntimeContext } from "../../integrations/email";
import { getSmsProviderReadiness } from "../../integrations/sms";
import { getWhatsAppCloudApiSettings } from "../../integrations/whatsapp";
import { createAuthOtpDeliveryKey, maskOtpIdentifier } from "../customers/otp-delivery-receipts";
import type { OtpQueuePayload } from "../customers/otp-transport";
import { enforceOtpSendRateLimits } from "../customers/customer-auth-rate-limit";
import { OTP_LOCKED_MESSAGE } from "../customers/customer-auth-otp-challenges";
import { maskContact } from "../customers/customer-identity";
import { deriveCustomerAuthOtpDeliveryCode } from "../customers/customer-auth.service";
import {
    createOrderPaymentRecoveryLink,
    previewOrderPaymentRecoveryLink,
} from "./orders.admin";
import {
    encodeEncryptedCredential,
    encryptCredentials,
} from "../../utils/credential-encryption";

const ORDER_PAYMENT_RECOVERY_PURPOSE = "order_payment_recovery";
const OTP_TTL_SECONDS = 5 * 60;
const OTP_RESEND_COOLDOWN_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 5;
const GENERIC_RECOVERY_MESSAGE = "If this order still needs an online payment, we've sent a code to the phone number or email saved on it.";

type RecoveryMethod = "email" | "phone";

export interface SendOrderPaymentRecoveryOtpInput {
    orderId: string;
    channel?: CustomerAuthOtpChannel;
    ip: string;
    emailEnv?: EmailRuntimeContext["env"];
    encryptionKey?: string;
    credentialEncryptionKey?: string;
}

export interface SendOrderPaymentRecoveryOtpResult {
    queued: boolean;
    message: string;
    channel?: CustomerAuthOtpChannel;
    method?: RecoveryMethod;
    /** Masked contact the code went to ("01•••••678"). */
    destination?: string;
    /** Short number shown to the buyer ("#1001"), once a code was sent. */
    orderNumber?: number | null;
    resendAfterSeconds?: number;
    queuePayload?: OtpQueuePayload;
    challengeKey?: string;
    deliveryKey?: string;
}

export interface VerifyOrderPaymentRecoveryOtpInput {
    orderId: string;
    code: string;
    encryptionKey?: string;
}

export interface VerifyOrderPaymentRecoveryOtpResult {
    orderId: string;
    receiptToken: string;
    expiresAt: number;
    gateway: string;
    paymentType: "full" | "deposit" | "balance" | null;
    depositAmount: number | null;
    redirectParams: {
        payment: string;
        result: "failed";
        paymentType?: string;
        depositAmount?: number;
    };
}

export interface CleanupExpiredOrderPaymentRecoveryChallengesResult {
    scanned: number;
    deleted: number;
    limit: number;
    hasMore: boolean;
}

type RecoveryOrderContact = {
    id: string;
    orderNumber: number | null;
    customerName: string | null;
    customerPhone: string;
    customerEmail: string | null;
};

export async function sendOrderPaymentRecoveryOtp(
    db: Database,
    input: SendOrderPaymentRecoveryOtpInput,
): Promise<SendOrderPaymentRecoveryOtpResult> {
    const orderId = input.orderId.trim();
    if (!orderId) {
        return { queued: false, message: GENERIC_RECOVERY_MESSAGE };
    }

    const order = await getRecoveryOrderContact(db, orderId);
    if (!order) {
        return { queued: false, message: GENERIC_RECOVERY_MESSAGE };
    }

    try {
        await previewOrderPaymentRecoveryLink(db, orderId);
    } catch {
        return { queued: false, message: GENERIC_RECOVERY_MESSAGE };
    }

    const { channel, method, target, destination } = await chooseOrderCodeChannel(db, order, input);
    const deliveryEncryptionKey = requireRecoveryDeliveryEncryptionKey(input.credentialEncryptionKey);
    const allowance = await enforceOtpSendRateLimits(db, {
        ip: input.ip,
        identifiers: [`order:${orderId}`],
        hashKey: input.encryptionKey,
    });

    const nowSeconds = currentUnixSeconds();
    const deliveryKey = createAuthOtpDeliveryKey();
    const challengeKey = await buildRecoveryChallengeKey({
        orderId,
        channel,
        identifier: target,
        encryptionKey: input.encryptionKey,
    });
    const code = await deriveCustomerAuthOtpDeliveryCode({
        otpKey: challengeKey,
        deliveryKey,
        encryptionKey: input.encryptionKey,
    });
    const challenge = await persistOrderOtpChallenge(db, {
        challengeKey,
        orderId,
        method,
        channel,
        identifier: target,
        deliveryTarget: target,
        deliveryName: order.customerName?.trim() || undefined,
        code,
        deliveryKey,
        encryptionKey: input.encryptionKey,
        deliveryEncryptionKey,
        nowSeconds,
        resendCooldownSeconds: allowance.resendCooldownSeconds,
    });

    return {
        queued: true,
        message: `We sent a code to ${destination}.`,
        channel,
        method,
        destination,
        orderNumber: order.orderNumber,
        resendAfterSeconds: Math.max(0, challenge.resendAvailableAt - nowSeconds),
        queuePayload: {
            type: "auth.send_otp",
            challengeKey: challenge.challengeKey,
            deliveryKey,
            purpose: ORDER_PAYMENT_RECOVERY_PURPOSE,
            otpExpiresAt: challenge.expiresAt,
            method,
            allowedMethod: channelToAllowedMethod(channel),
            channel,
        },
        challengeKey: challenge.challengeKey,
        deliveryKey,
    };
}

export async function verifyOrderPaymentRecoveryOtp(
    db: Database,
    input: VerifyOrderPaymentRecoveryOtpInput,
): Promise<VerifyOrderPaymentRecoveryOtpResult> {
    const orderId = input.orderId.trim();
    const code = input.code.trim();
    if (!orderId || !/^\d{4,12}$/.test(code)) {
        throw new ValidationError("Enter the 6-digit code.");
    }
    await previewOrderPaymentRecoveryLink(db, orderId);
    const nowSeconds = currentUnixSeconds();
    await consumeLatestOrderOtpChallenge(db, { orderId, keyPrefix: RECOVERY_KEY_PREFIX, code, encryptionKey: input.encryptionKey, nowSeconds });

    const recovery = await createOrderPaymentRecoveryLink(db, orderId, {
        nowSeconds,
        source: "guest_payment_recovery",
    });

    return {
        orderId: recovery.orderId,
        receiptToken: recovery.receiptToken,
        expiresAt: recovery.expiresAt,
        gateway: recovery.gateway,
        paymentType: recovery.paymentType,
        depositAmount: recovery.depositAmount,
        redirectParams: {
            payment: recovery.gateway,
            result: "failed",
            ...(recovery.paymentType ? { paymentType: recovery.paymentType } : {}),
            ...(typeof recovery.depositAmount === "number" ? { depositAmount: recovery.depositAmount } : {}),
        },
    };
}

/**
 * Checks a code against the order's latest challenge of one kind (payment
 * recovery or order lookup) and uses it up. Wrong codes count attempts.
 */
export async function consumeLatestOrderOtpChallenge(
    db: Database,
    input: { orderId: string; keyPrefix: string; code: string; encryptionKey?: string; nowSeconds: number },
): Promise<void> {
    const challenge = await db
        .select()
        .from(orderPaymentRecoveryChallenges)
        .where(and(
            eq(orderPaymentRecoveryChallenges.orderId, input.orderId),
            like(orderPaymentRecoveryChallenges.challengeKey, `${input.keyPrefix}%`),
        ))
        .orderBy(desc(orderPaymentRecoveryChallenges.updatedAt))
        .get();
    if (!challenge) throw new ValidationError("There's no active code. Send a new code.", { attemptsLeft: 0 });

    const codeHash = await hashRecoveryOtpCode(input.code, challenge.challengeKey, input.encryptionKey);
    const consumed = await db.update(orderPaymentRecoveryChallenges)
        .set({
            status: "consumed",
            attempts: sql`${orderPaymentRecoveryChallenges.attempts} + 1`,
            consumedAt: input.nowSeconds,
            updatedAt: input.nowSeconds,
        })
        .where(and(
            eq(orderPaymentRecoveryChallenges.challengeKey, challenge.challengeKey),
            eq(orderPaymentRecoveryChallenges.status, "pending"),
            gt(orderPaymentRecoveryChallenges.expiresAt, input.nowSeconds),
            sql`${orderPaymentRecoveryChallenges.attempts} < ${orderPaymentRecoveryChallenges.maxAttempts}`,
            eq(orderPaymentRecoveryChallenges.codeHash, codeHash),
        ))
        .returning({ challengeKey: orderPaymentRecoveryChallenges.challengeKey });
    if (consumed[0]) return;
    await recordWrongOrderOtpAttempt(db, {
        challengeKey: challenge.challengeKey,
        orderId: input.orderId,
        method: challenge.method,
        channel: challenge.channel,
        identifierHash: challenge.identifierHash,
        codeHash,
        nowSeconds: input.nowSeconds,
    });
}

/** The order has no email and the store can't text: no code can reach the buyer. */
export class NoOrderCodeChannelError extends AppError {
    constructor() {
        super(
            409,
            "NO_CODE_CHANNEL",
            "This order has no email address, and this store can't send text messages. Contact the store to check on your order.",
        );
    }
}

/** "b•••@example.com" or "01•••••678": enough for the buyer to know where to look. */
export function maskOrderContact(method: RecoveryMethod, target: string): string {
    return maskContact(method, target);
}

/**
 * Where a code for this order can actually go: the phone on the order when the
 * store can text (SMS, then WhatsApp), else the email on the order. The code
 * never goes to a contact the visitor typed.
 */
export async function chooseOrderCodeChannel(
    db: Database,
    order: { customerPhone: string; customerEmail: string | null },
    input: { channel?: CustomerAuthOtpChannel; emailEnv?: EmailRuntimeContext["env"]; credentialEncryptionKey?: string },
): Promise<{ channel: CustomerAuthOtpChannel; method: RecoveryMethod; target: string; destination: string }> {
    const [sms, whatsApp, email] = await Promise.all([
        getSmsProviderReadiness(db, input.credentialEncryptionKey),
        getWhatsAppCloudApiSettings(db, input.credentialEncryptionKey),
        getEmailProviderReadiness({ db, env: input.emailEnv, encryptionKey: input.credentialEncryptionKey }),
    ]);
    const orderEmail = order.customerEmail?.trim().toLowerCase() || null;
    const available: CustomerAuthOtpChannel[] = [];
    if (isReady(sms)) available.push("sms");
    if (whatsApp.accessToken && whatsApp.phoneNumberId) available.push("whatsapp");
    if (isReady(email) && orderEmail) available.push("email");
    const channel = input.channel && available.includes(input.channel) ? input.channel : available[0];
    if (!channel) throw new NoOrderCodeChannelError();
    const method: RecoveryMethod = channel === "email" ? "email" : "phone";
    const target = method === "email" ? orderEmail! : order.customerPhone;
    return { channel, method, target, destination: maskOrderContact(method, target) };
}

export async function deleteOrderPaymentRecoveryChallenge(
    db: Database,
    input: { challengeKey: string; deliveryKey: string },
): Promise<void> {
    await db.delete(orderPaymentRecoveryChallenges)
        .where(and(
            eq(orderPaymentRecoveryChallenges.challengeKey, input.challengeKey),
            eq(orderPaymentRecoveryChallenges.deliveryKey, input.deliveryKey),
            eq(orderPaymentRecoveryChallenges.status, "pending"),
        ));
}

export async function cleanupExpiredOrderPaymentRecoveryChallenges(
    db: Database,
    nowSeconds = currentUnixSeconds(),
    options: { limit?: number } = {},
): Promise<CleanupExpiredOrderPaymentRecoveryChallengesResult> {
    const limit = Math.max(1, Math.min(options.limit ?? 200, 500));
    const staleTerminalCutoff = nowSeconds - 60 * 60;
    const rows = await db.select({ challengeKey: orderPaymentRecoveryChallenges.challengeKey })
        .from(orderPaymentRecoveryChallenges)
        .where(or(
            lte(orderPaymentRecoveryChallenges.expiresAt, nowSeconds),
            and(
                ne(orderPaymentRecoveryChallenges.status, "pending"),
                lte(orderPaymentRecoveryChallenges.updatedAt, staleTerminalCutoff),
            ),
        ))
        .limit(limit + 1);

    const deleteIds = rows.slice(0, limit).map((row) => row.challengeKey);
    if (deleteIds.length > 0) {
        await db.delete(orderPaymentRecoveryChallenges)
            .where(inArray(orderPaymentRecoveryChallenges.challengeKey, deleteIds));
    }

    return {
        scanned: Math.min(rows.length, limit),
        deleted: deleteIds.length,
        limit,
        hasMore: rows.length > limit,
    };
}

async function getRecoveryOrderContact(
    db: Database,
    orderId: string,
): Promise<RecoveryOrderContact | null> {
    return await db
        .select({
            id: orders.id,
            orderNumber: orders.orderNumber,
            customerName: orders.customerName,
            customerPhone: orders.customerPhone,
            customerEmail: orders.customerEmail,
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .get() ?? null;
}

/** One pending code per challenge key (payment recovery or order lookup). */
export async function persistOrderOtpChallenge(
    db: Database,
    input: {
        orderId: string;
        challengeKey: string;
        method: RecoveryMethod;
        channel: CustomerAuthOtpChannel;
        identifier: string;
        deliveryTarget: string;
        deliveryName?: string;
        code: string;
        deliveryKey: string;
        encryptionKey?: string;
        deliveryEncryptionKey: string;
        nowSeconds: number;
        resendCooldownSeconds?: number;
    },
): Promise<{ challengeKey: string; identifierMasked: string; expiresAt: number; resendAvailableAt: number }> {
    const challengeKey = input.challengeKey;
    const identifierHash = await hashRecoveryIdentifier(input.identifier, input.encryptionKey);
    const codeHash = await hashRecoveryOtpCode(input.code, challengeKey, input.encryptionKey);
    const expiresAt = input.nowSeconds + OTP_TTL_SECONDS;
    const resendAvailableAt = input.nowSeconds + (input.resendCooldownSeconds ?? OTP_RESEND_COOLDOWN_SECONDS);
    const identifierMasked = maskOtpIdentifier(input.identifier);
    const deliveryTargetEncrypted = await encryptRecoveryDeliveryValue(
        input.deliveryTarget,
        input.deliveryEncryptionKey,
        "Payment recovery OTP delivery target",
    );
    const deliveryNameEncrypted = await encryptRecoveryDeliveryValue(
        input.deliveryName,
        input.deliveryEncryptionKey,
        "Payment recovery OTP delivery name",
    );

    const rows = await db.insert(orderPaymentRecoveryChallenges)
        .values({
            challengeKey,
            orderId: input.orderId,
            deliveryKey: input.deliveryKey,
            method: input.method,
            channel: input.channel,
            identifierHash,
            identifierMasked,
            deliveryTargetEncrypted,
            deliveryNameEncrypted,
            codeHash,
            status: "pending",
            attempts: 0,
            maxAttempts: OTP_MAX_ATTEMPTS,
            resendAvailableAt,
            expiresAt,
            consumedAt: null,
            createdAt: input.nowSeconds,
            updatedAt: input.nowSeconds,
        })
        .onConflictDoUpdate({
            target: orderPaymentRecoveryChallenges.challengeKey,
            set: {
                deliveryKey: input.deliveryKey,
                method: input.method,
                channel: input.channel,
                identifierHash,
                identifierMasked,
                deliveryTargetEncrypted,
                deliveryNameEncrypted,
                codeHash,
                status: "pending",
                attempts: 0,
                maxAttempts: OTP_MAX_ATTEMPTS,
                resendAvailableAt,
                expiresAt,
                consumedAt: null,
                updatedAt: input.nowSeconds,
            },
            where: or(
                lte(orderPaymentRecoveryChallenges.resendAvailableAt, input.nowSeconds),
                lte(orderPaymentRecoveryChallenges.expiresAt, input.nowSeconds),
                ne(orderPaymentRecoveryChallenges.status, "pending"),
            ),
        })
        .returning({
            challengeKey: orderPaymentRecoveryChallenges.challengeKey,
        });

    if (!rows[0]?.challengeKey) {
        const current = await db.select({ resendAvailableAt: orderPaymentRecoveryChallenges.resendAvailableAt })
            .from(orderPaymentRecoveryChallenges)
            .where(eq(orderPaymentRecoveryChallenges.challengeKey, challengeKey))
            .get();
        throw new RateLimitError(
            "A code was just sent. Please wait before asking for another.",
            Math.max(1, (current?.resendAvailableAt ?? resendAvailableAt) - input.nowSeconds),
        );
    }

    return { challengeKey, identifierMasked, expiresAt, resendAvailableAt };
}

export async function recordWrongOrderOtpAttempt(
    db: Database,
    input: {
        challengeKey: string;
        orderId: string;
        method: RecoveryMethod;
        channel: CustomerAuthOtpChannel;
        identifierHash: string;
        codeHash: string;
        nowSeconds: number;
    },
): Promise<never> {
    const wrongRows = await db.update(orderPaymentRecoveryChallenges)
        .set({
            attempts: sql`${orderPaymentRecoveryChallenges.attempts} + 1`,
            status: sql`case when ${orderPaymentRecoveryChallenges.attempts} + 1 >= ${orderPaymentRecoveryChallenges.maxAttempts} then 'locked' else ${orderPaymentRecoveryChallenges.status} end`,
            updatedAt: input.nowSeconds,
        })
        .where(and(
            eq(orderPaymentRecoveryChallenges.challengeKey, input.challengeKey),
            eq(orderPaymentRecoveryChallenges.orderId, input.orderId),
            eq(orderPaymentRecoveryChallenges.method, input.method),
            eq(orderPaymentRecoveryChallenges.channel, input.channel),
            eq(orderPaymentRecoveryChallenges.identifierHash, input.identifierHash),
            eq(orderPaymentRecoveryChallenges.status, "pending"),
            gt(orderPaymentRecoveryChallenges.expiresAt, input.nowSeconds),
            sql`${orderPaymentRecoveryChallenges.attempts} < ${orderPaymentRecoveryChallenges.maxAttempts}`,
            ne(orderPaymentRecoveryChallenges.codeHash, input.codeHash),
        ))
        .returning({
            attempts: orderPaymentRecoveryChallenges.attempts,
            maxAttempts: orderPaymentRecoveryChallenges.maxAttempts,
            status: orderPaymentRecoveryChallenges.status,
        });

    const wrong = wrongRows[0];
    if (wrong) {
        const attemptsLeft = Math.max(0, wrong.maxAttempts - wrong.attempts);
        if (wrong.status === "locked" || attemptsLeft === 0) {
            throw new ValidationError(OTP_LOCKED_MESSAGE, { attemptsLeft: 0 });
        }
        throw new ValidationError("That code isn't right. Check it and try again.", { attemptsLeft });
    }

    const existing = await db.select()
        .from(orderPaymentRecoveryChallenges)
        .where(eq(orderPaymentRecoveryChallenges.challengeKey, input.challengeKey))
        .get();

    if (!existing) {
        throw new ValidationError("There's no active code. Send a new code.", { attemptsLeft: 0 });
    }
    if (existing.status === "consumed") {
        throw new ValidationError("That code was already used. Send a new code.", { attemptsLeft: 0 });
    }
    if (existing.status === "locked" || existing.attempts >= existing.maxAttempts) {
        throw new ValidationError(OTP_LOCKED_MESSAGE, { attemptsLeft: 0 });
    }
    if (existing.expiresAt <= input.nowSeconds) {
        throw new ValidationError("That code has expired. Send a new code.", { attemptsLeft: 0 });
    }

    throw new ValidationError("That code couldn't be checked. Send a new code.", { attemptsLeft: 0 });
}

const RECOVERY_KEY_PREFIX = "order_payrec:";

async function buildRecoveryChallengeKey(input: {
    orderId: string;
    channel: CustomerAuthOtpChannel;
    identifier: string;
    encryptionKey?: string;
}): Promise<string> {
    return `${RECOVERY_KEY_PREFIX}${await hmacSha256Hex(
        requireOtpHashKey(input.encryptionKey),
        `order-payment-recovery-challenge:${input.orderId}:${input.channel}:${input.identifier.trim().toLowerCase()}`,
    )}`;
}

export async function hashRecoveryIdentifier(identifier: string, encryptionKey: string | undefined): Promise<string> {
    return hmacSha256Hex(
        requireOtpHashKey(encryptionKey),
        `order-payment-recovery-identifier:${identifier.trim().toLowerCase()}`,
    );
}

export async function hashRecoveryOtpCode(
    code: string,
    challengeKey: string,
    encryptionKey: string | undefined,
): Promise<string> {
    return hmacSha256Hex(
        requireOtpHashKey(encryptionKey),
        `order-payment-recovery-code:${challengeKey}:${code.trim()}`,
    );
}

export async function hmacSha256Hex(secret: string, value: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
    return Array.from(new Uint8Array(signature))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

export function requireOtpHashKey(encryptionKey: string | undefined): string {
    const key = encryptionKey?.trim();
    if (!key) {
        throw new ServiceUnavailableError("Order payment recovery signing key is not configured.");
    }
    return key;
}

export function requireRecoveryDeliveryEncryptionKey(encryptionKey: string | undefined): string {
    const key = encryptionKey?.trim();
    if (!key) {
        throw new ServiceUnavailableError("Payment recovery OTP delivery target encryption key is not configured.");
    }
    return key;
}

async function encryptRecoveryDeliveryValue(
    value: string | undefined,
    encryptionKey: string,
    label: string,
): Promise<string | null> {
    const trimmed = value?.trim();
    if (!trimmed) return null;
    try {
        return encodeEncryptedCredential(await encryptCredentials(trimmed, encryptionKey));
    } catch {
        throw new ServiceUnavailableError(`${label} could not be encrypted.`);
    }
}

export function channelToAllowedMethod(channel: CustomerAuthOtpChannel): string {
    if (channel === "whatsapp") return "whatsapp_otp";
    if (channel === "sms") return "sms_otp";
    return "email";
}

function currentUnixSeconds(): number {
    return Math.floor(Date.now() / 1000);
}
