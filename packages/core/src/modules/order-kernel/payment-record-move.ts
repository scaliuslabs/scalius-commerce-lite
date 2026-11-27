// The one way a payment record's status changes (`order_payments.status`): the
// update of a move of its kind's machine (@scalius/shared/payment-record-state)
// over the records `where` selects that are of that kind and still in one of
// the move's source states. A provider event that lost a race to another, or
// one a record's state refuses, changes nothing. state-writers.test.ts holds
// every writer to it.
import { and, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { orderPayments } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import {
    PAYMENT_MACHINE,
    REFUND_RECORD_MACHINE,
    type PaymentMove,
    type RefundRecordMove,
} from "@scalius/shared/payment-record-state";

type PaymentColumns = typeof orderPayments.$inferInsert;
type PaymentExtra = { [K in Exclude<keyof PaymentColumns, "status" | "id">]?: PaymentColumns[K] | SQL };

/** A refund record's `type`; every other type is a charge. */
const REFUND_TYPE = "refund";

/** The update of a charge by `move` over the charges `where` selects. `updatedAt` is now unless the caller sets it. */
export function paymentMove(db: Database, move: PaymentMove, where: SQL | undefined, extra: PaymentExtra = {}) {
    const { from, to } = PAYMENT_MACHINE.moves[move];
    return db.update(orderPayments).set({ updatedAt: sql`unixepoch()`, ...extra, status: to }).where(and(
        ne(orderPayments.paymentType, REFUND_TYPE),
        inArray(orderPayments.status, [...from]),
        where,
    ));
}

/** The update of a refund record by `move` over the refund records `where` selects. `updatedAt` is now unless the caller sets it. */
export function refundRecordMove(db: Database, move: RefundRecordMove, where: SQL | undefined, extra: PaymentExtra = {}) {
    const { from, to } = REFUND_RECORD_MACHINE.moves[move];
    return db.update(orderPayments).set({ updatedAt: sql`unixepoch()`, ...extra, status: to }).where(and(
        eq(orderPayments.paymentType, REFUND_TYPE),
        inArray(orderPayments.status, [...from]),
        where,
    ));
}
