// What an order's money says about cancelling it: the payment rows hold no
// money and nothing is still being processed, or the money is gift-card
// tender only, which cancelling gives back. The status command and the
// order reads (its listed actions) ask the same questions.
import type { Database } from "@scalius/database/client";
import { orderPayments, orders, PaymentRecordStatus, PaymentStatus } from "@scalius/database/schema";
import { eq, sql, type SQL } from "drizzle-orm";
import { inJsonArray } from "../../../utils/in-json-array";
import { GIFT_CARD_PAYMENT_METHOD, listHeldGiftCardTenders, type HeldGiftCardTender } from "../../gift-cards";
import { paymentLedgerTotalsSql } from "../../payments";
import { qualifiedColumn } from "../../../utils/qualified-column";

/**
 * Historical captures remain succeeded after a refund; only their net money
 * or an unfinished payment blocks cancellation. Net money is what was
 * received, less what went back, less what banks withdrew in disputes (the
 * store holds none of it, so there is nothing to refund).
 */
export function cancellationPaymentRecordsSafeCondition(orderId: string | SQL): SQL {
    return sql`
        NOT EXISTS (
            SELECT 1 FROM ${orderPayments}
            WHERE ${orderPayments.orderId} = ${orderId}
              AND ${orderPayments.status} IN (
                  ${PaymentRecordStatus.PENDING},
                  ${PaymentRecordStatus.CONFIRMED}, ${PaymentRecordStatus.AUTHORIZED}
              )
        )
        AND (SELECT coalesce(sum(CASE
            WHEN ${orderPayments.paymentType} <> 'refund' AND ${orderPayments.status} = ${PaymentRecordStatus.SUCCEEDED}
              THEN ${orderPayments.amountMinor}
            WHEN ${orderPayments.paymentType} = 'refund' AND ${orderPayments.status} = ${PaymentRecordStatus.REFUNDED}
              THEN -${orderPayments.amountMinor}
            ELSE 0 END), 0)
            FROM ${orderPayments} WHERE ${orderPayments.orderId} = ${orderId})
          - ${paymentLedgerTotalsSql(orderId as string).withdrawnMinor} = 0
    `;
}


/**
 * The money on the order is gift-card tender only (no gateway or cash was
 * taken, and nothing else is pending): the held tenders, which cancelling
 * gives back. Null when the order has no gift-card money, or other money too
 * (that goes through the refund flow first).
 */
export async function giftCardOnlyTenders(
    db: Database,
    orderId: string,
    payment: { paymentStatus: string; paidAmountMinor: number },
): Promise<HeldGiftCardTender[] | null> {
    if (payment.paidAmountMinor <= 0) return null;
    if (payment.paymentStatus !== PaymentStatus.PAID && payment.paymentStatus !== PaymentStatus.PARTIAL) return null;
    // One read: the succeeded gift-card tender, and any other money in flight or taken.
    const money = await db
        .select({
            giftCardMinor: sql<number>`coalesce(sum(CASE
                WHEN ${orderPayments.paymentMethod} = ${GIFT_CARD_PAYMENT_METHOD}
                 AND ${orderPayments.status} = ${PaymentRecordStatus.SUCCEEDED}
                THEN ${orderPayments.amountMinor} ELSE 0 END), 0)`,
            otherRows: sql<number>`coalesce(sum(CASE
                WHEN ${orderPayments.paymentMethod} <> ${GIFT_CARD_PAYMENT_METHOD}
                 AND ${orderPayments.status} IN (
                     ${PaymentRecordStatus.PENDING},
                     ${PaymentRecordStatus.CONFIRMED}, ${PaymentRecordStatus.AUTHORIZED},
                     ${PaymentRecordStatus.SUCCEEDED}
                 )
                THEN 1 ELSE 0 END), 0)`,
        })
        .from(orderPayments)
        .where(eq(orderPayments.orderId, orderId))
        .get();
    if (!money || Number(money.otherRows) > 0 || Number(money.giftCardMinor) !== payment.paidAmountMinor) return null;
    const tenders = await listHeldGiftCardTenders(db, orderId);
    const heldMinor = tenders.reduce((total, tender) => total + tender.amountMinor, 0);
    return heldMinor === payment.paidAmountMinor ? tenders : null;
}


/** Per order: whether its payment rows are settled for a cancel, and whether its money is gift-card tender only. */
export async function readCancelMoneyFacts(
    db: Database,
    rows: ReadonlyArray<{ id: string; paymentStatus: string; paidAmountMinor: number }>,
): Promise<Map<string, { paymentRecordsSettled: boolean; giftCardOnly: boolean }>> {
    const facts = new Map<string, { paymentRecordsSettled: boolean; giftCardOnly: boolean }>();
    if (rows.length === 0) return facts;
    // A column, not a value: each row's own payments.
    const outer = qualifiedColumn(orders.id);
    const money = (expression: SQL) => sql<number>`(SELECT coalesce(sum(${expression}), 0) FROM ${orderPayments} WHERE ${orderPayments.orderId} = ${outer})`;
    const read = await db.select({
        id: orders.id,
        settled: sql<number>`CASE WHEN ${cancellationPaymentRecordsSafeCondition(outer)} THEN 1 ELSE 0 END`,
        giftCardMinor: money(sql`CASE WHEN ${orderPayments.paymentMethod} = ${GIFT_CARD_PAYMENT_METHOD}
            AND ${orderPayments.status} = ${PaymentRecordStatus.SUCCEEDED} THEN ${orderPayments.amountMinor} ELSE 0 END`),
        otherRows: money(sql`CASE WHEN ${orderPayments.paymentMethod} <> ${GIFT_CARD_PAYMENT_METHOD}
            AND ${orderPayments.status} IN (${PaymentRecordStatus.PENDING}, ${PaymentRecordStatus.CONFIRMED},
                ${PaymentRecordStatus.AUTHORIZED}, ${PaymentRecordStatus.SUCCEEDED}) THEN 1 ELSE 0 END`),
    }).from(orders).where(inJsonArray(orders.id, rows.map((row) => row.id))).all();
    const byId = new Map(read.map((row) => [row.id, row]));
    await Promise.all(rows.map(async (row) => {
        const money = byId.get(row.id);
        // Gift-card money is rare: only an order the first read says could hold nothing else is asked again,
        // by the cancel's own check (its tenders must cover the paid amount).
        const candidate = money !== undefined && row.paidAmountMinor > 0
            && Number(money.giftCardMinor) === row.paidAmountMinor && Number(money.otherRows) === 0;
        const giftCardOnly = candidate && (await giftCardOnlyTenders(db, row.id, row)) !== null;
        facts.set(row.id, { paymentRecordsSettled: Number(money?.settled) === 1, giftCardOnly });
    }));
    return facts;
}
