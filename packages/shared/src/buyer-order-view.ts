import { cashCollectionPoint } from "./order-payment-methods";
import { orderPaymentWord, type OrderPaymentWord, type OrderPaymentWordsFacts } from "./order-payment-words";
import { normalizeOrderStatus } from "./order-state";

/**
 * What a buyer is shown of an order, decided once on the server and sent with
 * the receipt, the account order, the account orders list and the order
 * lookup, so the storefront only words it and no two pages disagree.
 *
 * - `kind`: how the receipt opens. `payment_pending` waits on an online
 *   payment, `payment_issue` had one fail, `checkout_expired` is a checkout
 *   whose hold ended unpaid, `order_updated` has moved on from placed (or
 *   closed), `order_placed` is placed and needs nothing.
 * - `status`: the order's one status word, by where it is and how it reaches
 *   the buyer (a processing order is `confirmed`; a pickup order that is ready
 *   is `ready_for_pickup`, a collected one `picked_up`).
 * - `payment`: the shared payment word (`orderPaymentWord`).
 */
export const BUYER_ORDER_KINDS = ["order_placed", "order_updated", "payment_pending", "payment_issue", "checkout_expired"] as const;
export type BuyerOrderKind = (typeof BUYER_ORDER_KINDS)[number];

export const BUYER_ORDER_STATUS_WORDS = [
  "awaiting_payment",
  "checkout_expired",
  "placed",
  "confirmed",
  "shipped",
  "ready_for_pickup",
  "preparing",
  "delivered",
  "picked_up",
  "completed",
  "cancelled",
  "returned",
  "refunded",
] as const;
export type BuyerOrderStatusWord = (typeof BUYER_ORDER_STATUS_WORDS)[number];

/** The status words in English, for the API's `statusLabel` (the storefront words the keys itself). */
export const BUYER_ORDER_STATUS_WORDS_EN: Readonly<Record<BuyerOrderStatusWord, string>> = {
  awaiting_payment: "Awaiting payment",
  checkout_expired: "Checkout expired",
  placed: "Order placed",
  confirmed: "Confirmed",
  shipped: "On its way",
  ready_for_pickup: "Ready for pickup",
  preparing: "Preparing",
  delivered: "Delivered",
  picked_up: "Picked up",
  completed: "Completed",
  cancelled: "Cancelled",
  returned: "Returned",
  refunded: "Refunded",
};

/**
 * What a payment the buyer may make now is for: `retry` a payment that is
 * pending or failed (the receipt and the account offer it), or `pay_balance`
 * the rest of a placed order early online (the account offers it; the
 * receipt never words it as a retry).
 */
export const BUYER_PAYMENT_ACTIONS = ["retry", "pay_balance"] as const;
export type BuyerPaymentAction = (typeof BUYER_PAYMENT_ACTIONS)[number];

/**
 * How the reader proved the order is theirs. A `lookup` (an order number and
 * a contact) is the weakest proof: it sees no dispute.
 */
export type BuyerOrderProof = "receipt" | "account" | "lookup";

export interface BuyerOrderFacts extends OrderPaymentWordsFacts {
  /** The order's payment method takes money online (a built-in or app gateway). */
  onlinePayment: boolean;
  /** Paid later by invoice: placed now, nothing to confirm online. */
  paidLater: boolean;
  /** Staff said a pickup order is ready to collect. */
  pickupReady?: boolean | null;
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
  /** The payment the buyer may make now, by what it is for; null: none would be accepted. */
  paymentAction: BuyerPaymentAction | null;
}

const CLOSED_ORDER = new Set<string>(["cancelled", "refunded", "returned"]);
const ACTIVE_ORDER = new Set<string>(["confirmed", "processing", "shipped", "delivered", "completed"]);
const REFUNDED_PAYMENT = new Set<string>(["refunded", "partially_refunded"]);
const OPEN_PICKUP = new Set<string>(["pending", "processing", "confirmed"]);

/** An incomplete checkout whose hold ended: it takes no payment any more. */
function checkoutEnded(facts: BuyerOrderFacts): boolean {
  return facts.status.trim().toLowerCase() === "incomplete" && facts.checkoutOpen === false;
}

/** The order's status word, by where it is and how it reaches the buyer. */
export function buyerOrderStatusWord(facts: Pick<BuyerOrderFacts, "status" | "checkoutOpen" | "shippingMethodKind" | "requiresShipping" | "pickupReady">): BuyerOrderStatusWord {
  const status = normalizeOrderStatus(facts.status);
  const place = cashCollectionPoint(facts);
  switch (status) {
    case "incomplete": return facts.checkoutOpen === false ? "checkout_expired" : "awaiting_payment";
    case "pending":
    case "processing":
    case "confirmed":
      if (place === "pickup" && facts.pickupReady && OPEN_PICKUP.has(status)) return "ready_for_pickup";
      if (status === "pending") return "placed";
      // Nothing travels: once confirmed, the store is preparing the service.
      return place === "service" ? "preparing" : "confirmed";
    case "shipped": return place === "pickup" ? "ready_for_pickup" : place === "service" ? "preparing" : "shipped";
    case "delivered":
    case "completed": return place === "pickup" ? "picked_up" : place === "service" ? "completed" : "delivered";
    case "cancelled":
    case "returned":
    case "refunded": return status;
    default: return "placed";
  }
}

function kindOf(facts: BuyerOrderFacts): BuyerOrderKind {
  const status = facts.status.trim().toLowerCase();
  const payment = (facts.paymentStatus ?? "").trim().toLowerCase();
  if (CLOSED_ORDER.has(status) || REFUNDED_PAYMENT.has(payment)) return "order_updated";
  if (checkoutEnded(facts)) return "checkout_expired";
  if (payment === "failed") return "payment_issue";
  const accepted = payment === "paid" || payment === "partial" || Number(facts.paidAmount ?? 0) > 0;
  // Only an online payment is waited for: cash, an invoice or a gift card settle elsewhere.
  const waiting = status === "incomplete" || (facts.onlinePayment && !facts.paidLater && !accepted);
  if (waiting) return "payment_pending";
  return ACTIVE_ORDER.has(status) ? "order_updated" : "order_placed";
}

/** The view a proof may see: a lookup sees no dispute. */
export function buyerOrderView(facts: BuyerOrderFacts, proof: BuyerOrderProof): BuyerOrderView {
  const visible = proof === "lookup" ? { ...facts, disputeOpen: false, disputedAmount: 0 } : facts;
  return { kind: kindOf(visible), status: buyerOrderStatusWord(visible), payment: orderPaymentWord(visible) };
}

export function buyerOrderDetailView(
  facts: BuyerOrderFacts,
  proof: Exclude<BuyerOrderProof, "lookup">,
  extra: { refundInFlight: boolean; paymentRecoverable: boolean },
): BuyerOrderDetailView {
  const view = buyerOrderView(facts, proof);
  // Money on its way back is never asked for again meanwhile.
  const payable = extra.paymentRecoverable && !extra.refundInFlight;
  const waiting = view.kind === "payment_pending" || view.kind === "payment_issue";
  return {
    ...view,
    refundOnItsWay: extra.refundInFlight,
    paymentAction: !payable ? null : waiting ? "retry" : "pay_balance",
  };
}
