// "Keep the rest": a return refunded only in part (a restocking fee kept)
// stops showing a refund owed. What was kept is a timeline entry
// (`refund_kept`, data.amountMinor) that the order's refund-owed fact
// subtracts, so the decision and its amount stay on the record.
import { eq, sql } from "drizzle-orm";
import { codTracking, orderEvents, orders } from "@scalius/database/schema";
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

/** Keeps the whole refund owed on an order now; refused when nothing is owed. */
export async function keepOwedRefund(db: Database, orderId: string, actorId: string | null): Promise<KeepOwedRefundResult> {
    const order = await db.select({
        ...orderListFactsSelection(),
        paymentMethod: orders.paymentMethod,
        paidAmountMinor: orders.paidAmountMinor,
        currencyDecimalPlaces: orders.currencyDecimalPlaces,
        deletedAt: orders.deletedAt,
    }).from(orders)
        .leftJoin(codTracking, eq(codTracking.orderId, orders.id))
        .where(eq(orders.id, orderId))
        .get();
    if (!order || order.deletedAt) throw new NotFoundError("Order not found");
    const facts = presentOrderListFacts(order);
    const owedMinor = Math.round(facts.refundDue * 10 ** order.currencyDecimalPlaces);
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
        data: JSON.stringify({ amount: fromMinor(owedMinor, order.currencyDecimalPlaces), amountMinor: owedMinor }),
        actorId: knownStaffId(actorId),
        createdAt: sql`unixepoch()`,
    }).onConflictDoNothing({ target: orderEvents.id });
    return { keptMinor: owedMinor, replayed: false };
}
