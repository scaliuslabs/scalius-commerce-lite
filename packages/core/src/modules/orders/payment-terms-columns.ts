// The terms columns of a deferred (net terms) order, shared by the storefront
// commit and staff/app orders (`@scalius/shared/payment-terms`, migration 0161).
import { sql, type SQL } from "drizzle-orm";
import { orders } from "@scalius/database/schema";
import { isPaymentTermsDays } from "@scalius/shared/payment-terms";
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
 * due, live and not closed. Leads with the partial index
 * `orders_payment_due_idx` (migration 0161). `nowSeconds` defaults to the
 * statement's own clock.
 */
export function overdueOrderCondition(nowSeconds?: number): SQL {
    const now = nowSeconds === undefined ? sql`unixepoch()` : sql`${Math.floor(nowSeconds)}`;
    return sql`(${orders.paymentDueAt} IS NOT NULL AND ${orders.deletedAt} IS NULL AND ${orders.balanceDueMinor} > 0
        AND ${orders.paymentDueAt} <= ${now}
        AND ${orders.status} NOT IN (${sql.join(CLOSED_ORDER_STATUSES.map((status) => sql`${status}`), sql`, `)}))`;
}
