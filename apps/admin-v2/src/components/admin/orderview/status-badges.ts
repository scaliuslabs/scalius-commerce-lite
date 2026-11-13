// The badges an order shows, one derivation per concept, used by every
// surface that shows them (the order page's title, its Payment card and
// hand-over cards, the orders list's table and phone cards). Each concept has
// a case for every state its column can hold, typed exhaustively over
// `@scalius/shared/order-state`, so a new state does not compile until it has
// its badge (order-badge-matrix.test.ts tables every combination).
import type { BadgeVariant } from "~/components/ui/badge";
import type { FulfillmentType } from "@scalius/shared/fulfilment";
import type { FulfillmentStatusValue, OrderStatusValue, PaymentStatusValue } from "@scalius/shared/order-state";
import { cashDueKey, type OrderMessageKey, type PaymentWordsOrder } from "~/i18n/orders";

export type StatusBadgeVariant = BadgeVariant;
export type StatusKind = "order" | "payment" | "fulfillment" | "other";

/** DESIGN.md "Status → badge variant"; anything unlisted is neutral. */
const TONES: Record<StatusKind, Record<string, StatusBadgeVariant>> = {
  order: {
    delivered: "success",
    processing: "info",
    confirmed: "info",
    shipped: "info",
    returned: "warning",
    pending: "attention",
  },
  payment: { unpaid: "warning", partial: "warning", failed: "destructive" },
  fulfillment: { partial: "warning", pending: "attention" },
  // Returns, cash collection, customer requests and messages.
  other: {
    requested: "attention",
    submitted: "attention",
    under_review: "attention",
    pending: "attention",
    approved: "info",
    in_transit: "info",
    received: "success",
    collected: "success",
    sent: "success",
    delivered: "success",
    partial: "warning",
    failed: "destructive",
    dead_lettered: "destructive",
    rejected: "destructive",
  },
};

/** The one status → Badge variant rule. The label always carries the meaning. */
export function statusBadgeVariant(status: string | null | undefined, kind: StatusKind = "other"): StatusBadgeVariant {
  return TONES[kind][(status ?? "").trim().toLowerCase()] ?? "secondary";
}

/** Orders whose story is over: nothing is due on them and nothing is left to hand over. */
const CLOSED_ORDER_STATUSES: ReadonlySet<OrderStatusValue> = new Set(["cancelled", "refunded", "returned", "incomplete"]);

export function isClosedOrder(order: { status: string }): boolean {
  return CLOSED_ORDER_STATUSES.has(order.status.trim().toLowerCase() as OrderStatusValue);
}

/** A badge: its words (a key of the orders catalogue) and its tone. */
export interface OrderBadge {
  key: OrderMessageKey;
  variant: StatusBadgeVariant;
}

/** What the payment badge reads: the payment status, the method and where cash is paid, and what disputes took. */
export type PaymentBadgeOrder = PaymentWordsOrder & {
  status: string;
  paymentStatus?: string | null;
  paidAmount?: number | null;
  /** Money banks withdrew in disputes and kept (major units); absent: none. */
  disputedAmount?: number | null;
};

/**
 * The payment badge per payment status. A closed order that took no money has
 * nothing due, so it says nothing (a cancelled order never reads "Unpaid");
 * one that took money keeps saying so: a refunded order reads "Refunded" on its
 * Payment card, a cancelled paid order "Paid" (its money is still held).
 */
const PAYMENT_BADGES: Record<PaymentStatusValue, (order: PaymentBadgeOrder, closed: boolean) => OrderBadge | null> = {
  unpaid: (order, closed) => closed ? null : {
    key: order.paymentMethod === "cod" ? cashDueKey(order) : "payment.unpaid",
    variant: "warning",
  },
  partial: () => ({ key: "payment.partial", variant: "warning" }),
  paid: () => ({ key: "payment.paid", variant: "secondary" }),
  partially_refunded: () => ({ key: "payment.partially_refunded", variant: "secondary" }),
  refunded: () => ({ key: "payment.refunded", variant: "secondary" }),
  failed: (_order, closed) => closed ? null : { key: "payment.failed", variant: "destructive" },
};

/**
 * The order's payment badge, the same on its title, its Payment card and its
 * row in the list. Money a bank took back in a dispute is said first: all of
 * what was paid ("Lost to dispute") or part of it.
 */
