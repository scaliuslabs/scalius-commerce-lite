import { checkoutText, pageOrderNumber } from "@/lib/checkout-text";
import type { OrderItem, OrderReceipt } from "./api/types";
import {
  formatOrderSuccessPaymentMethod as formatGatewayPaymentMethod,
  RECORDED_PAYMENT_METHOD,
} from "./order-success-localization";
import {
  buyerOrderBadgeClass,
  buyerOrderStatusText,
  buyerPaymentBadgeClass,
  buyerPaymentText,
} from "./buyer-order-words";
import type { BuyerOrderDetailView, BuyerOrderKind, BuyerOrderStatusWord, BuyerOrderView } from "@scalius/shared/buyer-order-view";
import type { CheckoutLanguageData } from "@scalius/shared/checkout-language";

import { baseLanguage, numberLocale } from "@scalius/shared/locale-format";
import { formatUnitRange } from "@scalius/shared/locale-words";
import { pageLanguage, storeRegion } from "./store-time-zone";
import { isPaymentMethodIdShape } from "./payment-method-id";
import { orderPaymentKind } from "@scalius/shared/order-payment-methods";
import { orderDeliveryMode, type OrderFulfilmentView } from "./order-line-groups";
import { giftCardCheckoutCopy } from "./checkout/gift-cards";


/** `orders.payment_method` of an order its gift cards paid in full (Wave B §4.3). */
export const GIFT_CARD_PAYMENT_METHOD = "gift_card";
export { RECORDED_PAYMENT_METHOD };

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
  return checkoutText(giftCardCheckoutCopy(copy).giftCardLineText, { card: `•••• ${tender.last4}` });
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

/** What a hosted payment's return (or a payment that could not start) says in `result`. */
const FAILED_PAYMENT_RESULTS = new Set(["failed", "cancelled"]);

