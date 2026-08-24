import type { OrderItem, OrderReceipt } from "./api/types";

const ONLINE_PAYMENT_METHODS = new Set(["stripe", "sslcommerz", "polar"]);
const NON_FINAL_ORDER_STATUSES = new Set(["incomplete"]);
const PAYMENT_ISSUE_ORDER_STATUSES = new Set([
  "failed",
]);
const ACTIVE_UPDATED_ORDER_STATUSES = new Set([
  "confirmed",
  "processing",
  "shipped",
  "delivered",
  "completed",
]);
const CLOSED_ORDER_STATUSES = new Set([
  "cancelled",
  "refunded",
  "returned",
  "partially_refunded",
]);
const ACCEPTED_PAYMENT_STATUSES = new Set(["paid", "partial"]);
const FAILED_PAYMENT_STATUSES = new Set(["failed"]);
const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cod: "Cash on Delivery",
  polar: "Polar",
  sslcommerz: "SSLCommerz",
  stripe: "Stripe",
};

export type OrderSuccessStateKind =
  | "order_placed"
  | "order_updated"
  | "payment_pending"
  | "payment_issue";

export interface OrderSuccessViewState {
  kind: OrderSuccessStateKind;
  shouldFinalizeClientSide: boolean;
  title: string;
  message: string;
  orderStatusLabel: string;
  paymentStatusLabel: string;
  orderBadgeClass: string;
  paymentBadgeClass: string;
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

  if (
    CLOSED_ORDER_STATUSES.has(orderStatus)
    || paymentStatus === "refunded"
  ) {
    return "order_updated";
  }

  if (
    PAYMENT_ISSUE_ORDER_STATUSES.has(orderStatus)
    || FAILED_PAYMENT_STATUSES.has(paymentStatus)
  ) {
    return "payment_issue";
  }

  if (!isOnlinePaymentMethod(order.paymentMethod)) {
    if (NON_FINAL_ORDER_STATUSES.has(orderStatus)) return "payment_pending";
    return ACTIVE_UPDATED_ORDER_STATUSES.has(orderStatus) ? "order_updated" : "order_placed";
  }

  if (NON_FINAL_ORDER_STATUSES.has(orderStatus) || !isAcceptedPayment(order)) {
    return "payment_pending";
  }

  if (ACTIVE_UPDATED_ORDER_STATUSES.has(orderStatus)) return "order_updated";

  return "order_placed";
}

