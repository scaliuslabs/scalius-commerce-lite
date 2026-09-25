import type { OrderItem, OrderReceipt } from "./api/types";
import {
  formatOrderSuccessLabel,
  formatOrderSuccessPaymentMethod as formatGatewayPaymentMethod,
} from "./order-success-localization";
import {
  formatCheckoutLanguageText,
  type CheckoutLanguageData,
} from "@scalius/shared/checkout-language";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { orderDeliveryMode, type OrderFulfilmentView } from "./order-line-groups";
import { giftCardCheckoutCopy } from "./checkout/gift-cards";

export { formatOrderSuccessLabel } from "./order-success-localization";

/** `orders.payment_method` of an order its gift cards paid in full (Wave B §4.3). */
export const GIFT_CARD_PAYMENT_METHOD = "gift_card";

/** One gift card that paid part of the order, as the receipt shows it (never a code). */
export interface ReceiptGiftCardTender {
  last4: string;
  amount: number;
}

/**
 * A receipt or account order, which may carry `giftCardTenders` (read
 * defensively: the field is optional and older payloads lack it).
 */
export type OrderGiftCardFacts = object;

/** The gift cards that paid part of the order (succeeded tenders only); malformed entries are skipped. */
export function readReceiptGiftCardTenders(order: OrderGiftCardFacts): ReceiptGiftCardTender[] {
  const tenders = (order as { giftCardTenders?: unknown }).giftCardTenders;
  if (!Array.isArray(tenders)) return [];
  return tenders.slice(0, 10).flatMap((tender: unknown) => {
    if (typeof tender !== "object" || tender === null) return [];
    const { last4, amount } = tender as { last4?: unknown; amount?: unknown };
    return typeof last4 === "string" && /^[0-9A-Z]{4}$/.test(last4) &&
      typeof amount === "number" && Number.isFinite(amount) && amount > 0
      ? [{ last4, amount }]
      : [];
  });
}

/** "Gift card •••• 7K2Q": one tender row's label. */
export function receiptGiftCardTenderLabel(tender: ReceiptGiftCardTender, copy: CheckoutLanguageData): string {
  return formatCheckoutLanguageText(giftCardCheckoutCopy(copy).giftCardLineText, { card: `•••• ${tender.last4}` });
}

/**
 * How the order is paid: "Gift card" when the cards paid everything, the
 * remainder method after "Gift card + " when they paid part, else the method.
 */
export function formatOrderSuccessPaymentMethod(
  value: string | null | undefined,
  copy: CheckoutLanguageData,
  order: OrderGiftCardFacts & { shippingMethodKind?: string | null; requiresShipping?: boolean | null } = {},
): string {
  const giftCard = giftCardCheckoutCopy(copy).giftCardTitleText;
  if (normalize(value) === GIFT_CARD_PAYMENT_METHOD) return giftCard;
  // Cash reads "Pay at pickup" / "Pay on service" from the order's delivery facts.
  const method = formatGatewayPaymentMethod(value, copy, order);
  return readReceiptGiftCardTenders(order).length > 0 ? `${giftCard} + ${method}` : method;
}

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
/** A (partly) refunded payment reads like a settled one: no retry, nothing due. */
const REFUNDED_PAYMENT_STATUSES = new Set(["refunded", "partially_refunded"]);
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

/**
 * Every payment method except cash on delivery and a gift-card-paid order is
 * an online gateway (a gift card settles at commit: nothing to confirm or retry).
 */
function isOnlinePaymentMethod(paymentMethod: string | null | undefined): boolean {
  const method = normalize(paymentMethod);
  return /^[a-z][a-z0-9_-]{0,63}$/.test(method) && method !== "cod" && method !== GIFT_CARD_PAYMENT_METHOD;
}

