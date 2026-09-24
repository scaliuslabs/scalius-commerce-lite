// Public "Track your order": order number + the phone on the order, proven by
// a one-time code sent to the contact SAVED on the order (never to what the
// visitor types). A correct code issues a private receipt proof, so the buyer
// lands on the normal receipt / order-status page from any device.
import { and, eq, isNull, or, type SQL } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { orders } from "@scalius/database/schema";
import { NotFoundError, ValidationError } from "@scalius/core/errors";
import { validateAndFormatPhone } from "@scalius/shared/customer-utils";
import { toLatinDigits } from "@scalius/shared/phone-input";
import { parseOrderNumberSearch } from "@scalius/shared/order-utils";
import type { CustomerAuthOtpChannel } from "@scalius/shared/customer-auth-policy";
import type { EmailRuntimeContext } from "../../integrations/email";
import { enforceOtpSendRateLimits } from "../customers/customer-auth-rate-limit";
import { createAuthOtpDeliveryKey } from "../customers/otp-delivery-receipts";
import type { OtpQueuePayload } from "../customers/otp-transport";
import { deriveCustomerAuthOtpDeliveryCode } from "../customers/customer-auth.service";
import {
    channelToAllowedMethod,
    chooseOrderCodeChannel,
    consumeLatestOrderOtpChallenge,
    hmacSha256Hex,
    persistOrderOtpChallenge,
    requireOtpHashKey,
    requireRecoveryDeliveryEncryptionKey,
} from "./order-payment-recovery";
import { createOrderReceiptToken, recordOrderReceipt } from "./order-receipts";

const ORDER_LOOKUP_PURPOSE = "order_lookup";
const ORDER_LOOKUP_KEY_PREFIX = "order_lookup:";
const WRONG_CODE_MESSAGE = "That code isn't right. Check it and try again.";
const NOT_FOUND_MESSAGE = "We couldn't find an order with that number and phone number. Check both and try again.";

/**
 * The order a buyer names: "#1001", "1001" or the internal id. Returns null
 * for text that cannot be an order reference.
 */
export function orderReferenceCondition(reference: string): SQL | null {
    const id = toLatinDigits(reference ?? "").trim().replace(/^#\s*/, "");
    if (!/^[A-Za-z0-9]{4,32}$/.test(id)) return null;
    const orderNumber = parseOrderNumberSearch(reference ?? "");
    if (orderNumber !== null) return eq(orders.orderNumber, orderNumber);
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
    /** Masked contact the code went to ("01•••••678" or "b•••@example.com"). */
    destination: string;
    channel: CustomerAuthOtpChannel;
    resendAfterSeconds: number;
    queuePayload: OtpQueuePayload;
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
    const allowance = await enforceOtpSendRateLimits(db, {
        ip: input.ip,
        identifiers: [`lookup-order:${lookup.referenceKey}`, `lookup-phone:${lookup.phone}`],
        hashKey: input.encryptionKey,
    });

    // The buyer holds both the order number and its phone, so say plainly
    // whether it matched and where the code went (never a code that can't
    // arrive). Limits per order number and per phone keep guessing useless.
    const order = await findLookupOrder(db, lookup.condition, lookup.phone);
    if (!order) throw new NotFoundError(NOT_FOUND_MESSAGE);
    const { channel, method, target, destination } = await chooseOrderCodeChannel(db, order, input);

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
        resendCooldownSeconds: allowance.resendCooldownSeconds,
    });

    return {
        message: `We sent a code to ${destination}.`,
        destination,
        channel,
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

    const nowSeconds = Math.floor(Date.now() / 1000);
    await consumeLatestOrderOtpChallenge(db, {
        orderId: order.id,
        keyPrefix: ORDER_LOOKUP_KEY_PREFIX,
        code,
        encryptionKey: input.encryptionKey,
        nowSeconds,
    });

    const receiptToken = createOrderReceiptToken();
    const receipt = await recordOrderReceipt(db, {
        orderId: order.id,
        token: receiptToken,
        source: ORDER_LOOKUP_PURPOSE,
        nowSeconds,
    });
    return { orderId: order.id, receiptToken, expiresAt: receipt.expiresAt };
}
