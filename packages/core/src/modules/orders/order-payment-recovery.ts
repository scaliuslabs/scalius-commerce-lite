import { and, eq, gt, inArray, lte, ne, or, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import {
    orderPaymentRecoveryChallenges,
    orders,
    settings as genericSettings,
    siteSettings,
} from "@scalius/database/schema";
import { RateLimitError, ServiceUnavailableError, ValidationError } from "@scalius/core/errors";
import {
    isCustomerAuthOtpChannel,
    normalizeCustomerAuthPolicy,
    type CustomerAuthOtpChannel,
} from "@scalius/shared/customer-auth-policy";
import { getEmailProviderReadiness, type EmailRuntimeContext } from "../../integrations/email";
import { getSmsProviderReadiness } from "../../integrations/sms";
import { getWhatsAppCloudApiSettings } from "../../integrations/whatsapp";
import { createAuthOtpDeliveryKey, maskOtpIdentifier } from "../customers/otp-delivery-receipts";
import type { OtpQueuePayload } from "../customers/otp-transport";
import {
    enforceCustomerAuthOtpIpRateLimit,
} from "../customers/customer-auth-rate-limit";
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
const OTP_RESEND_COOLDOWN_SECONDS = 2 * 60;
const OTP_MAX_ATTEMPTS = 5;
const GENERIC_RECOVERY_MESSAGE = "If this order can be recovered, a verification code was sent to the buyer contact.";

type RecoveryMethod = "email" | "phone";

export interface SendOrderPaymentRecoveryOtpInput {
    orderId: string;
    channel?: CustomerAuthOtpChannel;
    ip: string;
    emailEnv?: EmailRuntimeContext["env"];
    encryptionKey?: string;
    credentialEncryptionKey?: string;
    migrationEncryptionKey?: string;
}

export interface SendOrderPaymentRecoveryOtpResult {
    queued: boolean;
    message: string;
    channel?: CustomerAuthOtpChannel;
    method?: RecoveryMethod;
    identifierMasked?: string;
    queuePayload?: OtpQueuePayload;
    challengeKey?: string;
    deliveryKey?: string;
}

export interface VerifyOrderPaymentRecoveryOtpInput {
    orderId: string;
    channel: CustomerAuthOtpChannel;
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

    const { channel, method, identifier } = await resolveRecoveryChannel(db, order, input.channel);
    const deliveryEncryptionKey = requireRecoveryDeliveryEncryptionKey(input.credentialEncryptionKey);
    await assertRecoveryChannelReady(db, {
        channel,
        emailEnv: input.emailEnv,
        credentialEncryptionKey: input.credentialEncryptionKey,
        migrationEncryptionKey: input.migrationEncryptionKey,
    });

    await enforceCustomerAuthOtpIpRateLimit(db, {
        ip: input.ip,
        hashKey: input.encryptionKey,
    });

    const nowSeconds = currentUnixSeconds();
    const deliveryKey = createAuthOtpDeliveryKey();
    const challengeKey = await buildRecoveryChallengeKey({
        orderId,
        channel,
        identifier,
        encryptionKey: input.encryptionKey,
    });
    const code = await deriveCustomerAuthOtpDeliveryCode({
        otpKey: challengeKey,
        deliveryKey,
        encryptionKey: input.encryptionKey,
    });
    const challenge = await persistOrderPaymentRecoveryChallenge(db, {
        challengeKey,
        orderId,
        method,
        channel,
        identifier,
        deliveryTarget: identifier,
        deliveryName: order.customerName?.trim() || "Customer",
        code,
        deliveryKey,
        encryptionKey: input.encryptionKey,
        deliveryEncryptionKey,
        nowSeconds,
    });

    return {
        queued: true,
        message: "Verification code sent. Please check the buyer contact.",
        channel,
        method,
        identifierMasked: challenge.identifierMasked,
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
    if (!orderId || !code || !isCustomerAuthOtpChannel(input.channel)) {
        throw new ValidationError("Verification code could not be verified. Please request a new code.");
    }

    const order = await getRecoveryOrderContact(db, orderId);
    if (!order) {
        throw new ValidationError("Verification code could not be verified. Please request a new code.");
    }

    const { channel, method, identifier } = await resolveRecoveryChannel(db, order, input.channel);
    await previewOrderPaymentRecoveryLink(db, orderId);

    const challengeKey = await buildRecoveryChallengeKey({
        orderId,
        channel,
        identifier,
        encryptionKey: input.encryptionKey,
    });
    const identifierHash = await hashRecoveryIdentifier(identifier, input.encryptionKey);
    const codeHash = await hashRecoveryOtpCode(code, challengeKey, input.encryptionKey);
    const nowSeconds = currentUnixSeconds();

    const consumedRows = await db.update(orderPaymentRecoveryChallenges)
        .set({
            status: "consumed",
            attempts: sql`${orderPaymentRecoveryChallenges.attempts} + 1`,
            consumedAt: nowSeconds,
            updatedAt: nowSeconds,
        })
        .where(and(
            eq(orderPaymentRecoveryChallenges.challengeKey, challengeKey),
            eq(orderPaymentRecoveryChallenges.orderId, orderId),
            eq(orderPaymentRecoveryChallenges.method, method),
            eq(orderPaymentRecoveryChallenges.channel, channel),
            eq(orderPaymentRecoveryChallenges.identifierHash, identifierHash),
            eq(orderPaymentRecoveryChallenges.status, "pending"),
            gt(orderPaymentRecoveryChallenges.expiresAt, nowSeconds),
            sql`${orderPaymentRecoveryChallenges.attempts} < ${orderPaymentRecoveryChallenges.maxAttempts}`,
            eq(orderPaymentRecoveryChallenges.codeHash, codeHash),
        ))
        .returning({
            challengeKey: orderPaymentRecoveryChallenges.challengeKey,
        });

    if (!consumedRows[0]?.challengeKey) {
        await recordWrongRecoveryOtpAttempt(db, {
            challengeKey,
            orderId,
            method,
            channel,
            identifierHash,
            codeHash,
            nowSeconds,
        });
    }

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
            customerName: orders.customerName,
            customerPhone: orders.customerPhone,
            customerEmail: orders.customerEmail,
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .get() ?? null;
}

async function resolveRecoveryChannel(
    db: Database,
    order: RecoveryOrderContact,
    requestedChannel: CustomerAuthOtpChannel | undefined,
): Promise<{ channel: CustomerAuthOtpChannel; method: RecoveryMethod; identifier: string }> {
    const policy = await getRecoveryOtpPolicy(db);
    const channels = policy.otpChannels.filter((channel) => {
        if (channel === "email") return Boolean(order.customerEmail?.trim());
        return Boolean(order.customerPhone?.trim());
    });

    if (requestedChannel && !channels.includes(requestedChannel)) {
        throw new ValidationError("That verification channel is not available for this order.");
    }

    const channel = requestedChannel && channels.includes(requestedChannel)
        ? requestedChannel
        : channels.includes(policy.defaultOtpChannel)
            ? policy.defaultOtpChannel
            : channels[0];

    if (!channel) {
        throw new ValidationError("No verification channel is available for this order.");
    }

    if (channel === "email") {
        const identifier = order.customerEmail?.trim().toLowerCase();
        if (!identifier) {
            throw new ValidationError("Email verification is not available for this order.");
        }
        return { channel, method: "email", identifier };
    }

    const identifier = order.customerPhone?.trim();
    if (!identifier) {
        throw new ValidationError("Phone verification is not available for this order.");
    }
    return { channel, method: "phone", identifier };
}

async function getRecoveryOtpPolicy(db: Database) {
    const [settingsRow, policyRow] = await Promise.all([
        db.select().from(siteSettings).limit(1).then((rows) => rows[0] ?? null),
        db.select({ value: genericSettings.value })
            .from(genericSettings)
            .where(and(eq(genericSettings.category, "customer_auth"), eq(genericSettings.key, "policy")))
            .get()
            .catch(() => null),
    ]);

    if (!settingsRow) {
        throw new ServiceUnavailableError("Customer authentication settings are not initialized.");
    }

    return normalizeCustomerAuthPolicy(
        parseJson(policyRow?.value),
        settingsRow.authVerificationMethod,
    );
}

async function assertRecoveryChannelReady(
    db: Database,
    input: {
        channel: CustomerAuthOtpChannel;
        emailEnv?: EmailRuntimeContext["env"];
        credentialEncryptionKey?: string;
        migrationEncryptionKey?: string;
    },
): Promise<void> {
    if (input.channel === "email") {
        const readiness = await getEmailProviderReadiness({
            db,
            env: input.emailEnv,
            encryptionKey: input.credentialEncryptionKey,
        });
        if (!readiness.configured) {
            throw new ServiceUnavailableError("Email verification is currently unavailable. Contact store support.");
        }
        return;
    }

    if (input.channel === "sms") {
        const readiness = await getSmsProviderReadiness(db, input.credentialEncryptionKey);
        if (!readiness.configured) {
            throw new ServiceUnavailableError("SMS verification is currently unavailable. Contact store support.");
        }
        return;
    }

    const whatsAppSettings = await getWhatsAppCloudApiSettings(db, input.credentialEncryptionKey, {
        migrateLegacy: true,
        migrationEncryptionKey: input.migrationEncryptionKey,
    });
    if (!whatsAppSettings.accessToken || !whatsAppSettings.phoneNumberId) {
        throw new ServiceUnavailableError("WhatsApp verification is currently unavailable. Contact store support.");
    }
}

async function persistOrderPaymentRecoveryChallenge(
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
    },
): Promise<{ challengeKey: string; identifierMasked: string; expiresAt: number }> {
    const challengeKey = input.challengeKey;
    const identifierHash = await hashRecoveryIdentifier(input.identifier, input.encryptionKey);
    const codeHash = await hashRecoveryOtpCode(input.code, challengeKey, input.encryptionKey);
    const expiresAt = input.nowSeconds + OTP_TTL_SECONDS;
    const resendAvailableAt = input.nowSeconds + OTP_RESEND_COOLDOWN_SECONDS;
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
        throw new RateLimitError(
            "A verification code was recently sent. Please wait a moment before requesting a new one.",
            OTP_RESEND_COOLDOWN_SECONDS,
        );
    }

    return { challengeKey, identifierMasked, expiresAt };
}

