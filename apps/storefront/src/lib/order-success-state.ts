import type { OrderItem, OrderReceipt } from "./api/types";

const ONLINE_PAYMENT_METHODS = new Set(["stripe", "sslcommerz", "polar"]);
const NON_FINAL_ORDER_STATUSES = new Set(["incomplete"]);
const FAILED_ORDER_STATUSES = new Set([
  "cancelled",
  "failed",
  "refunded",
  "returned",
  "partially_refunded",
]);
const ACCEPTED_PAYMENT_STATUSES = new Set(["paid", "partial"]);
const FAILED_PAYMENT_STATUSES = new Set(["failed", "refunded"]);

export type OrderSuccessStateKind =
  | "order_placed"
  | "payment_pending"
  | "payment_issue";

export interface OrderSuccessViewState {
  kind: OrderSuccessStateKind;
  shouldFinalizeClientSide: boolean;
  title: string;
  message: string;
  orderStatusLabel: string;
  paymentStatusLabel: string;
  badgeClass: string;
}

export interface PurchaseTrackingPayload {
  order: {
    id: string;
    totalAmount: number;
  };
  items: Array<{
    productId: string;
    variantId: string | null;
    quantity: number;
    price: number;
  }>;
}

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function isOnlinePaymentMethod(paymentMethod: string | null | undefined): boolean {
  return ONLINE_PAYMENT_METHODS.has(normalize(paymentMethod));
}

function isAcceptedPayment(order: Pick<OrderReceipt, "paymentStatus" | "paidAmount">): boolean {
  const paymentStatus = normalize(order.paymentStatus);
  if (ACCEPTED_PAYMENT_STATUSES.has(paymentStatus)) return true;
  return Number(order.paidAmount ?? 0) > 0 && !FAILED_PAYMENT_STATUSES.has(paymentStatus);
}

export function getOrderSuccessStateKind(
  order: Pick<
    OrderReceipt,
    "status" | "paymentMethod" | "paymentStatus" | "paidAmount"
  >,
): OrderSuccessStateKind {
  const orderStatus = normalize(order.status);
  const paymentStatus = normalize(order.paymentStatus);

  if (FAILED_ORDER_STATUSES.has(orderStatus) || FAILED_PAYMENT_STATUSES.has(paymentStatus)) {
    return "payment_issue";
  }

  if (!isOnlinePaymentMethod(order.paymentMethod)) {
    return NON_FINAL_ORDER_STATUSES.has(orderStatus) ? "payment_pending" : "order_placed";
  }

  if (NON_FINAL_ORDER_STATUSES.has(orderStatus) || !isAcceptedPayment(order)) {
    return "payment_pending";
  }

  return "order_placed";
}

export function formatOrderSuccessLabel(value: string | null | undefined): string {
  const normalized = normalize(value);
  if (!normalized) return "Not available";
  return normalized
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getOrderSuccessViewState(order: OrderReceipt): OrderSuccessViewState {
  const kind = getOrderSuccessStateKind(order);
  if (kind === "payment_issue") {
    return {
      kind,
      shouldFinalizeClientSide: false,
      title: "Payment Needs Attention",
      message:
        `We found your order #${order.id}, but the payment is not complete. Please retry payment from this receipt when available or contact the store before placing the same order again.`,
      orderStatusLabel: formatOrderSuccessLabel(order.status),
      paymentStatusLabel: formatOrderSuccessLabel(order.paymentStatus),
      badgeClass: "bg-destructive/10 text-destructive",
    };
  }

  if (kind === "payment_pending") {
    return {
      kind,
      shouldFinalizeClientSide: false,
      title: "Payment Confirmation Pending",
      message:
        `We received order #${order.id} and are waiting for the payment gateway to confirm it. Please avoid placing the same order again while this updates.`,
      orderStatusLabel: "Payment pending",
      paymentStatusLabel: formatOrderSuccessLabel(order.paymentStatus),
      badgeClass: "bg-amber-100 text-amber-800",
    };
  }

  return {
    kind,
    shouldFinalizeClientSide: true,
    title: "Order Placed Successfully!",
    message: `Thank you for your order, #${order.id}. We'll start processing it right away.`,
    orderStatusLabel: formatOrderSuccessLabel(
      order.status === "incomplete" ? "processing" : order.status,
    ),
    paymentStatusLabel: formatOrderSuccessLabel(order.paymentStatus),
    badgeClass: "bg-primary/20 text-primary",
  };
}

export function createPurchaseTrackingPayload(
  order: Pick<OrderReceipt, "id" | "totalAmount">,
  items: OrderItem[],
): PurchaseTrackingPayload {
  return {
    order: {
      id: order.id,
      totalAmount: order.totalAmount,
    },
    items: items.map((item) => ({
      productId: item.productId,
      variantId: item.variantId,
      quantity: item.quantity,
      price: item.price,
    })),
  };
}
