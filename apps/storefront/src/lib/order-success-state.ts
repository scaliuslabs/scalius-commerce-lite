import type { OrderItem, OrderReceipt } from "./api/types";
import {
  formatOrderSuccessLabel,
} from "./order-success-localization";
import {
  formatCheckoutLanguageText,
  type CheckoutLanguageData,
} from "@scalius/shared/checkout-language";

export { formatOrderSuccessLabel, formatOrderSuccessPaymentMethod } from "./order-success-localization";

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
  order: Pick<OrderReceipt, "status" | "paymentMethod" | "paymentStatus">,
  copy: CheckoutLanguageData,
): string {
  if (normalize(order.paymentMethod) === "cod" && normalize(order.paymentStatus) === "unpaid") {
    if (CLOSED_ORDER_STATUSES.has(normalize(order.status))) {
      return copy.orderReceiptPaymentStatusNoPaymentDueText;
    }
    return copy.dueOnDeliveryText;
  }
  return formatOrderSuccessLabel(order.paymentStatus, copy);
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
  copy: CheckoutLanguageData,
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
      title: copy.orderReceiptPaymentIssueTitleText,
      message: formatCheckoutLanguageText(copy.orderReceiptPaymentIssueMessageText, { orderId: order.id }),
      orderStatusLabel: formatOrderSuccessLabel(order.status, copy),
      paymentStatusLabel: getReceiptPaymentStatusLabel(order, copy),
      orderBadgeClass: getOrderStatusBadgeClass(order.status),
      paymentBadgeClass: getReceiptPaymentBadgeClass(order),
    };
  }

  if (kind === "payment_pending") {
    return {
      kind,
      shouldFinalizeClientSide: false,
      title: copy.orderReceiptPaymentPendingTitleText,
      message: formatCheckoutLanguageText(copy.orderReceiptPaymentPendingMessageText, { orderId: order.id }),
      orderStatusLabel: formatOrderSuccessLabel(order.status, copy),
      paymentStatusLabel: getReceiptPaymentStatusLabel(order, copy),
      orderBadgeClass: "bg-amber-100 text-amber-800",
      paymentBadgeClass: getReceiptPaymentBadgeClass(order),
    };
  }

  if (kind === "order_updated") {
    const orderStatus = normalize(order.status);
    const updatedCopy: Record<string, { title: string; message: string }> = {
      confirmed: {
        title: copy.orderReceiptConfirmedTitleText,
        message: copy.orderReceiptConfirmedMessageText,
      },
      processing: {
        title: copy.orderReceiptProcessingTitleText,
        message: copy.orderReceiptProcessingMessageText,
      },
      shipped: {
        title: copy.orderReceiptShippedTitleText,
        message: copy.orderReceiptShippedMessageText,
      },
      delivered: {
        title: copy.orderReceiptDeliveredTitleText,
        message: copy.orderReceiptDeliveredMessageText,
      },
      completed: {
        title: copy.orderReceiptCompletedTitleText,
        message: copy.orderReceiptCompletedMessageText,
      },
      cancelled: {
        title: copy.orderReceiptCancelledTitleText,
        message: copy.orderReceiptCancelledMessageText,
      },
      refunded: {
        title: copy.orderReceiptRefundedTitleText,
        message: copy.orderReceiptRefundedMessageText,
      },
      returned: {
        title: copy.orderReceiptReturnedTitleText,
        message: copy.orderReceiptReturnedMessageText,
      },
      partially_refunded: {
        title: copy.orderReceiptPartiallyRefundedTitleText,
        message: copy.orderReceiptPartiallyRefundedMessageText,
      },
    };
    const stateCopy = paymentStatus === "refunded" && !CLOSED_ORDER_STATUSES.has(orderStatus)
      ? {
          title: copy.orderReceiptRefundedTitleText,
          message: copy.orderReceiptRefundedMessageText,
        }
      : updatedCopy[orderStatus] ?? {
          title: copy.orderReceiptUpdatedTitleText,
          message: copy.orderReceiptUpdatedMessageText,
        };

    return {
      kind,
      shouldFinalizeClientSide: false,
      title: stateCopy.title,
      message: formatCheckoutLanguageText(stateCopy.message, { orderId: order.id }),
      orderStatusLabel: formatOrderSuccessLabel(order.status, copy),
      paymentStatusLabel: getReceiptPaymentStatusLabel(order, copy),
      orderBadgeClass: getOrderStatusBadgeClass(order.status),
      paymentBadgeClass: getReceiptPaymentBadgeClass(order),
    };
  }

  return {
    kind,
    shouldFinalizeClientSide: true,
    title: copy.orderReceiptPlacedTitleText,
    message: formatCheckoutLanguageText(copy.orderReceiptPlacedMessageText, { orderId: order.id }),
    orderStatusLabel: formatOrderSuccessLabel(
      order.status === "incomplete" ? "processing" : order.status,
      copy,
    ),
    paymentStatusLabel: getReceiptPaymentStatusLabel(order, copy),
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