async function recordWrongRecoveryOtpAttempt(
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
        if (wrong.status === "locked" || wrong.attempts >= wrong.maxAttempts) {
            throw new RateLimitError("Too many failed attempts. Please request a new code.");
        }
        throw new ValidationError("Incorrect code. Please try again.", {
            attemptsLeft: wrong.maxAttempts - wrong.attempts,
        });
    }

    const existing = await db.select()
        .from(orderPaymentRecoveryChallenges)
        .where(eq(orderPaymentRecoveryChallenges.challengeKey, input.challengeKey))
        .get();

    if (!existing) {
        throw new ValidationError("No verification code found. Please request a new one.");
    }
    if (existing.expiresAt <= input.nowSeconds) {
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

async function buildRecoveryChallengeKey(input: {
    orderId: string;
    channel: CustomerAuthOtpChannel;
    identifier: string;
    encryptionKey?: string;
}): Promise<string> {
    return `order_payrec:${await hmacSha256Hex(
        requireOtpHashKey(input.encryptionKey),
        `order-payment-recovery-challenge:${input.orderId}:${input.channel}:${input.identifier.trim().toLowerCase()}`,
    )}`;
}

async function hashRecoveryIdentifier(identifier: string, encryptionKey: string | undefined): Promise<string> {
    return hmacSha256Hex(
        requireOtpHashKey(encryptionKey),
        `order-payment-recovery-identifier:${identifier.trim().toLowerCase()}`,
    );
}

async function hashRecoveryOtpCode(
    code: string,
    challengeKey: string,
    encryptionKey: string | undefined,
): Promise<string> {
    return hmacSha256Hex(
        requireOtpHashKey(encryptionKey),
        `order-payment-recovery-code:${challengeKey}:${code.trim()}`,
    );
}

async function hmacSha256Hex(secret: string, value: string): Promise<string> {
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

function requireOtpHashKey(encryptionKey: string | undefined): string {
    const key = encryptionKey?.trim();
    if (!key) {
        throw new ServiceUnavailableError("Order payment recovery signing key is not configured.");
    }
    return key;
}

function requireRecoveryDeliveryEncryptionKey(encryptionKey: string | undefined): string {
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

function channelToAllowedMethod(channel: CustomerAuthOtpChannel): string {
    if (channel === "whatsapp") return "whatsapp_otp";
    if (channel === "sms") return "sms_otp";
    return "email";
}

function parseJson(value: string | null | undefined): unknown {
    if (!value) return undefined;
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return undefined;
    }
}

function currentUnixSeconds(): number {
    return Math.floor(Date.now() / 1000);
}
