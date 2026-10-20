// The terms columns of a deferred (net terms) order, shared by the storefront
// commit and staff/app orders (`@scalius/shared/payment-terms`, migration 0161).
import { sql, type SQL } from "drizzle-orm";
import { orders } from "@scalius/database/schema";
import { isPaymentOverdue, isPaymentTermsDays } from "@scalius/shared/payment-terms";
import { ValidationError } from "../../errors";

/**
 * `payment_terms_days`, and `payment_due_at` = the insert's time + the terms,
 * written as SQL literals of a checked whole number of days, so they bind no
 * value; nothing at all for any other order.
 */
export function deferredOrderColumns(days: number | null | undefined) {
    if (days === null || days === undefined) return {};
    if (!isPaymentTermsDays(days)) throw new ValidationError("The order's payment terms are invalid.");
    return {
        paymentTermsDays: sql.raw(String(days)),
        paymentDueAt: sql.raw(`(unixepoch() + ${days * 86_400})`),
    } as unknown as { paymentTermsDays: number; paymentDueAt: Date };
}

/** The statuses an invoice is no longer collected in. */
const CLOSED_ORDER_STATUSES = ["cancelled", "refunded", "returned"] as const;

/**
 * Overdue invoices: deferred orders past their due date with money still
 * due, live and not closed. Read from the partial index
 * `orders_payment_due_idx` (migration 0163): the `deleted_at IS NULL`
 * equality leads it, the due date is its range, and the condition repeats
 * the index's own WHERE (`payment_due_at IS NOT NULL AND balance_due_minor > 0`)
 * term for term, which SQLite needs before it may use a partial index.
 * `nowSeconds` defaults to the statement's own clock.
 */
export function overdueOrderCondition(nowSeconds?: number): SQL {
    const now = nowSeconds === undefined ? sql`unixepoch()` : sql`${Math.floor(nowSeconds)}`;
    return sql`(${orders.deletedAt} IS NULL
        AND ${orders.paymentDueAt} IS NOT NULL AND ${orders.balanceDueMinor} > 0
        AND ${orders.paymentDueAt} <= ${now}
        AND ${orders.status} NOT IN (${sql.join(CLOSED_ORDER_STATUSES.map((status) => sql`${status}`), sql`, `)}))`;
}

/** An invoice's terms as the buyer sees them (receipt, account, emails); null when the order is not deferred. */
export interface BuyerPaymentTerms {
    kind: "net";
    days: number;
    /** ISO 8601. */
    dueAt: string;
    /** Past its due date with money still due. */
    overdue: boolean;
}

export function presentBuyerPaymentTerms(order: {
    paymentTermsDays: number | null;
    paymentDueAt: Date | null;
    balanceDueMinor: number;
}, now: Date = new Date()): BuyerPaymentTerms | null {
    if (order.paymentTermsDays === null || !order.paymentDueAt) return null;
    return {
        kind: "net",
        days: order.paymentTermsDays,
        dueAt: order.paymentDueAt.toISOString(),
        overdue: isPaymentOverdue({ paymentDueAt: order.paymentDueAt, balanceDueMinor: order.balanceDueMinor }, now),
    };
}
