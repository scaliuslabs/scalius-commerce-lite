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
export type OrderCodAction = "collected" | "failed" | "returned";

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

const STATUS_TRANSITIONS: Record<StatusDimension, Record<string, readonly string[]>> = {
  order: ORDER_STATUS_TRANSITIONS,
};

export function normalizeStatusValue(status: string): string {
  return status.trim().toLowerCase();
}

export function normalizeOrderStatus(status: string): OrderStatusValue | null {
  const normalized = normalizeStatusValue(status);
  if ((ORDER_STATUSES as readonly string[]).includes(normalized)) {
    return normalized as OrderStatusValue;
  }
  return null;
}

export function getAvailableTransitions(
  dimension: StatusDimension,
  currentStatus: string,
): string[] {
  const allowed = STATUS_TRANSITIONS[dimension][normalizeStatusValue(currentStatus)];
  if (!allowed) return [];
  return [...allowed];
}

export function getAvailableOrderStatusTransitions(
  currentStatus: string,
): string[] {
  return getAvailableTransitions("order", currentStatus);
}

export function canTransitionTo(
  dimension: StatusDimension,
  currentStatus: string,
  newStatus: string,
): boolean {
  const current = normalizeStatusValue(currentStatus);
  const next = normalizeStatusValue(newStatus);
  if (current === next) return true;
  return getAvailableTransitions(dimension, current).includes(next);
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
