import { cashCollectionPoint } from "./order-payment-methods";
import { PAYMENT_STATUSES, type PaymentStatusValue } from "./order-state";

/**
 * What an order's payment is called, one derivation for every surface: the
 * order page, the orders list, the Payment card and the orders export (CSV,
 * both formats). Each surface words it in its own language; the meaning is
 * decided here once.
 *
 * - A dispute the bank has not decided is "Dispute open": nothing is lost yet.
 * - Money a bank took back and kept: all the store held ("Lost to dispute"),
 *   part of it ("Partly lost to dispute"), or part, with the rest refunded
 *   ("Partly lost to dispute, rest refunded"). A won or reinstated dispute
 *   gave the money back: the payment reads as it did before.
 * - An unpaid cash order is not late, it is due where it is handed over: "Due
 *   on delivery", "Due at pickup", "Due on service".
 * - A closed order (cancelled, refunded, returned or never finished) that took
 *   no money owes nothing.
 */
export type OrderPaymentWord =
  | PaymentStatusValue
  | "dueOnDelivery"
  | "dueAtPickup"
  | "dueOnService"
  | "nothingDue"
  | "disputeOpen"
  | "lostToDispute"
  | "partlyLostToDispute"
  | "partlyLostRestRefunded";

export interface OrderPaymentWordsFacts {
  status: string;
  paymentStatus?: string | null;
  paymentMethod?: string | null;
  shippingMethodKind?: string | null;
  requiresShipping?: boolean | null;
  /** Paid, net of refunds. */
  paidAmount?: number | null;
  refundedAmount?: number | null;
  /** Money banks withdrew in disputes and kept. */
  disputedAmount?: number | null;
  /** A dispute the bank has not decided. */
  disputeOpen?: boolean | null;
}

const CLOSED = new Set(["cancelled", "refunded", "returned", "incomplete"]);
const CASH_DUE = { delivery: "dueOnDelivery", pickup: "dueAtPickup", service: "dueOnService" } as const;

export function isClosedOrderStatus(status: string): boolean {
  return CLOSED.has(status.trim().toLowerCase());
}

/** The order's payment in one word id, or null for a payment status the platform does not write. */
export function orderPaymentWord(order: OrderPaymentWordsFacts): OrderPaymentWord | null {
  if (order.disputeOpen) return "disputeOpen";
  const disputed = Number(order.disputedAmount ?? 0);
  if (disputed > 0) {
    if (disputed < Number(order.paidAmount ?? 0)) return "partlyLostToDispute";
    return Number(order.refundedAmount ?? 0) > 0 ? "partlyLostRestRefunded" : "lostToDispute";
  }
  const status = (order.paymentStatus ?? "").trim().toLowerCase();
  if (!(PAYMENT_STATUSES as readonly string[]).includes(status)) return null;
  const payment = status as PaymentStatusValue;
  if ((payment === "unpaid" || payment === "failed") && isClosedOrderStatus(order.status)) return "nothingDue";
  if (payment === "unpaid" && order.paymentMethod === "cod") return CASH_DUE[cashCollectionPoint(order)];
  return payment;
}

/** The export's English words (the orders CSV is written in English). */
export const ORDER_PAYMENT_WORDS_EN: Readonly<Record<OrderPaymentWord, string>> = {
  unpaid: "Unpaid",
  partial: "Partly paid",
  paid: "Paid",
  partially_refunded: "Partially refunded",
  refunded: "Refunded",
  failed: "Failed",
  dueOnDelivery: "Due on delivery",
  dueAtPickup: "Due at pickup",
  dueOnService: "Due on service",
  nothingDue: "Nothing due",
  disputeOpen: "Dispute open",
  lostToDispute: "Lost to dispute",
  partlyLostToDispute: "Partly lost to dispute",
  partlyLostRestRefunded: "Partly lost to dispute, rest refunded",
};
