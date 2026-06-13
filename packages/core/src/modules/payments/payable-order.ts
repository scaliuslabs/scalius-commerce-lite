import { OrderStatus, PaymentStatus } from "@scalius/database/schema";

export interface PayableOrderState {
  status: string;
  paymentStatus: string;
  deletedAt?: unknown | null;
}

export const PAYMENT_BLOCKED_ORDER_STATUSES = [
  OrderStatus.CANCELLED,
  OrderStatus.RETURNED,
  OrderStatus.REFUNDED,
  OrderStatus.PARTIALLY_REFUNDED,
] as const;

export const PAYMENT_BLOCKED_PAYMENT_STATUSES = [
  PaymentStatus.PAID,
  PaymentStatus.REFUNDED,
] as const;

const BLOCKED_ORDER_STATUS_MESSAGES: Record<string, string> = {
  [OrderStatus.CANCELLED]: "Cannot pay a cancelled order",
  [OrderStatus.RETURNED]: "Cannot pay a returned order",
  [OrderStatus.REFUNDED]: "Cannot pay a refunded order",
  [OrderStatus.PARTIALLY_REFUNDED]: "Cannot pay a partially refunded order",
};

export function getUnpayableOrderReason(order: PayableOrderState): string | null {
  if (order.deletedAt != null) {
    return "Cannot pay a deleted order";
  }

  if (order.paymentStatus === PaymentStatus.PAID) {
    return "Order is already fully paid; payment requires manual reconciliation";
  }

  if (order.paymentStatus === PaymentStatus.REFUNDED) {
    return "Cannot pay an order whose payment has already been refunded";
  }

  return BLOCKED_ORDER_STATUS_MESSAGES[order.status] ?? null;
}

export function isOrderPayable(order: PayableOrderState): boolean {
  return getUnpayableOrderReason(order) === null;
}