/** Paid before anything is handed over: online, or entirely by gift card. */
function isPrepaidPaymentMethod(paymentMethod: string | null | undefined): boolean {
  return isOnlinePaymentMethod(paymentMethod) || normalize(paymentMethod) === GIFT_CARD_PAYMENT_METHOD;
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

  if (CLOSED_ORDER_STATUSES.has(orderStatus) || REFUNDED_PAYMENT_STATUSES.has(paymentStatus)) {
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
  if (CLOSED_ORDER_STATUSES.has(orderStatus) || REFUNDED_PAYMENT_STATUSES.has(paymentStatus)) return 0;

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
    return "bg-destructive text-destructive-foreground";
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
  if (status === "failed") return "bg-destructive text-destructive-foreground";
  if (["unpaid", "pending", "processing", "partial"].includes(status)) {
    return "bg-amber-100 text-amber-800";
  }
  return "bg-slate-100 text-slate-800";
}

type OrderDeliveryFacts = Partial<Pick<OrderFulfilmentView, "requiresShipping" | "shippingMethodKind">>;

/**
 * What a cash-on-delivery balance is due on: the delivery, the pickup at the
 * counter, or the service (Wave A checkout rules).
 */
export function codDueText(order: OrderDeliveryFacts, copy: CheckoutLanguageData): string {
  const mode = orderDeliveryMode(order);
  return mode === "pickup" ? copy.dueAtPickupText : mode === "none" ? copy.dueAtServiceText : copy.dueOnDeliveryText;
}

export function getOrderPaymentPresentation(
  order: Pick<OrderReceipt, "status" | "paymentMethod" | "paymentStatus" | "totalAmount" | "paidAmount" | "balanceDue">
    & OrderDeliveryFacts
    & OrderGiftCardFacts,
  copy: CheckoutLanguageData,
) {
  const isCod = normalize(order.paymentMethod) === "cod";
  const paymentStatus = normalize(order.paymentStatus);
  const isClosed = CLOSED_ORDER_STATUSES.has(normalize(order.status)) || REFUNDED_PAYMENT_STATUSES.has(paymentStatus);
  const codCollection = isCod && ["unpaid", "partial"].includes(paymentStatus);
  const giftCardTenders = readReceiptGiftCardTenders(order);
  // Gift cards paid part and cash on delivery collects the rest: that rest is due at the door.
  const codRemainder = isCod && paymentStatus === "partial" && giftCardTenders.length > 0;
  return {
    isCod,
    isClosed,
    statusLabel: codCollection && isClosed
      ? copy.orderReceiptPaymentStatusNoPaymentDueText
      : isCod && (paymentStatus === "unpaid" || codRemainder)
        ? codDueText(order, copy)
        : formatOrderSuccessLabel(order.paymentStatus, copy),
    badgeClass: codCollection
      ? "bg-slate-100 text-slate-800"
      : getPaymentStatusBadgeClass(order.paymentStatus),
    methodLabel: formatOrderSuccessPaymentMethod(order.paymentMethod, copy, order),
    giftCardTenders,
    balanceDue: getOrderSuccessVisibleBalanceDue(order),
    balanceLabel: isCod
      ? codDueText(order, copy)
      : giftCardTenders.length > 0
        ? giftCardCheckoutCopy(copy).amountDueText
        : copy.orderReceiptBalanceDueText,
  };
}

export function getOrderSuccessViewState(
  order: OrderReceipt,
  copy: CheckoutLanguageData,
  callbackResult?: string | null,
): OrderSuccessViewState {
  const durableKind = getOrderSuccessStateKind(order);
  const paymentStatus = normalize(order.paymentStatus);
  const payment = getOrderPaymentPresentation(order, copy);
  void callbackResult;
  const kind = durableKind;
  // Copy templates already carry the "#": "We received order #{orderId}."
  const orderId = formatOrderNumber(order.orderNumber, order.id).slice(1);
  if (kind === "payment_issue") {
    return {
      kind,
      shouldFinalizeClientSide: false,
      title: copy.orderReceiptPaymentIssueTitleText,
      message: formatCheckoutLanguageText(copy.orderReceiptPaymentIssueMessageText, { orderId }),
      orderStatusLabel: formatOrderSuccessLabel(order.status, copy),
      paymentStatusLabel: payment.statusLabel,
      orderBadgeClass: getOrderStatusBadgeClass(order.status),
      paymentBadgeClass: payment.badgeClass,
    };
  }

  if (kind === "payment_pending") {
    return {
      kind,
      shouldFinalizeClientSide: false,
      title: copy.orderReceiptPaymentPendingTitleText,
      message: formatCheckoutLanguageText(copy.orderReceiptPaymentPendingMessageText, { orderId }),
      orderStatusLabel: formatOrderSuccessLabel(order.status, copy),
      paymentStatusLabel: payment.statusLabel,
      orderBadgeClass: "bg-amber-100 text-amber-800",
      paymentBadgeClass: payment.badgeClass,
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
    const stateCopy = REFUNDED_PAYMENT_STATUSES.has(paymentStatus) && !CLOSED_ORDER_STATUSES.has(orderStatus)
      ? updatedCopy[paymentStatus]!
      : updatedCopy[orderStatus] ?? {
          title: copy.orderReceiptUpdatedTitleText,
          message: copy.orderReceiptUpdatedMessageText,
        };

    return {
      kind,
      shouldFinalizeClientSide: false,
      title: stateCopy.title,
      message: formatCheckoutLanguageText(stateCopy.message, { orderId }),
      orderStatusLabel: formatOrderSuccessLabel(order.status, copy),
      paymentStatusLabel: payment.statusLabel,
      orderBadgeClass: getOrderStatusBadgeClass(order.status),
      paymentBadgeClass: payment.badgeClass,
    };
  }

  return {
    kind,
    shouldFinalizeClientSide: true,
    title: copy.orderReceiptPlacedTitleText,
    message: formatCheckoutLanguageText(copy.orderReceiptPlacedMessageText, { orderId }),
    orderStatusLabel: formatOrderSuccessLabel(
      order.status === "incomplete" ? "processing" : order.status,
      copy,
    ),
    paymentStatusLabel: payment.statusLabel,
    orderBadgeClass: getOrderStatusBadgeClass(order.status),
    paymentBadgeClass: payment.badgeClass,
  };
}

/**
 * A receipt opened by tracking (`view=status`), or reopened after the store
 * moved the order on, is a status page. The confirmation right after
 * checkout or a payment return stays a confirmation.
 */
export function isOrderStatusView(
  kind: OrderSuccessStateKind,
  opened: { requestedView: string | null; freshCheckout: boolean },
): boolean {
  if (opened.requestedView === "status") return true;
  return kind === "order_updated" && !opened.freshCheckout;
}

// "2-3 days", "24 hours", "৩-৫ কার্যদিবস": only a duration the merchant wrote.
const DELIVERY_ESTIMATE =
  /[0-9০-৯]+(?:\s*[-–]\s*[0-9০-৯]+)?\s*(?:(?:business|working)\s+)?(?:days?|hours?|কার্যদিবস|দিন|ঘণ্টা)/i;

/**
 * Shopify's "what happens next" for a just-placed order. The delivery estimate
 * comes only from the chosen delivery method's own description.
 */
export function getOrderSuccessNextSteps(
  order: Pick<OrderReceipt, "paymentMethod" | "shippingMethodDescription"> & OrderDeliveryFacts,
  kind: OrderSuccessStateKind,
  copy: CheckoutLanguageData,
): string[] {
  if (kind !== "order_placed") return [];
  const paid = isPrepaidPaymentMethod(order.paymentMethod);
  // Nothing goes to a courier for a pickup or a service.
  const mode = orderDeliveryMode(order);
  if (mode === "pickup") {
    return [paid ? copy.orderReceiptNextStepsPickupPaidText : copy.orderReceiptNextStepsPickupCodText];
  }
  if (mode === "none") {
    return [paid ? copy.orderReceiptNextStepsServicePaidText : copy.orderReceiptNextStepsServiceCodText];
  }
  const estimate = DELIVERY_ESTIMATE.exec(order.shippingMethodDescription ?? "")?.[0];
  return [
    paid ? copy.orderReceiptNextStepsPaidText : copy.orderReceiptNextStepsCodText,
    ...(estimate ? [formatCheckoutLanguageText(copy.orderReceiptDeliveryEstimateText, { estimate })] : []),
  ];
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
