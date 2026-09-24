import type { BadgeVariant } from "~/components/ui/badge";

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

/** Orders whose story is over: only the status badge is true, so payment/fulfillment badges hide. */
const CLOSED_ORDER_STATUSES = new Set(["cancelled", "refunded", "returned", "incomplete"]);

/**
 * Which badges describe an order without contradicting each other. A cancelled
 * order reads "Cancelled", never also "Unfulfilled" or "Unpaid".
 */
export function orderBadgeVisibility(order: { status: string }): { payment: boolean; fulfillment: boolean } {
  const closed = CLOSED_ORDER_STATUSES.has(order.status.trim().toLowerCase());
  return { payment: !closed, fulfillment: !closed };
}
