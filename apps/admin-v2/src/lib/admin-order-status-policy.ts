import { GENERIC_ADMIN_ORDER_STATUS_TRANSITIONS, orderHoldsNoMoney, orderMoneyDue } from "@scalius/shared/order-admin-actions";

export const OrderStatus = {
  PENDING: "pending",
  PROCESSING: "processing",
  CONFIRMED: "confirmed",
  SHIPPED: "shipped",
  DELIVERED: "delivered",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  REFUNDED: "refunded",
  RETURNED: "returned",
  INCOMPLETE: "incomplete",
} as const;

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

/**
 * The status menu's moves and money rules are the server's own
 * (@scalius/shared/order-admin-actions): the menu shows exactly what the
 * server accepts, with the reason for what it refuses.
 */
const ADMIN_STATUS_TRANSITIONS = GENERIC_ADMIN_ORDER_STATUS_TRANSITIONS;

export const WORKFLOW_OWNED_ORDER_STATUSES = new Set([
  "returned",
  "refunded",
]);

export interface AdminOrderPaymentState {
  paymentStatus?: string | null;
  paidAmount?: number | null;
  /** What banks took back in disputes: an order whose whole payment was lost holds nothing to refund. */
  disputedAmount?: number | null;
}

export function getAdminOrderCancellationBlockedReason(
  status: string,
  payment: AdminOrderPaymentState | undefined,
): string | null {
  const normalized = status.toLowerCase();
  if (!isAdminOrderStatus(normalized)) {
    return null;
  }
  if (!(ADMIN_STATUS_TRANSITIONS[normalized] ?? []).includes("cancelled")) {
    return null;
  }

  // An unknown paid amount is never read as nothing paid.
  if (typeof payment?.paidAmount === "number"
    && orderHoldsNoMoney({ paymentStatus: payment.paymentStatus, paid: payment.paidAmount, disputed: payment.disputedAmount })) {
    return null;
  }

  return "Paid or payment-uncertain orders must use the refund workflow before cancellation.";
}

export function isAdminOrderStatus(status: string): status is OrderStatus {
  return Object.values(OrderStatus).includes(status as OrderStatus);
}

/** What the order knows that decides whether a next status can be chosen. */
export interface AdminOrderStatusFacts extends AdminOrderPaymentState {
  paymentMethod?: string | null;
  balanceDue?: number | null;
  totalAmount?: number | null;
  /** Units handed to a courier; unknown on list rows, which only know the fulfillment state. */
  unitsWithCourier?: number | null;
  fulfillmentStatus?: string | null;
}

/**
 * Why a next status is shown but can't be chosen, as a stable code each
 * screen words itself. Mirrors the server's refusals, so the merchant reads
 * the reason in the menu instead of an error after choosing it.
 */
export type AdminOrderStatusBlock =
  | { code: "cancel_needs_refund" }
  | { code: "with_courier"; units: number | null }
  | { code: "cash_not_collected" }
  | { code: "money_due" };

export function getAdminOrderStatusBlock(
  status: string,
  next: string,
  facts: AdminOrderStatusFacts = {},
): AdminOrderStatusBlock | null {
  if (next === "cancelled") {
    const units = facts.unitsWithCourier ?? null;
    const partlySent = units === null && ["partial", "complete"].includes(facts.fulfillmentStatus ?? "");
    if ((units ?? 0) > 0 || partlySent) return { code: "with_courier", units: units && units > 0 ? units : null };
    if (getAdminOrderCancellationBlockedReason(status, facts)) return { code: "cancel_needs_refund" };
  }
  if (next === "completed") {
    const due = adminOrderMoneyDue(facts);
    if (due) return { code: due === "cash_not_collected" ? "cash_not_collected" : "money_due" };
  }
  return null;
}

/** The server's money-due rule over the dashboard's order facts. */
export function adminOrderMoneyDue(facts: AdminOrderStatusFacts) {
  return orderMoneyDue({
    paymentStatus: facts.paymentStatus,
    paid: facts.paidAmount ?? null,
    total: facts.totalAmount ?? null,
    balanceDue: facts.balanceDue ?? null,
    paymentMethod: facts.paymentMethod ?? null,
  });
}

/** Every next status the status menu shows, each with why it can't be chosen (if it can't). */
export function getAdminOrderStatusOptions(
  status: string,
  facts: AdminOrderStatusFacts = {},
): Array<{ status: OrderStatus; block: AdminOrderStatusBlock | null }> {
  const normalized = status.toLowerCase();
  if (!isAdminOrderStatus(normalized)) return [];
  return (ADMIN_STATUS_TRANSITIONS[normalized] ?? [])
    .filter((candidate) => !WORKFLOW_OWNED_ORDER_STATUSES.has(candidate))
    .map((candidate) => ({ status: candidate, block: getAdminOrderStatusBlock(normalized, candidate, facts) }));
}

export function getAdminOrderStatusTransitions(
  status: string,
  payment?: AdminOrderPaymentState,
): OrderStatus[] {
  const normalized = status.toLowerCase();
  if (!isAdminOrderStatus(normalized)) return [];
  return [...(ADMIN_STATUS_TRANSITIONS[normalized] ?? [])].filter(
    (candidate) => !WORKFLOW_OWNED_ORDER_STATUSES.has(candidate)
      && (
        candidate !== "cancelled"
        || getAdminOrderCancellationBlockedReason(normalized, payment) === null
      ),
  );
}
