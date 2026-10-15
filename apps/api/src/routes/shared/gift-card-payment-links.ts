import type { Database } from "@scalius/database/client";
import { giftCards, giftCardTransactions, refundAttempts } from "@scalius/database/schema";
import { and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { GIFT_CARD_PAYMENT_METHOD } from "@scalius/core/modules/gift-cards";

type GiftCardPaymentLink = { id: string; last4: string; storeCredit: boolean };

/**
 * The gift card behind each payment row: a tender and a refund back to its
 * card name their row in the ledger; a store-credit card names its refund
 * attempt, and every row of that refund group points to it. Two bounded
 * reads, run only when the order has such rows.
 */
export async function listGiftCardPaymentLinks(
    db: Database,
    orderId: string,
    rows: ReadonlyArray<{ paymentMethod: string; paymentType: string }>,
): Promise<Map<string, GiftCardPaymentLink>> {
    const links = new Map<string, GiftCardPaymentLink>();
    if (rows.some((row) => row.paymentMethod === GIFT_CARD_PAYMENT_METHOD)) {
        const ledger = await db.select({
            orderPaymentId: giftCardTransactions.orderPaymentId,
            giftCardId: giftCards.id,
            last4: giftCards.codeLast4,
        })
            .from(giftCardTransactions)
            .innerJoin(giftCards, eq(giftCards.id, giftCardTransactions.giftCardId))
            .where(and(
                eq(giftCardTransactions.orderId, orderId),
                inArray(giftCardTransactions.kind, ["redeem", "refund"]),
            ))
            .all();
        for (const row of ledger) {
            if (row.orderPaymentId) links.set(row.orderPaymentId, { id: row.giftCardId, last4: row.last4, storeCredit: false });
        }
    }
    if (rows.some((row) => row.paymentType === "refund")) {
        const creditAttempt = alias(refundAttempts, "credit_attempt");
        const credits = await db.select({
            refundPaymentId: refundAttempts.refundPaymentId,
            giftCardId: giftCards.id,
            last4: giftCards.codeLast4,
        })
            .from(giftCards)
            .innerJoin(creditAttempt, eq(creditAttempt.id, giftCards.sourceRefundAttemptId))
            .innerJoin(refundAttempts, eq(refundAttempts.refundGroupId, creditAttempt.refundGroupId))
            .where(and(eq(giftCards.sourceOrderId, orderId), eq(giftCards.source, "refund")))
            .all();
        for (const row of credits) {
            links.set(row.refundPaymentId, { id: row.giftCardId, last4: row.last4, storeCredit: true });
        }
    }
    return links;
}
