import type { OrderStatusValue } from "./order-state";

/**
 * What staff may do to an order, decided once for the server (which refuses)
 * and the dashboard (which shows the action, or why it can't be chosen), so
 * the two never disagree. Amounts are in one unit per call (the server passes
 * minor units, the dashboard the API's amounts).
 */

/**
 * The status menu's moves: only changes without side effects. Shipped,
 * delivered and returned are fulfilment facts (Mark as sent / Book courier,
 * cash collected / Mark delivered, Mark returned record what moved and move the
 * stock with it); returns and refunds are workflow-owned. A Shipped order with
 * nothing actually sent may still be cancelled; the cancel path refuses while
 * any unit is with the courier.
 */
export const GENERIC_ADMIN_ORDER_STATUS_TRANSITIONS: Readonly<Record<OrderStatusValue, readonly OrderStatusValue[]>> = {
  incomplete: ["pending", "cancelled"],
  pending: ["confirmed", "cancelled"],
  processing: ["confirmed", "cancelled"],
  confirmed: ["cancelled"],
  shipped: ["cancelled"],
  delivered: ["completed"],
  completed: [],
  cancelled: [],
  returned: [],
  refunded: [],
};

export function isGenericAdminOrderStatusTransitionAllowed(current: string, next: string): boolean {
  return current === next || (GENERIC_ADMIN_ORDER_STATUS_TRANSITIONS[current as OrderStatusValue] ?? []).includes(next as OrderStatusValue);
}

/** The order's money as both sides read it. */
export interface OrderMoneyFacts {
  paymentStatus?: string | null;
  /** What the buyer paid, net of refunds (`paid_amount_minor`). */
  paid?: number | null;
  /** What banks withdrew in disputes and kept (`disputed_minor`): the store's loss, never owed by the buyer. */
  disputed?: number | null;
  total?: number | null;
  balanceDue?: number | null;
  paymentMethod?: string | null;
  /** Recorded invoice terms (days); null or missing: none. */
  paymentTermsDays?: number | null;
}

/** What the store still holds of the buyer's money: paid, less what disputes took. */
export function orderHeldAmount(facts: OrderMoneyFacts): number {
  return Math.max(0, (facts.paid ?? 0) - (facts.disputed ?? 0));
}

/**
 * The order holds no money, so cancelling it needs no refund: nothing was
 * paid, or a bank took back all of it in disputes. Anything else is refunded
 * first (gift-card-only money, which cancelling gives back, is the server's
 * one other case: it needs the payment rows).
 */
export function orderHoldsNoMoney(facts: OrderMoneyFacts): boolean {
  const status = (facts.paymentStatus ?? "").trim().toLowerCase();
  const paid = facts.paid ?? 0;
  const disputed = facts.disputed ?? 0;
  if ((status === "unpaid" || status === "failed") && paid === 0) return true;
  return disputed > 0 && paid === disputed;
}

/** Why an order can't be marked delivered or completed yet: money is still due. */
export type OrderMoneyDue = "cash_not_collected" | "invoice_payment" | "rest_of_payment" | "money_due";

/**
 * Money still due before delivered or completed can be recorded, or null.
 * A partly refunded order was paid in full: its net paid amount is below the
 * total because money went back, not because any is owed.
 */
export function orderMoneyDue(facts: OrderMoneyFacts): OrderMoneyDue | null {
  const status = (facts.paymentStatus ?? "").trim().toLowerCase();
  const partlyRefunded = status === "partially_refunded";
  const due = (facts.balanceDue ?? 0) > 0 || (!partlyRefunded && (facts.total ?? 0) > (facts.paid ?? 0));
  const settled = status === "paid" || partlyRefunded;
  if (!due && settled) return null;
  if (facts.paymentMethod === "cod") return "cash_not_collected";
  if (typeof facts.paymentTermsDays === "number") return "invoice_payment";
  if (status === "partial") return "rest_of_payment";
  return "money_due";
}
