// Public "Track your order": order number + the phone on the order, proven by
// a one-time code sent to the contact SAVED on the order (never to what the
// visitor types). A correct code issues a private receipt proof, so the buyer
// lands on the normal receipt / order-status page from any device.
import { and, desc, eq, gt, isNull, like, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { orderPaymentRecoveryChallenges, orders } from "@scalius/database/schema";
import { ServiceUnavailableError, ValidationError } from "@scalius/core/errors";
import { validateAndFormatPhone } from "@scalius/shared/customer-utils";
import { toLatinDigits } from "@scalius/shared/phone-input";
import type { CustomerAuthOtpChannel } from "@scalius/shared/customer-auth-policy";
import { isReady } from "@scalius/shared/readiness";
import { getEmailProviderReadiness, type EmailRuntimeContext } from "../../integrations/email";
import { getSmsProviderReadiness } from "../../integrations/sms";
import { getWhatsAppCloudApiSettings } from "../../integrations/whatsapp";
import { enforceOtpSendRateLimits } from "../customers/customer-auth-rate-limit";
import { createAuthOtpDeliveryKey } from "../customers/otp-delivery-receipts";
import type { OtpQueuePayload } from "../customers/otp-transport";
import { deriveCustomerAuthOtpDeliveryCode } from "../customers/customer-auth.service";
import {
    channelToAllowedMethod,
    hashRecoveryOtpCode,
    hmacSha256Hex,
    persistOrderOtpChallenge,
    recordWrongOrderOtpAttempt,
    requireOtpHashKey,
    requireRecoveryDeliveryEncryptionKey,
} from "./order-payment-recovery";
import { createOrderReceiptToken, recordOrderReceipt } from "./order-receipts";

const ORDER_LOOKUP_PURPOSE = "order_lookup";
const ORDER_LOOKUP_KEY_PREFIX = "order_lookup:";
const OTP_RESEND_COOLDOWN_SECONDS = 60;
const WRONG_CODE_MESSAGE = "That code isn't right. Check it and try again.";

/** Same answer whether or not an order matched: lookups never reveal orders. */
export const ORDER_LOOKUP_SENT_MESSAGE =
    "If these details match an order, we've sent a code to the phone number or email saved on it.";

/**
 * The order a buyer names: "#1001", "1001" or the internal id. Returns null
 * for text that cannot be an order reference.
 */
export function orderReferenceCondition(reference: string): SQL | null {
    const id = toLatinDigits(reference ?? "").trim().replace(/^#\s*/, "");
    if (!/^[A-Za-z0-9]{4,32}$/.test(id)) return null;
    // TODO(F4 0070): also match the short order number, e.g.
    //   const orderNumber = parseOrderNumberSearch(reference);
    //   if (orderNumber !== null) return or(eq(orders.orderNumber, orderNumber), eq(orders.id, id))
    return or(eq(orders.id, id), eq(orders.id, id.toUpperCase()))!;
}

export interface SendOrderLookupOtpInput {
    reference: string;
    phone: string;
    ip: string;
    emailEnv?: EmailRuntimeContext["env"];
    encryptionKey?: string;
    credentialEncryptionKey?: string;
}

export interface SendOrderLookupOtpResult {
    message: string;
    resendAfterSeconds: number;
    queuePayload: OtpQueuePayload | null;
    challengeKey?: string;
    deliveryKey?: string;
}

export interface VerifyOrderLookupOtpResult {
    orderId: string;
    receiptToken: string;
    expiresAt: number;
}

function parseLookupInput(reference: string, phone: string): { condition: SQL; phone: string; referenceKey: string } {
    const condition = orderReferenceCondition(reference);
    if (!condition) throw new ValidationError("Enter your order number, for example #1001.");
    let normalizedPhone: string;
    try {
        normalizedPhone = validateAndFormatPhone(phone ?? "");
    } catch {
        throw new ValidationError("Enter the phone number used for the order.");
    }
    const referenceKey = toLatinDigits(reference).trim().replace(/^#\s*/, "").toUpperCase();
    return { condition, phone: normalizedPhone, referenceKey };
}

async function findLookupOrder(db: Database, condition: SQL, phone: string) {
    return await db
        .select({
            id: orders.id,
            customerPhone: orders.customerPhone,
            customerEmail: orders.customerEmail,
        })
        .from(orders)
        .where(and(condition, eq(orders.customerPhone, phone), isNull(orders.deletedAt)))
        .get() ?? null;
}

/** Store-wide delivery options, independent of any order (so nothing leaks). */
async function readyLookupChannels(
    db: Database,
    input: Pick<SendOrderLookupOtpInput, "emailEnv" | "credentialEncryptionKey">,
): Promise<{ phone: "sms" | "whatsapp" | null; email: boolean }> {
    const [sms, whatsApp, email] = await Promise.all([
        getSmsProviderReadiness(db, input.credentialEncryptionKey),
        getWhatsAppCloudApiSettings(db, input.credentialEncryptionKey),
        getEmailProviderReadiness({ db, env: input.emailEnv, encryptionKey: input.credentialEncryptionKey }),
    ]);
    return {
        phone: isReady(sms) ? "sms" : whatsApp.accessToken && whatsApp.phoneNumberId ? "whatsapp" : null,
        email: isReady(email),
    };
}

async function buildLookupChallengeKey(orderId: string, channel: CustomerAuthOtpChannel, target: string, encryptionKey?: string) {
    return `${ORDER_LOOKUP_KEY_PREFIX}${await hmacSha256Hex(
        requireOtpHashKey(encryptionKey),
        `order-lookup-challenge:${orderId}:${channel}:${target.trim().toLowerCase()}`,
    )}`;
}

export async function sendOrderLookupOtp(
    db: Database,
    input: SendOrderLookupOtpInput,
): Promise<SendOrderLookupOtpResult> {
    const lookup = parseLookupInput(input.reference, input.phone);
    const deliveryEncryptionKey = requireRecoveryDeliveryEncryptionKey(input.credentialEncryptionKey);
    const channels = await readyLookupChannels(db, input);
    if (!channels.phone && !channels.email) {
        throw new ServiceUnavailableError("Order tracking isn't available right now. Contact the store.");
    }

    await enforceOtpSendRateLimits(db, {
        ip: input.ip,
        identifiers: [`lookup-order:${lookup.referenceKey}`, `lookup-phone:${lookup.phone}`],
        hashKey: input.encryptionKey,
    });

    const notSent = { message: ORDER_LOOKUP_SENT_MESSAGE, resendAfterSeconds: OTP_RESEND_COOLDOWN_SECONDS, queuePayload: null };
    const order = await findLookupOrder(db, lookup.condition, lookup.phone);
    if (!order) return notSent;

    const email = order.customerEmail?.trim().toLowerCase();
    const channel: CustomerAuthOtpChannel | null = channels.phone ?? (channels.email && email ? "email" : null);
    if (!channel) return notSent;
    const method = channel === "email" ? "email" : "phone";
    const target = channel === "email" ? email! : order.customerPhone;

    const nowSeconds = Math.floor(Date.now() / 1000);
    const deliveryKey = createAuthOtpDeliveryKey();
    const challengeKey = await buildLookupChallengeKey(order.id, channel, target, input.encryptionKey);
    const code = await deriveCustomerAuthOtpDeliveryCode({ otpKey: challengeKey, deliveryKey, encryptionKey: input.encryptionKey });
    const challenge = await persistOrderOtpChallenge(db, {
        challengeKey,
        orderId: order.id,
        method,
        channel,
        identifier: target,
        deliveryTarget: target,
        code,
        deliveryKey,
        encryptionKey: input.encryptionKey,
        deliveryEncryptionKey,
        nowSeconds,
    });

    return {
        message: ORDER_LOOKUP_SENT_MESSAGE,
        resendAfterSeconds: Math.max(0, challenge.resendAvailableAt - nowSeconds),
        queuePayload: {
            type: "auth.send_otp",
            challengeKey,
            deliveryKey,
            purpose: ORDER_LOOKUP_PURPOSE,
            otpExpiresAt: challenge.expiresAt,
            method,
            allowedMethod: channelToAllowedMethod(channel),
            channel,
        },
        challengeKey,
        deliveryKey,
    };
}

export async function verifyOrderLookupOtp(
    db: Database,
    input: { reference: string; phone: string; code: string; encryptionKey?: string },
): Promise<VerifyOrderLookupOtpResult> {
    const lookup = parseLookupInput(input.reference, input.phone);
    const code = input.code?.trim() ?? "";
    if (!/^\d{4,12}$/.test(code)) throw new ValidationError("Enter the 6-digit code.");

    const order = await findLookupOrder(db, lookup.condition, lookup.phone);
    if (!order) throw new ValidationError(WRONG_CODE_MESSAGE);

    const challenge = await db
        .select()
        .from(orderPaymentRecoveryChallenges)
        .where(and(
            eq(orderPaymentRecoveryChallenges.orderId, order.id),
            like(orderPaymentRecoveryChallenges.challengeKey, `${ORDER_LOOKUP_KEY_PREFIX}%`),
        ))
        .orderBy(desc(orderPaymentRecoveryChallenges.updatedAt))
        .get();
    if (!challenge) throw new ValidationError("There's no active code. Send a new code.", { attemptsLeft: 0 });

    const nowSeconds = Math.floor(Date.now() / 1000);
    const codeHash = await hashRecoveryOtpCode(code, challenge.challengeKey, input.encryptionKey);
    const consumed = await db.update(orderPaymentRecoveryChallenges)
        .set({
            status: "consumed",
            attempts: sql`${orderPaymentRecoveryChallenges.attempts} + 1`,
            consumedAt: nowSeconds,
            updatedAt: nowSeconds,
        })
        .where(and(
            eq(orderPaymentRecoveryChallenges.challengeKey, challenge.challengeKey),
            eq(orderPaymentRecoveryChallenges.status, "pending"),
            gt(orderPaymentRecoveryChallenges.expiresAt, nowSeconds),
            sql`${orderPaymentRecoveryChallenges.attempts} < ${orderPaymentRecoveryChallenges.maxAttempts}`,
            eq(orderPaymentRecoveryChallenges.codeHash, codeHash),
        ))
        .returning({ challengeKey: orderPaymentRecoveryChallenges.challengeKey });
    if (!consumed[0]) {
        await recordWrongOrderOtpAttempt(db, {
            challengeKey: challenge.challengeKey,
            orderId: order.id,
            method: challenge.method,
            channel: challenge.channel,
            identifierHash: challenge.identifierHash,
            codeHash,
            nowSeconds,
        });
    }

    const receiptToken = createOrderReceiptToken();
    const receipt = await recordOrderReceipt(db, {
        orderId: order.id,
        token: receiptToken,
        source: ORDER_LOOKUP_PURPOSE,
        nowSeconds,
    });
    return { orderId: order.id, receiptToken, expiresAt: receipt.expiresAt };
}
