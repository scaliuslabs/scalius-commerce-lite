// Send-time facts for `gift_card_issued` (Wave B §10). The outbox row carries
// the card id only; the code is decrypted here, at send time, and handed to
// the renderer as a template variable that the delivery receipt redacts. It
// is never persisted, logged or queued.
//
// Who receives it: the recipient contact on the card; else the order contact
// (a purchase or store credit without a recipient); else the owning
// customer's contacts. A contact here is a delivery target only.
import { eq } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { customers, giftCards, orders } from "@scalius/database/schema";
import { formatGiftCardCode } from "@scalius/shared/gift-card-code";
import { decryptGiftCardCode, deriveGiftCardKeys } from "./crypto";
import { maskGiftCardRecipient } from "./mask";

export interface GiftCardIssuedMessage {
    giftCardId: string;
    /** `XXXX-XXXX-XXXX-XXXX`: for the renderer only. */
    code: string;
    last4: string;
    amountMinor: number;
    currencyCode: string;
    expiresAt: number | null;
    message: string | null;
    /** Who sent it (the buyer's name) when the card goes to someone else. */
    senderName: string | null;
    recipient: { name: string | null; email: string | null; phone: string | null };
    orderId: string | null;
    orderNumber: number | null;
}

/**
 * The message for an issued card, or null when there is nothing to send: the
 * card is gone, disabled, spent, or nobody can be reached. A missing or wrong
 * key throws (`GiftCardsUnavailableError`) so the outbox retries.
 */
export async function resolveGiftCardIssuedMessage(
    db: Database,
    input: { giftCardId: string; credentialEncryptionKey: string | null | undefined },
): Promise<GiftCardIssuedMessage | null> {
    const card = await db.select({
        id: giftCards.id,
        codeCiphertext: giftCards.codeCiphertext,
        last4: giftCards.codeLast4,
        initialAmountMinor: giftCards.initialAmountMinor,
        balanceMinor: giftCards.balanceMinor,
        currencyCode: giftCards.currencyCode,
        status: giftCards.status,
        expiresAt: giftCards.expiresAt,
        message: giftCards.message,
        recipientName: giftCards.recipientName,
        recipientEmail: giftCards.recipientEmail,
        recipientPhone: giftCards.recipientPhone,
        customerId: giftCards.customerId,
        sourceOrderId: giftCards.sourceOrderId,
    }).from(giftCards).where(eq(giftCards.id, input.giftCardId)).get();
    if (!card || card.status !== "active") return null;

    const order = card.sourceOrderId
        ? await db.select({
            orderNumber: orders.orderNumber,
            customerName: orders.customerName,
            customerEmail: orders.customerEmail,
            customerPhone: orders.customerPhone,
        }).from(orders).where(eq(orders.id, card.sourceOrderId)).get()
        : undefined;

    const hasRecipient = Boolean(card.recipientEmail || card.recipientPhone);
    let recipient: GiftCardIssuedMessage["recipient"];
    if (hasRecipient) {
        recipient = { name: card.recipientName, email: card.recipientEmail, phone: card.recipientPhone };
    } else if (order) {
        recipient = { name: card.recipientName ?? order.customerName, email: order.customerEmail, phone: order.customerPhone };
    } else if (card.customerId) {
        const customer = await db.select({ name: customers.name, email: customers.email, phone: customers.phone })
            .from(customers).where(eq(customers.id, card.customerId)).get();
        recipient = customer
            ? { name: card.recipientName ?? customer.name, email: customer.email, phone: customer.phone }
            : { name: card.recipientName, email: null, phone: null };
    } else {
        recipient = { name: card.recipientName, email: null, phone: null };
    }
    if (!recipient.email && !recipient.phone) return null;

    const keys = await deriveGiftCardKeys(input.credentialEncryptionKey);
    const code = formatGiftCardCode(await decryptGiftCardCode(keys, card.codeCiphertext));
    return {
        giftCardId: card.id,
        code,
        last4: card.last4,
        amountMinor: card.initialAmountMinor,
        currencyCode: card.currencyCode,
        expiresAt: card.expiresAt,
        message: card.message,
        senderName: hasRecipient && order ? order.customerName : null,
        recipient,
        orderId: card.sourceOrderId,
        orderNumber: order?.orderNumber ?? null,
    };
}

export interface GiftCardSentMessage {
    giftCardId: string;
    amountMinor: number;
    currencyCode: string;
    /** "s•••@example.com" / "01•••••678": the buyer sees where it went, never the full contact. */
    recipientMasked: string;
    buyer: { name: string | null; email: string | null; phone: string | null };
    orderId: string;
    orderNumber: number | null;
}

/**
 * The buyer's confirmation that a card they bought went to someone else
 * (`gift_card_sent`, no code). Null when the card has no recipient, did not
 * come from an order, or the buyer can't be reached.
 */
export async function resolveGiftCardSentMessage(
    db: Database,
    input: { giftCardId: string },
): Promise<GiftCardSentMessage | null> {
    const card = await db.select({
        id: giftCards.id,
        initialAmountMinor: giftCards.initialAmountMinor,
        currencyCode: giftCards.currencyCode,
        recipientEmail: giftCards.recipientEmail,
        recipientPhone: giftCards.recipientPhone,
        sourceOrderId: giftCards.sourceOrderId,
        source: giftCards.source,
    }).from(giftCards).where(eq(giftCards.id, input.giftCardId)).get();
    if (!card || card.source !== "purchase" || !card.sourceOrderId) return null;
    const recipientMasked = maskGiftCardRecipient({ email: card.recipientEmail, phone: card.recipientPhone });
    if (!recipientMasked) return null;
    const order = await db.select({
        orderNumber: orders.orderNumber,
        customerName: orders.customerName,
        customerEmail: orders.customerEmail,
        customerPhone: orders.customerPhone,
    }).from(orders).where(eq(orders.id, card.sourceOrderId)).get();
    if (!order || (!order.customerEmail && !order.customerPhone)) return null;
    return {
        giftCardId: card.id,
        amountMinor: card.initialAmountMinor,
        currencyCode: card.currencyCode,
        recipientMasked,
        buyer: { name: order.customerName, email: order.customerEmail, phone: order.customerPhone },
        orderId: card.sourceOrderId,
        orderNumber: order.orderNumber ?? null,
    };
}