export function paymentBadge(order: PaymentBadgeOrder): OrderBadge | null {
  const disputed = Number(order.disputedAmount ?? 0);
  if (disputed > 0) {
    return disputed >= Number(order.paidAmount ?? 0)
      ? { key: "payment.lostToDispute", variant: "destructive" }
      : { key: "payment.partlyLostToDispute", variant: "warning" };
  }
  const status = (order.paymentStatus ?? "").trim().toLowerCase();
  if (!Object.hasOwn(PAYMENT_BADGES, status)) return null;
  return PAYMENT_BADGES[status as PaymentStatusValue](order, isClosedOrder(order));
}

export interface FulfilmentBadgeOrder {
  status: string;
  fulfillmentStatus?: string | null;
  shippingMethodKind?: string | null;
  pickupReadyAt?: unknown;
}

const FULFILMENT_BADGES: Record<FulfillmentStatusValue, OrderBadge> = {
  pending: { key: "fulfillment.pending", variant: "attention" },
  partial: { key: "fulfillment.partial", variant: "warning" },
  complete: { key: "fulfillment.complete", variant: "secondary" },
};

/**
 * The order's fulfilment badge, the same on its title and its row: "Ready for
 * pickup" once staff said so, else the fulfilment status; nothing on a closed
 * order (its status badge tells the story).
 */
export function fulfilmentBadge(order: FulfilmentBadgeOrder): OrderBadge | null {
  if (isClosedOrder(order)) return null;
  const status = (order.fulfillmentStatus ?? "").trim().toLowerCase();
  if (order.shippingMethodKind === "pickup" && status !== "complete" && order.pickupReadyAt) {
    return { key: "delivery.readyForPickup", variant: "info" };
  }
  return Object.hasOwn(FULFILMENT_BADGES, status) ? FULFILMENT_BADGES[status as FulfillmentStatusValue] : null;
}

/** A hand-over card's badge (order-detail catalogue). */
export type HandOverBadgeKey = "badge.sent" | "badge.delivered" | "badge.returned" | "badge.pickedUp" | "badge.done";

const DONE_BADGES: Record<FulfillmentType, HandOverBadgeKey> = {
  ship: "badge.sent",
  pickup: "badge.pickedUp",
  service: "badge.done",
  digital: "badge.delivered",
  gift_card: "badge.delivered",
};

/**
 * One hand-over card's badge, from the parcel's own facts: a parcel the
 * courier (or your rider, by Mark delivered) delivered reads "Delivered", one
 * that came back "Returned", whatever the order did since (a refund or a
 * return never turns a delivered parcel back into "Sent"). An open delivered
 * order's parcels without a delivered record still read delivered (staff
 * marked the order delivered); the Delivery card shows the courier's word.
 */
export function handOverBadge(
  type: FulfillmentType,
  fulfillment: { status: string; tracking: { status: string } | null } | null,
  order: { status: string },
): HandOverBadgeKey {
  if (type !== "ship" || fulfillment?.status === "voided") return DONE_BADGES[type];
  const parcel = (fulfillment?.tracking?.status ?? "").trim().toLowerCase();
  if (parcel === "delivered") return "badge.delivered";
  if (parcel === "returned") return "badge.returned";
  const status = order.status.trim().toLowerCase();
  return status === "delivered" || status === "completed" ? "badge.delivered" : "badge.sent";
}

/** The order status badge (a closed order's title, every phone card). */
export function orderStatusBadge(order: { status: string }): OrderBadge {
  const status = order.status.trim().toLowerCase();
  return { key: `status.${status}` as OrderMessageKey, variant: statusBadgeVariant(status, "order") };
}

/**
 * The payment and fulfilment badges a one-line strip shows beside or instead
 * of the order status: never the status's own words twice (a refunded order
 * reads "Refunded" once), never a fulfilment on a closed order.
 */
export function paymentAndFulfilmentBadges(order: PaymentBadgeOrder & FulfilmentBadgeOrder): OrderBadge[] {
  const status = order.status.trim().toLowerCase();
  const payment = paymentBadge(order);
  const fulfilment = fulfilmentBadge(order);
  return [payment && payment.key !== `payment.${status}` ? payment : null, fulfilment]
    .filter((badge): badge is OrderBadge => badge !== null);
}

/**
 * The order page title's badges before Archived and an unread reply: the
 * status when the order's story is over, then its payment and fulfilment
 * (Shopify's order).
 */
export function orderTitleBadges(order: PaymentBadgeOrder & FulfilmentBadgeOrder): OrderBadge[] {
  return [...(isClosedOrder(order) ? [orderStatusBadge(order)] : []), ...paymentAndFulfilmentBadges(order)];
}
