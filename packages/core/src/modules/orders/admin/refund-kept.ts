// "Keep the rest": money staff decided to give back and then kept stops
// showing as owed. What was kept is a timeline entry (`refund_kept`,
// data.amountMinor) that the order's refund-owed fact subtracts, so the
// decision and its amount stay on the record. Two kinds of owed money: a
// return refunded only in part (a restocking fee kept), and a refund that
// ended without all its money going back (`failedRefundOwedSql`).
import { orderEventData } from "../../../utils/agent-attribution";
import { eq, sql, type SQL } from "drizzle-orm";
import { codTracking, orderEvents, orderRefunds, orders, refundAttempts } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { fromMinor } from "@scalius/shared/money";
import { NotFoundError, ValidationError } from "@scalius/core/errors";
import { knownStaffId, orderEventIdForRequest } from "../timeline";
import { orderListFactsSelection, presentOrderListFacts } from "./shared";

export interface KeepOwedRefundResult {
    keptMinor: number;
    /** True when this exact state was already kept (a double click or retry). */
    replayed: boolean;
}

/**
 * What the order's latest refund (`order_refunds`, by `created_at`) did not
 * give back when it ended `failed` or `partial` and staff have not kept the
 * money since (no `refund_kept` entry at or after it): its amount less its
 * attempts that went back; 0 otherwise. Read through
 * `order_refunds_order_created_idx` and the attempts' refund group index (a
 * status predicate there would walk every refunded attempt).
 */
export function failedRefundOwedSql(orderIdColumn: SQL): SQL<number> {
    return sql<number>`coalesce((
        SELECT latest.amount_minor - coalesce((
            SELECT sum(CASE WHEN ${refundAttempts.status} = 'refunded' THEN ${refundAttempts.amountMinor} ELSE 0 END) FROM ${refundAttempts}
            WHERE ${refundAttempts.refundGroupId} = latest.id
        ), 0)
        FROM ${orderRefunds} AS latest
        WHERE latest.order_id = ${orderIdColumn} AND latest.status IN ('failed', 'partial')
          AND NOT EXISTS (SELECT 1 FROM ${orderRefunds} AS later WHERE later.order_id = latest.order_id
            AND (later.created_at > latest.created_at OR (later.created_at = latest.created_at AND later.id > latest.id)))
          AND NOT EXISTS (SELECT 1 FROM ${orderEvents} WHERE ${orderEvents.orderId} = latest.order_id
            AND ${orderEvents.kind} = 'refund_kept' AND ${orderEvents.createdAt} >= latest.created_at)
    ), 0)`.mapWith(Number);
}

/** Keeps the whole refund owed on an order now; refused when nothing is owed. */
export async function keepOwedRefund(db: Database, orderId: string, actorId: string | null): Promise<KeepOwedRefundResult> {
    const order = await db.select({
        ...orderListFactsSelection(),
        paymentMethod: orders.paymentMethod,
        paidAmountMinor: orders.paidAmountMinor,
        disputedMinor: orders.disputedMinor,
        currencyDecimalPlaces: orders.currencyDecimalPlaces,
        deletedAt: orders.deletedAt,
        failedRefundOwedMinor: failedRefundOwedSql(sql`${orders.id}`),
    }).from(orders)
        .leftJoin(codTracking, eq(codTracking.orderId, orders.id))
        .where(eq(orders.id, orderId))
        .get();
    if (!order || order.deletedAt) throw new NotFoundError("Order not found");
    const facts = presentOrderListFacts(order);
    const returnOwedMinor = Math.round(facts.refundDue * 10 ** order.currencyDecimalPlaces);
    // A refund that failed is owed only while the store still holds that money.
    const failedOwedMinor = Math.min(Math.max(0, Number(order.failedRefundOwedMinor) || 0), Math.max(0, order.paidAmountMinor - order.disputedMinor));
    const owedMinor = Math.max(returnOwedMinor, failedOwedMinor);
    // The same state (refunded and kept so far) names the same entry: a retry keeps nothing twice.
    const key = `refund-kept:${Number(order.refundedMinor) || 0}:${Number(order.keptMinor) || 0}`;
    const id = await orderEventIdForRequest(orderId, "refund_kept", key);
    if (owedMinor <= 0) {
        const existing = await db.select({ data: orderEvents.data }).from(orderEvents).where(eq(orderEvents.id, id)).get();
        if (existing) return { keptMinor: 0, replayed: true };
        throw new ValidationError("This order has no refund owed.");
    }
    await db.insert(orderEvents).values({
        id,
        orderId,
        kind: "refund_kept",
        data: orderEventData({ amount: fromMinor(owedMinor, order.currencyDecimalPlaces), amountMinor: owedMinor }),
        actorId: knownStaffId(actorId),
        createdAt: sql`unixepoch()`,
    }).onConflictDoNothing({ target: orderEvents.id });
    return { keptMinor: owedMinor, replayed: false };
}
