import { and, asc, count, eq, inArray } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { giftCards, giftCardTransactions, orderPayments } from "@scalius/database/schema";
import type { LineExtrasInput } from "../../utils/line-extras";
import type { LineGiftCardExtra } from "./browser";
import { maskGiftCardContact } from "./mask";

const ITEM_ID_CHUNK = 90;

/**
 * Gift cards each order line issued, keyed by order item id (`extras.giftCards`).
 * Never a code: last 4, value and the masked delivery contact only. The caller
 * has already proven access to the order.
 */
export async function listLineIssuedCards(
    db: Database,
    input: LineExtrasInput,
): Promise<ReadonlyMap<string, readonly LineGiftCardExtra[]>> {
    const byItem = new Map<string, LineGiftCardExtra[]>();
    for (let index = 0; index < input.orderItemIds.length; index += ITEM_ID_CHUNK) {
        const chunk = input.orderItemIds.slice(index, index + ITEM_ID_CHUNK);
        const rows = await db.select({
            id: giftCards.id,
            orderItemId: giftCards.sourceOrderItemId,
            last4: giftCards.codeLast4,
            initialAmountMinor: giftCards.initialAmountMinor,
            currencyCode: giftCards.currencyCode,
            recipientEmail: giftCards.recipientEmail,
            recipientPhone: giftCards.recipientPhone,
        })
            .from(giftCards)
            .where(and(
                eq(giftCards.source, "purchase"),
                eq(giftCards.sourceOrderId, input.orderId),
                inArray(giftCards.sourceOrderItemId, chunk),
            ))
            .orderBy(asc(giftCards.sourceOrderItemId), asc(giftCards.sourceUnitIndex))
            .all();
        for (const row of rows) {
            if (!row.orderItemId) continue;
            const cards = byItem.get(row.orderItemId) ?? [];
            cards.push({
                giftCardId: row.id,
                last4: row.last4,
                initialAmountMinor: row.initialAmountMinor,
                currencyCode: row.currencyCode,
                sentTo: row.recipientEmail
                    ? maskGiftCardContact("email", row.recipientEmail)
                    : row.recipientPhone
                        ? maskGiftCardContact("phone", row.recipientPhone)
                        : null,
            });
            byItem.set(row.orderItemId, cards);
        }
    }
    return byItem;
}

/** Gift cards saved to the signed-in customer (the account "Gift cards" count). */
export async function countBuyerGiftCards(
    db: Database,
    customerId: string,
): Promise<number> {
    const row = await db.select({ value: count() }).from(giftCards).where(eq(giftCards.customerId, customerId)).get();
    return Number(row?.value ?? 0);
}

/**
 * The gift cards still paying for an order (succeeded tender rows, in commit
 * order): last 4 and amount only, for the receipt and the buyer's order page.
 * Released and refunded tenders are left out.
 */
export async function listOrderGiftCardTenders(
    db: Database,
    orderId: string,
): Promise<Array<{ last4: string; amountMinor: number }>> {
    const rows = await db.select({ last4: giftCards.codeLast4, amountMinor: orderPayments.amountMinor })
        .from(orderPayments)
        .innerJoin(giftCardTransactions, and(
            eq(giftCardTransactions.id, orderPayments.providerRef),
            eq(giftCardTransactions.kind, "redeem"),
        ))
        .innerJoin(giftCards, eq(giftCards.id, giftCardTransactions.giftCardId))
        .where(and(
            eq(orderPayments.orderId, orderId),
            eq(orderPayments.paymentMethod, "gift_card"),
            eq(orderPayments.status, "succeeded"),
        ))
        .orderBy(asc(orderPayments.createdAt), asc(orderPayments.id))
        .all();
    return rows;
}
