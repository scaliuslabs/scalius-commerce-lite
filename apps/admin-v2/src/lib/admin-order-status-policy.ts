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

const ADMIN_STATUS_TRANSITIONS: Readonly<Partial<Record<OrderStatus, readonly OrderStatus[]>>> = {
  incomplete: ["pending", "cancelled"],
  pending: ["processing", "confirmed", "cancelled"],
  processing: ["confirmed", "cancelled"],
  confirmed: ["shipped", "cancelled"],
  shipped: ["delivered"],
  delivered: ["completed"],
  completed: [],
  cancelled: [],
  returned: [],
  refunded: [],
};

export const WORKFLOW_OWNED_ORDER_STATUSES = new Set([
  "returned",
  "refunded",
]);

export interface AdminOrderPaymentState {
  paymentStatus?: string | null;
  paidAmount?: number | null;
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

  const paymentStatus = payment?.paymentStatus?.trim().toLowerCase();
  const paidAmount = payment?.paidAmount;
  if (
    (paymentStatus === "unpaid" || paymentStatus === "failed")
    && paidAmount === 0
  ) {
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
  if (next === "delivered" || next === "completed") {
    const settled = ["paid", "partially_refunded"].includes(facts.paymentStatus ?? "") && !((facts.balanceDue ?? 0) > 0);
    if (!settled) return { code: facts.paymentMethod === "cod" ? "cash_not_collected" : "money_due" };
  }
  return null;
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