/** The return says the payment failed or was cancelled. */
export function isFailedPaymentResult(result: string | null | undefined): boolean {
  return FAILED_PAYMENT_RESULTS.has(normalize(result));
}
export type OrderSuccessStateKind = BuyerOrderKind;

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
 * Paid before anything is handed over: an online gateway (a built-in id or an
 * app's `<plugin id>:<provider id>`), entirely by gift card, or as it was placed.
 */
function isPrepaidPaymentMethod(paymentMethod: string | null | undefined): boolean {
  const method = normalize(paymentMethod);
  const kind = orderPaymentKind(method);
  return kind === "online" || kind === "gift_card" || kind === "paid_to_store"
    || (kind === null && isPaymentMethodIdShape(method));
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

/** The order facts the payment words and balance read: the server's view, the method and what is owed. */
type OrderPaymentFacts = Pick<OrderReceipt, "paymentMethod" | "balanceDue">
  & { buyerView: Pick<BuyerOrderView, "payment"> }
  & OrderDeliveryFacts
  & OrderGiftCardFacts;

/**
 * How the order is paid, in the page's words: the server's payment word
 * (`orderPaymentWord`), the method, any gift cards and what is still owed
 * (the API sends only a balance the buyer owes: none on a closed order).
 */
export function getOrderPaymentPresentation(order: OrderPaymentFacts, copy: CheckoutLanguageData) {
  const isCod = normalize(order.paymentMethod) === "cod";
  const giftCardTenders = readReceiptGiftCardTenders(order);
  const word = order.buyerView.payment;
  return {
    word,
    statusLabel: buyerPaymentText(word, copy),
    badgeClass: buyerPaymentBadgeClass(word),
    methodLabel: formatOrderSuccessPaymentMethod(order.paymentMethod, copy, order),
    giftCardTenders,
    balanceDue: Math.max(0, Number(order.balanceDue) || 0),
    balanceLabel: isCod
      ? codDueText(order, copy)
      : giftCardTenders.length > 0
        ? giftCardCheckoutCopy(copy).amountDueText
        : copy.orderReceiptBalanceDueText,
  };
}

type ReceiptViewOrder = Pick<OrderReceipt, "id" | "orderNumber" | "paymentMethod" | "balanceDue">
  & { buyerView: BuyerOrderDetailView }
  & OrderDeliveryFacts
  & OrderGiftCardFacts;

/** The receipt's heading and badges, worded from the server's view of the order. */
export function getOrderSuccessViewState(
  order: ReceiptViewOrder,
  copy: CheckoutLanguageData,
  callbackResult?: string | null,
): OrderSuccessViewState {
  const view = order.buyerView;
  const payment = getOrderPaymentPresentation(order, copy);
  // The order still waits for an online payment and the return says it
  // failed (or never started): that is known, so the page says it and offers
  // a retry instead of "pending". Anything the store recorded wins: a paid,
  // failed or closed order reads from its own state whatever the URL says.
  const failedReturn = view.kind === "payment_pending" && view.canRetryPayment && isFailedPaymentResult(callbackResult);
  const kind: OrderSuccessStateKind = failedReturn ? "payment_issue" : view.kind;
  // Copy templates already carry the "#": "We received order #{orderId}."
  const orderId = pageOrderNumber(order.orderNumber, order.id).slice(1);
  const badges = {
    orderStatusLabel: buyerOrderStatusText(view.status, copy),
    paymentStatusLabel: payment.statusLabel,
    orderBadgeClass: buyerOrderBadgeClass({ kind, status: view.status }),
    paymentBadgeClass: payment.badgeClass,
  };
  if (kind === "payment_issue") {
    return {
      kind,
      shouldFinalizeClientSide: false,
      title: failedReturn ? copy.orderReceiptPaymentFailedTitleText : copy.orderReceiptPaymentIssueTitleText,
      message: checkoutText(
        failedReturn ? copy.orderReceiptPaymentFailedMessageText : copy.orderReceiptPaymentIssueMessageText,
        { orderId },
      ),
      ...badges,
    };
  }

  if (kind === "payment_pending") {
    return {
      kind,
      shouldFinalizeClientSide: false,
      title: copy.orderReceiptPaymentPendingTitleText,
      message: checkoutText(copy.orderReceiptPaymentPendingMessageText, { orderId }),
      ...badges,
    };
  }

  if (kind === "order_updated") {
    const updatedCopy: Partial<Record<BuyerOrderStatusWord | "partially_refunded", { title: string; message: string }>> = {
      confirmed: { title: copy.orderReceiptConfirmedTitleText, message: copy.orderReceiptConfirmedMessageText },
      shipped: { title: copy.orderReceiptShippedTitleText, message: copy.orderReceiptShippedMessageText },
      delivered: { title: copy.orderReceiptDeliveredTitleText, message: copy.orderReceiptDeliveredMessageText },
      cancelled: { title: copy.orderReceiptCancelledTitleText, message: copy.orderReceiptCancelledMessageText },
      refunded: { title: copy.orderReceiptRefundedTitleText, message: copy.orderReceiptRefundedMessageText },
      returned: { title: copy.orderReceiptReturnedTitleText, message: copy.orderReceiptReturnedMessageText },
      partially_refunded: {
        title: copy.orderReceiptPartiallyRefundedTitleText,
        message: copy.orderReceiptPartiallyRefundedMessageText,
      },
    };
    // Money given back on an order still open reads as the refund; a closed order reads as what closed it.
    const refundedOpenOrder = (view.payment === "refunded" || view.payment === "partially_refunded")
      && !CLOSED_STATUS_WORDS.has(view.status);
    const stateCopy = (refundedOpenOrder ? updatedCopy[view.payment as "refunded" | "partially_refunded"] : updatedCopy[view.status])
      ?? { title: copy.orderReceiptUpdatedTitleText, message: copy.orderReceiptUpdatedMessageText };

    return {
      kind,
      shouldFinalizeClientSide: false,
      title: stateCopy.title,
      message: checkoutText(stateCopy.message, { orderId }),
      ...badges,
    };
  }

  return {
    kind,
    shouldFinalizeClientSide: true,
    title: copy.orderReceiptPlacedTitleText,
    message: checkoutText(copy.orderReceiptPlacedMessageText, { orderId }),
    ...badges,
  };
}

const CLOSED_STATUS_WORDS = new Set<BuyerOrderStatusWord>(["cancelled", "returned", "refunded"]);

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
  if (["cancelled", "returned", "refunded"].includes(normalize(order.status))) return false;
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
    ...(estimate ? [checkoutText(copy.orderReceiptDeliveryEstimateText, { estimate })] : []),
  ];
}

/** The checkout's cart is done with once the order is placed or moved on, and not closed. */
export function shouldClearCheckoutCartForOrder(order: { buyerView: Pick<BuyerOrderView, "kind" | "status"> }): boolean {
  const { kind, status } = order.buyerView;
  return (kind === "order_placed" || kind === "order_updated") && !CLOSED_STATUS_WORDS.has(status);
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
