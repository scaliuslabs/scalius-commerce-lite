import { defineMachine, movesByTarget } from "./machine";

export const ORDER_STATUSES = [
  "pending",
  "processing",
  "confirmed",
  "shipped",
  "delivered",
  "completed",
  "cancelled",
  "returned",
  "refunded",
  "incomplete",
] as const;

export const PAYMENT_STATUSES = [
  "unpaid",
  "partial",
  "paid",
  "partially_refunded",
  "refunded",
  "failed",
] as const;

export const FULFILLMENT_STATUSES = [
  "pending",
  "partial",
  "complete",
] as const;

export type OrderStatusValue = (typeof ORDER_STATUSES)[number];
export type PaymentStatusValue = (typeof PAYMENT_STATUSES)[number];
export type FulfillmentStatusValue = (typeof FULFILLMENT_STATUSES)[number];
/**
 * Only the order lifecycle has transitions. Payment and fulfilment status are
 * projections of their ledgers (the order's payments, the fulfilment lines):
 * computed from the rows, never moved edge by edge.
 */
export type StatusDimension = "order";
export const COD_STATUSES = ["pending", "collected", "failed", "returned"] as const;
export type CodStatusValue = (typeof COD_STATUSES)[number];

/**
 * The cash of a cash-on-delivery order, by what staff record at the door.
 * Collected cash is final here: it goes back only as a refund, never by
 * recording the parcel as failed or returned to sender afterwards.
 */
export const COD_MACHINE = defineMachine({
  name: "cash on delivery",
  states: COD_STATUSES,
  initial: ["pending"],
  final: ["collected", "returned"],
  moves: {
    collected: { from: ["pending", "failed"], to: "collected" },
    // Each failed attempt is recorded, so a failed delivery can fail again.
    failed: { from: ["pending", "failed"], to: "failed" },
    returned: { from: ["pending", "failed"], to: "returned" },
  },
});
export type OrderCodAction = keyof typeof COD_MACHINE.moves;

const ORDER_COD_ACTION_STATUSES: Readonly<
  Record<OrderCodAction, readonly OrderStatusValue[]>
> = {
  // Cash changes hands only at the door: the order must be out for delivery.
  collected: ["shipped", "delivered"],
  failed: ["shipped"],
  returned: ["shipped", "delivered"],
};

export const ORDER_STATUS_TRANSITIONS: Record<
  OrderStatusValue,
  readonly OrderStatusValue[]
> = {
  incomplete: ["pending", "cancelled"],
  pending: ["processing", "confirmed", "cancelled"],
  processing: ["confirmed", "cancelled"],
  confirmed: ["shipped", "delivered", "cancelled"],
  // A courier handoff can be rebuilt without cancelling the order.
  shipped: ["confirmed", "delivered", "returned", "cancelled"],
  delivered: ["completed", "returned", "refunded"],
  completed: ["returned", "refunded"],
  cancelled: [],
  returned: ["refunded"],
  refunded: [],
} as const;

/**
 * The order lifecycle. A checkout places an order `incomplete` (waiting for
 * its payment) or `pending`; staff and the point of sale place it `confirmed`.
 */
export const ORDER_MACHINE = defineMachine({
  name: "order",
  states: ORDER_STATUSES,
  initial: ["incomplete", "pending", "confirmed"],
  final: ["cancelled", "refunded"],
  moves: movesByTarget(ORDER_STATUS_TRANSITIONS),
});

export function normalizeStatusValue(status: string): string {
  return status.trim().toLowerCase();
}

export function normalizeOrderStatus(status: string): OrderStatusValue | null {
  const normalized = normalizeStatusValue(status);
  return ORDER_MACHINE.is(normalized) ? normalized : null;
}

/** The next statuses, in the order `ORDER_STATUS_TRANSITIONS` lists them (menus show them so). */
export function getAvailableTransitions(
  _dimension: StatusDimension,
  currentStatus: string,
): string[] {
  const current = normalizeOrderStatus(currentStatus);
  return current ? [...ORDER_STATUS_TRANSITIONS[current]] : [];
}

export function getAvailableOrderStatusTransitions(
  currentStatus: string,
): string[] {
  return getAvailableTransitions("order", currentStatus);
}

export function canTransitionTo(
  _dimension: StatusDimension,
  currentStatus: string,
  newStatus: string,
): boolean {
  const current = normalizeStatusValue(currentStatus);
  const next = normalizeStatusValue(newStatus);
  return current === next || ORDER_MACHINE.reaches(current, next);
}

export interface OrderCodActionContext {
  /**
   * `orders.requires_shipping`. An order with nothing to ship (pickup or
   * service) collects cash at the counter or at the service, so `collected`
   * is also allowed once it is confirmed. Defaults to true.
   */
  requiresShipping?: boolean;
}

export function canProcessOrderCodAction(
  currentStatus: string,
  action: OrderCodAction,
  context: OrderCodActionContext = {},
): boolean {
  const current = normalizeOrderStatus(currentStatus);
  if (current === null) return false;
  if (ORDER_COD_ACTION_STATUSES[action].includes(current)) return true;
  return action === "collected"
    && context.requiresShipping === false
    && current === "confirmed";
}
