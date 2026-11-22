import { orderPaymentWord, type OrderPaymentWord, type OrderPaymentWordsFacts } from "./order-payment-words";
import { normalizeOrderStatus, type OrderStatusValue } from "./order-state";

/**
 * What a buyer is shown of an order, decided once on the server and sent with
 * the receipt, the account order and the account orders list, so the
 * storefront only words it and two pages never disagree about one order.
 *
 * - `kind`: how the receipt opens. `payment_pending` waits on an online
 *   payment, `payment_issue` had one fail, `order_updated` has moved on from
 *   placed (or closed), `order_placed` is placed and needs nothing.
 * - `status`: the order's one status word, by where it is (a processing order
 *   is "confirmed", a completed one "delivered").
 * - `payment`: the shared payment word (`orderPaymentWord`), so the receipt
 *   says what the dashboard, the export and the account say.
 */
export const BUYER_ORDER_KINDS = ["order_placed", "order_updated", "payment_pending", "payment_issue"] as const;
export type BuyerOrderKind = (typeof BUYER_ORDER_KINDS)[number];

export const BUYER_ORDER_STATUS_WORDS = [
  "awaiting_payment",
  "placed",
  "confirmed",
  "shipped",
  "delivered",
  "cancelled",
  "returned",
  "refunded",
] as const;
export type BuyerOrderStatusWord = (typeof BUYER_ORDER_STATUS_WORDS)[number];

const STATUS_WORD: Readonly<Record<OrderStatusValue, BuyerOrderStatusWord>> = {
  incomplete: "awaiting_payment",
  pending: "placed",
  processing: "confirmed",
  confirmed: "confirmed",
  shipped: "shipped",
  delivered: "delivered",
  completed: "delivered",
  cancelled: "cancelled",
  returned: "returned",
  refunded: "refunded",
};

/** The order status's buyer word; an unknown status reads as placed. */
export function buyerOrderStatusWord(status: string): BuyerOrderStatusWord {
  const known = normalizeOrderStatus(status);
  return known ? STATUS_WORD[known] : "placed";
}

export interface BuyerOrderFacts extends OrderPaymentWordsFacts {
  /** The order's payment method takes money online (a built-in or app gateway). */
  onlinePayment: boolean;
  /** Paid later by invoice: placed now, nothing to confirm online. */
  paidLater: boolean;
}

export interface BuyerOrderView {
  kind: BuyerOrderKind;
  status: BuyerOrderStatusWord;
  /** Null only for a payment status the platform does not write. */
  payment: OrderPaymentWord | null;
}

/** What the receipt and the account order add: what the buyer can do and expect about money. */
export interface BuyerOrderDetailView extends BuyerOrderView {
  /** A refund to the buyer is in flight (one its provider accepted and is completing included). */
  refundOnItsWay: boolean;
  /** A new payment session would be accepted now (the payment session route's own checks). */
  canRetryPayment: boolean;
}

const CLOSED_ORDER = new Set<string>(["cancelled", "refunded", "returned"]);
const ACTIVE_ORDER = new Set<string>(["confirmed", "processing", "shipped", "delivered", "completed"]);
const REFUNDED_PAYMENT = new Set<string>(["refunded", "partially_refunded"]);

function kindOf(facts: BuyerOrderFacts): BuyerOrderKind {
  const status = facts.status.trim().toLowerCase();
  const payment = (facts.paymentStatus ?? "").trim().toLowerCase();
  if (CLOSED_ORDER.has(status) || REFUNDED_PAYMENT.has(payment)) return "order_updated";
  if (payment === "failed") return "payment_issue";
  const accepted = payment === "paid" || payment === "partial" || Number(facts.paidAmount ?? 0) > 0;
  // Only an online payment is waited for: cash, an invoice or a gift card settle elsewhere.
  const waiting = status === "incomplete" || (facts.onlinePayment && !facts.paidLater && !accepted);
  if (waiting) return "payment_pending";
  return ACTIVE_ORDER.has(status) ? "order_updated" : "order_placed";
}

export function buyerOrderView(facts: BuyerOrderFacts): BuyerOrderView {
  return { kind: kindOf(facts), status: buyerOrderStatusWord(facts.status), payment: orderPaymentWord(facts) };
}

export function buyerOrderDetailView(
  facts: BuyerOrderFacts,
  extra: { refundInFlight: boolean; paymentRecoverable: boolean },
): BuyerOrderDetailView {
  return {
    ...buyerOrderView(facts),
    refundOnItsWay: extra.refundInFlight,
    // Money on its way back is never asked for again meanwhile.
    canRetryPayment: extra.paymentRecoverable && !extra.refundInFlight,
  };
}
