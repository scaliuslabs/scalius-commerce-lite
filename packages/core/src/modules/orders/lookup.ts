// Public "Track your order". The order number alone shows nothing (audit R2
// F5): with the last 4 digits of the phone saved on the order, or its email,
// it opens a status view (first name, items, totals, tracking; the API route
// rate-limits it per IP and per order). Anything more is proven by a one-time
// code sent through a channel the merchant chose in Customer accounts to a
// contact SAVED on the order (never to what the visitor types). A correct
// code issues a private receipt proof, so the buyer lands on the normal
// receipt from any device.
import { and, eq, isNull, or, type SQL } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { orders } from "@scalius/database/schema";
import { NotFoundError, ValidationError } from "@scalius/core/errors";
import { toLatinDigits } from "@scalius/shared/phone-input";
import { parseOrderNumberSearch } from "@scalius/shared/order-utils";
import type { CustomerAuthOtpChannel } from "@scalius/shared/customer-auth-policy";
import type { EmailRuntimeContext } from "../../integrations/email";
import type { AppProviders } from "../../integrations/provider-port";
import {
  buildOtpDelivery,
  chooseOrderCodeChannel,
  createAuthOtpDeliveryKey,
  deriveCustomerAuthOtpDeliveryCode,
  enforceOtpSendRateLimits,
  type OtpDelivery,
} from "../customers";
import {
    consumeLatestOrderOtpChallenge,
    persistOrderOtpChallenge,
    requireOtpHashKey,
    requireRecoveryDeliveryEncryptionKey,
} from "./payment-recovery";
import { createOrderReceiptToken, recordOrderReceipt } from "./receipts";
import { hmacSha256Hex } from "@scalius/shared/hash";

const ORDER_LOOKUP_PURPOSE = "order_lookup";
const ORDER_LOOKUP_KEY_PREFIX = "order_lookup:";
const WRONG_CODE_MESSAGE = "That code isn't right. Check it and try again.";
/** One answer for every miss, so a number that doesn't exist looks like any other. */
export const ORDER_LOOKUP_NOT_FOUND_MESSAGE = "We couldn't find an order with that number and contact. Check them and try again.";

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

/**
 * The key a per-order rate limit counts under. It follows exactly how
 * `orderReferenceCondition` resolves the text, so every spelling of one order
 * ("1001", "#1001", "01001", "000001001", Bengali digits) shares one counter,
 * and an id keys by the id. Unresolvable text still gets a key, so a reference
 * that matches no order consumes its limit like any other.
 */
export function orderReferenceKey(reference: string): string {
    const orderNumber = parseOrderNumberSearch(reference ?? "");
    if (orderNumber !== null) return `n:${orderNumber}`;
    return toLatinDigits(reference ?? "").trim().replace(/^#\s*/, "").toUpperCase();
}

export interface SendOrderLookupOtpInput {
    reference: string;
    /** The last 4 digits of the order's phone, or its email: the number alone sends nothing. */
    contact: string;
    /** The merchant-chosen channel the buyer picked; the first available one otherwise. */
    channel?: CustomerAuthOtpChannel;
    ip: string;
    emailEnv?: EmailRuntimeContext["env"];
    encryptionKey?: string;
    credentialEncryptionKey?: string;
    /** The app providers a saved SMS or email choice may name. */
    appProviders?: AppProviders;
}

export interface SendOrderLookupOtpResult {
    message: string;
    /** Masked contact the code went to ("01•••••678" or "b•••@example.com"). */
    destination: string;
    channel: CustomerAuthOtpChannel;
    resendAfterSeconds: number;
    otpDelivery: OtpDelivery;
    challengeKey?: string;
    deliveryKey?: string;
}

export interface VerifyOrderLookupOtpResult {
    orderId: string;
    receiptToken: string;
    expiresAt: number;
}

function parseLookupReference(reference: string): { condition: SQL; referenceKey: string } {
    const condition = orderReferenceCondition(reference);
    if (!condition) throw new ValidationError("Enter your order number, for example #1001.");
    return { condition, referenceKey: orderReferenceKey(reference) };
}

function digitsOf(value: string | null | undefined): string {
    return toLatinDigits(value ?? "").replace(/\D/g, "");
}

/**
 * Whether what a visitor typed with the order number is a contact saved on
 * the order: an email (any case) or the last 4 digits of its phone or
 * WhatsApp number (a longer number counts by its last 4 digits). An order
 * placed without a phone (`NO_PHONE`) has no digits to match.
 */
export function orderLookupContactMatches(
    order: { customerPhone: string | null; customerEmail: string | null; customerWhatsapp: string | null },
    contact: string,
): boolean {
    const typed = toLatinDigits(contact ?? "").trim();
    if (typed.length === 0 || typed.length > 254) return false;
    if (typed.includes("@")) {
        const email = order.customerEmail?.trim().toLowerCase();
        return Boolean(email) && email === typed.toLowerCase();
    }
    if (/[^\d\s()+.-]/.test(typed)) return false;
    const digits = digitsOf(typed);
    if (digits.length < 4 || digits.length > 15) return false;
    const last4 = digits.slice(-4);
    return [order.customerPhone, order.customerWhatsapp].some((phone) => {
        const saved = digitsOf(phone);
        return saved.length >= 4 && saved.slice(-4) === last4;
    });
}

/**
 * The order a reference names, when the contact is one saved on it. Null for
 * a miss of either, so a wrong contact looks like a wrong number.
 */
export async function findOrderByReferenceAndContact(db: Database, reference: string, contact: string) {
    const order = await findOrderByReference(db, reference);
    return order && orderLookupContactMatches(order, contact) ? order : null;
}

/** The order a reference names, with the contacts codes may go to. Null when none. */
export async function findOrderByReference(db: Database, reference: string) {
    const condition = orderReferenceCondition(reference);
    if (!condition) return null;
    return await db
        .select({
            id: orders.id,
            customerPhone: orders.customerPhone,
            customerEmail: orders.customerEmail,
            customerWhatsapp: orders.customerWhatsapp,
        })
        .from(orders)
        .where(and(condition, isNull(orders.deletedAt)))
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
    const lookup = parseLookupReference(input.reference);
    const deliveryEncryptionKey = requireRecoveryDeliveryEncryptionKey(input.credentialEncryptionKey);
    const allowance = await enforceOtpSendRateLimits(db, {
        ip: input.ip,
        identifiers: [`lookup-order:${lookup.referenceKey}`],
        hashKey: input.encryptionKey,
    });

    // The visitor proved a contact saved on the order; the code still goes to
    // the saved contact, never to anything the visitor typed.
    const order = await findOrderByReferenceAndContact(db, input.reference, input.contact);
    if (!order) throw new NotFoundError(ORDER_LOOKUP_NOT_FOUND_MESSAGE);
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
        otpDelivery: buildOtpDelivery({
            channel,
            purpose: ORDER_LOOKUP_PURPOSE,
            challengeKey,
            deliveryKey,
        }),
        challengeKey,
        deliveryKey,
    };
}

export async function verifyOrderLookupOtp(
    db: Database,
    input: { reference: string; code: string; encryptionKey?: string },
): Promise<VerifyOrderLookupOtpResult> {
    parseLookupReference(input.reference);
    const code = input.code?.trim() ?? "";
    if (!/^\d{4,12}$/.test(code)) throw new ValidationError("Enter the 6-digit code.");

    const order = await findOrderByReference(db, input.reference);
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
