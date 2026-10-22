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
import { baseLanguage, numberLocale } from "@scalius/shared/locale-format";
import { formatUnitRange } from "@scalius/shared/locale-words";
import { pageLanguage, storeRegion } from "./store-time-zone";
import { isPaymentMethodIdShape } from "./payment-method-id";
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
  /** The store's checkout gateways: an app wallet reads by their checkout name. */
  gateways?: readonly { id: string; name?: unknown }[] | null,
): string {
  const giftCard = giftCardCheckoutCopy(copy).giftCardTitleText;
  if (normalize(value) === GIFT_CARD_PAYMENT_METHOD) return giftCard;
  // Cash reads "Pay at pickup" / "Pay on service" from the order's delivery facts.
  const method = formatGatewayPaymentMethod(value, copy, order, gateways);
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
/** What a hosted payment's return (or a payment that could not start) says in `result`. */
const FAILED_PAYMENT_RESULTS = new Set(["failed", "cancelled"]);

/** The return says the payment failed or was cancelled. */
export function isFailedPaymentResult(result: string | null | undefined): boolean {
  return FAILED_PAYMENT_RESULTS.has(normalize(result));
}
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
 * Every payment method except cash on delivery, the store's invoice and a
 * gift-card-paid order is an online gateway (a gift card settles at commit:
 * nothing to confirm or retry): a built-in id or an app provider's
 * `<plugin id>:<provider id>`. An app's own invoice is told apart by the
 * order's `paymentTerms` (`isPaidLater`).
 */
function isOnlinePaymentMethod(paymentMethod: string | null | undefined): boolean {
  const method = normalize(paymentMethod);
  return isPaymentMethodIdShape(method) && method !== "cod" && method !== GIFT_CARD_PAYMENT_METHOD && method !== "net_terms";
}

/** Paid later by invoice: placed now, nothing to confirm or retry online. */
function isPaidLater(order: { paymentMethod?: string | null; paymentTerms?: OrderReceipt["paymentTerms"] }): boolean {
  return normalize(order.paymentMethod) === "net_terms" || Boolean(order.paymentTerms);
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
  > & Pick<Partial<OrderReceipt>, "paymentTerms">,
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

  if (!isOnlinePaymentMethod(order.paymentMethod) || isPaidLater(order)) {
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
  // The order still waits for an online payment and the return says it
  // failed (or never started): that is known, so the page says it and offers
  // a retry instead of "pending". Anything the store recorded wins: a paid,
  // failed or closed order reads from its own state whatever the URL says.
  const failedReturn = durableKind === "payment_pending"
    && isOnlinePaymentMethod(order.paymentMethod)
    && !isAcceptedPayment(order)
    && isFailedPaymentResult(callbackResult);
  const kind: OrderSuccessStateKind = failedReturn ? "payment_issue" : durableKind;
  // Copy templates already carry the "#": "We received order #{orderId}."
  const orderId = formatOrderNumber(order.orderNumber, order.id).slice(1);
  if (kind === "payment_issue") {
    return {
      kind,
      shouldFinalizeClientSide: false,
      title: failedReturn ? copy.orderReceiptPaymentFailedTitleText : copy.orderReceiptPaymentIssueTitleText,
      message: formatCheckoutLanguageText(
        failedReturn ? copy.orderReceiptPaymentFailedMessageText : copy.orderReceiptPaymentIssueMessageText,
        { orderId },
      ),
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
  /([0-9০-৯]+)(?:\s*[-–]\s*([0-9০-৯]+))?\s*((?:business|working)\s+)?(days?|hours?|কার্যদিবস|দিন|ঘণ্টা)/i;

/**
 * The merchant's duration in the page's language: an English "1–2 days" on a
 * Bangla receipt reads "১–২ দিন" (the suggested delivery zones write English),
 * so the sentence around it never mixes languages. A duration already in the
 * page's words, or a business-day count (no CLDR unit), stays as written.
 */
export function localizedDeliveryEstimate(description: string, language: string, region?: string | null): string | null {
  const match = DELIVERY_ESTIMATE.exec(description);
  if (!match) return null;
  const [text, from, to, business, unitWord] = match;
  const english = /^(?:days?|hours?)$/i.test(unitWord!);
  if (!english || business || baseLanguage(language) === "en") return text;
  const start = Number(from);
  const end = to === undefined ? start : Number(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return text;
  return formatUnitRange(start, end, /^day/i.test(unitWord!) ? "day" : "hour", numberLocale(language, region), { unitDisplay: "long" });
}

/**
 * Shopify's "what happens next" for a just-placed order. The delivery estimate
 * comes only from the chosen delivery method's own description.
 */
type ReceiptLineFacts = Pick<OrderItem, "quantity" | "fulfillmentType" | "fulfilledQuantity">;

/**
 * A downloadable line whose files and keys are still being prepared: the
 * payment has settled and fulfilment runs in the background, so the receipt
 * says so and checks back instead of looking finished.
 */
export function isDigitalLinePreparing(
  line: ReceiptLineFacts,
  order: Pick<OrderReceipt, "status" | "paymentStatus"> & { balanceDue?: number | null },
): boolean {
  if (line.fulfillmentType !== "digital") return false;
  if ((line.fulfilledQuantity ?? 0) >= line.quantity) return false;
  if (CLOSED_ORDER_STATUSES.has(normalize(order.status))) return false;
  return normalize(order.paymentStatus) === "paid" || order.balanceDue === 0;
}

export function getOrderSuccessNextSteps(
  order: Pick<OrderReceipt, "paymentMethod" | "shippingMethodDescription"> & OrderDeliveryFacts & {
    items?: readonly ReceiptLineFacts[];
  },
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
  // Downloads arrive on the receipt and by email; nobody calls to arrange them.
  if (mode === "none" && order.items?.length && order.items.every((line) => line.fulfillmentType === "digital")) {
    return [paid ? copy.orderReceiptNextStepsDigitalPaidText : copy.orderReceiptNextStepsDigitalText];
  }
  if (mode === "none") {
    return [paid ? copy.orderReceiptNextStepsServicePaidText : copy.orderReceiptNextStepsServiceCodText];
  }
  const estimate = localizedDeliveryEstimate(order.shippingMethodDescription ?? "", pageLanguage(), storeRegion());
  return [
    paid ? copy.orderReceiptNextStepsPaidText : copy.orderReceiptNextStepsCodText,
    ...(estimate ? [formatCheckoutLanguageText(copy.orderReceiptDeliveryEstimateText, { estimate })] : []),
  ];
}

export function shouldClearCheckoutCartForOrder(
  order: Pick<OrderReceipt, "status" | "paymentMethod" | "paymentStatus" | "paidAmount"> & Pick<Partial<OrderReceipt>, "paymentTerms">,
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
  if (!isOnlinePaymentMethod(order.paymentMethod) || isPaidLater(order)) return true;
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
