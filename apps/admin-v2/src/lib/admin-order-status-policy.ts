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
  PARTIALLY_REFUNDED: "partially_refunded",
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
  partially_refunded: [],
};

export const WORKFLOW_OWNED_ORDER_STATUSES = new Set([
  "returned",
  "refunded",
  "partially_refunded",
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