export function formatOrderSuccessLabel(value: string | null | undefined): string {
  const normalized = normalize(value);
  if (!normalized) return "Not available";
  const knownPaymentMethod = PAYMENT_METHOD_LABELS[normalized];
  if (knownPaymentMethod) return knownPaymentMethod;
  return normalized
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function formatOrderSuccessPaymentMethod(value: string | null | undefined): string {
  switch (normalize(value)) {
    case "cod":
      return "Cash on delivery";
    case "stripe":
      return "Card (Stripe)";
    case "sslcommerz":
      return "Online payment (SSLCommerz)";
    case "polar":
      return "Online payment (Polar)";
    default:
      return formatOrderSuccessLabel(value);
  }
}

export function getOrderSuccessVisibleBalanceDue(
  order: Pick<OrderReceipt, "status" | "paymentStatus" | "totalAmount" | "paidAmount" | "balanceDue">,
): number {
  const orderStatus = normalize(order.status);
  const paymentStatus = normalize(order.paymentStatus);
  if (CLOSED_ORDER_STATUSES.has(orderStatus) || paymentStatus === "refunded") return 0;

  const storedBalance = Number(order.balanceDue);
  if (Number.isFinite(storedBalance)) return Math.max(0, storedBalance);
  return Math.max(0, Number(order.totalAmount ?? 0) - Number(order.paidAmount ?? 0));
}

export function getOrderStatusBadgeClass(value: string | null | undefined): string {
  const status = normalize(value);
  if (["delivered", "completed"].includes(status)) {
    return "bg-emerald-100 text-emerald-800";
  }
  if (["failed"].includes(status)) {
    return "bg-destructive/10 text-destructive";
  }
  if (["pending"].includes(status)) {
    return "bg-amber-100 text-amber-800";
  }
  if (["confirmed", "processing", "shipped"].includes(status)) {
    return "bg-sky-100 text-sky-800";
  }
  return "bg-slate-100 text-slate-800";
}

export function getPaymentStatusBadgeClass(value: string | null | undefined): string {
  const status = normalize(value);
  if (status === "paid") return "bg-emerald-100 text-emerald-800";
  if (status === "failed") return "bg-destructive/10 text-destructive";
  if (["unpaid", "pending", "processing", "partial"].includes(status)) {
    return "bg-amber-100 text-amber-800";
  }
  return "bg-slate-100 text-slate-800";
}

function getReceiptPaymentStatusLabel(
  order: Pick<OrderReceipt, "paymentMethod" | "paymentStatus">,
): string {
  if (normalize(order.paymentMethod) === "cod" && normalize(order.paymentStatus) === "unpaid") {
    return "Due on delivery";
  }
  return formatOrderSuccessLabel(order.paymentStatus);
}

function getReceiptPaymentBadgeClass(
  order: Pick<OrderReceipt, "paymentMethod" | "paymentStatus">,
): string {
  if (normalize(order.paymentMethod) === "cod" && normalize(order.paymentStatus) === "unpaid") {
    return "bg-slate-100 text-slate-800";
  }
  return getPaymentStatusBadgeClass(order.paymentStatus);
}

export function getOrderSuccessViewState(
  order: OrderReceipt,
  callbackResult?: string | null,
): OrderSuccessViewState {
  const durableKind = getOrderSuccessStateKind(order);
  const paymentStatus = normalize(order.paymentStatus);
  void callbackResult;
  const kind = durableKind;
  if (kind === "payment_issue") {
    return {
      kind,
      shouldFinalizeClientSide: false,
      title: "Payment not completed",
      message:
        `Order #${order.id} is saved. Retry payment below instead of placing another order.`,
      orderStatusLabel: formatOrderSuccessLabel(order.status),
      paymentStatusLabel: getReceiptPaymentStatusLabel(order),
      orderBadgeClass: getOrderStatusBadgeClass(order.status),
      paymentBadgeClass: getReceiptPaymentBadgeClass(order),
    };
  }

  if (kind === "payment_pending") {
    return {
      kind,
      shouldFinalizeClientSide: false,
      title: "Confirming payment",
      message:
        `Order #${order.id} is saved. Do not place it again while we check the payment.`,
      orderStatusLabel: formatOrderSuccessLabel(order.status),
      paymentStatusLabel: getReceiptPaymentStatusLabel(order),
      orderBadgeClass: "bg-amber-100 text-amber-800",
      paymentBadgeClass: getReceiptPaymentBadgeClass(order),
    };
  }

  if (kind === "order_updated") {
    const orderStatus = normalize(order.status);
    const updatedCopy: Record<string, { title: string; message: string }> = {
      confirmed: {
        title: "Order confirmed",
        message: `Order #${order.id} is confirmed and being prepared.`,
      },
      processing: {
        title: "Order processing",
        message: `Order #${order.id} is being prepared.`,
      },
      shipped: {
        title: "Order shipped",
        message: `Order #${order.id} is on the way.`,
      },
      delivered: {
        title: "Order delivered",
        message: `Order #${order.id} has been delivered.`,
      },
      completed: {
        title: "Order completed",
        message: `Order #${order.id} is complete.`,
      },
      cancelled: {
        title: "Order cancelled",
        message: `Order #${order.id} was cancelled.`,
      },
      refunded: {
        title: "Order refunded",
        message: `The refund for order #${order.id} has been recorded.`,
      },
      returned: {
        title: "Order returned",
        message: `The return for order #${order.id} has been recorded.`,
      },
      partially_refunded: {
        title: "Order partially refunded",
        message: `A partial refund for order #${order.id} has been recorded.`,
      },
    };
    const copy = paymentStatus === "refunded" && !CLOSED_ORDER_STATUSES.has(orderStatus)
      ? {
          title: "Order refunded",
          message: `The refund for order #${order.id} has been recorded.`,
        }
      : updatedCopy[orderStatus] ?? {
          title: "Order updated",
          message: `Order #${order.id} has been updated.`,
        };

    return {
      kind,
      shouldFinalizeClientSide: false,
      ...copy,
      orderStatusLabel: formatOrderSuccessLabel(order.status),
      paymentStatusLabel: getReceiptPaymentStatusLabel(order),
      orderBadgeClass: getOrderStatusBadgeClass(order.status),
      paymentBadgeClass: getReceiptPaymentBadgeClass(order),
    };
  }

  return {
    kind,
    shouldFinalizeClientSide: true,
    title: "Order placed",
    message: `We received order #${order.id}.`,
    orderStatusLabel: formatOrderSuccessLabel(
      order.status === "incomplete" ? "processing" : order.status,
    ),
    paymentStatusLabel: getReceiptPaymentStatusLabel(order),
    orderBadgeClass: getOrderStatusBadgeClass(order.status),
    paymentBadgeClass: getReceiptPaymentBadgeClass(order),
  };
}

export function shouldClearCheckoutCartForOrder(
  order: Pick<OrderReceipt, "status" | "paymentMethod" | "paymentStatus" | "paidAmount">,
): boolean {
  const orderStatus = normalize(order.status);
  const paymentStatus = normalize(order.paymentStatus);
  if (
    orderStatus === "incomplete" ||
    orderStatus === "cancelled" ||
    orderStatus === "refunded" ||
    orderStatus === "returned" ||
    orderStatus === "partially_refunded" ||
    paymentStatus === "failed"
  ) {
    return false;
  }
  if (!isOnlinePaymentMethod(order.paymentMethod)) return true;
  return ACCEPTED_PAYMENT_STATUSES.has(paymentStatus) || Number(order.paidAmount ?? 0) > 0;
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
