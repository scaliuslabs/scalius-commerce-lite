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
export type StatusDimension = "order" | "payment" | "fulfillment";
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

export const PAYMENT_STATUS_TRANSITIONS: Record<
  PaymentStatusValue,
  readonly PaymentStatusValue[]
> = {
  unpaid: ["partial", "paid", "failed"],
  partial: ["paid", "unpaid", "refunded", "failed"],
  paid: ["partially_refunded", "refunded"],
  partially_refunded: ["refunded"],
  refunded: [],
  failed: ["unpaid", "partial", "paid"],
} as const;

export const FULFILLMENT_STATUS_TRANSITIONS: Record<
  FulfillmentStatusValue,
  readonly FulfillmentStatusValue[]
> = {
  pending: ["partial", "complete"],
  partial: ["complete", "pending"],
  complete: ["pending"],
} as const;

function getTransitionMap(
  dimension: StatusDimension,
): Record<string, readonly string[]> {
  switch (dimension) {
    case "order":
      return ORDER_STATUS_TRANSITIONS;
    case "payment":
      return PAYMENT_STATUS_TRANSITIONS;
    case "fulfillment":
      return FULFILLMENT_STATUS_TRANSITIONS;
  }
}

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
  const transitions = getTransitionMap(dimension);
  const allowed = transitions[normalizeStatusValue(currentStatus)];
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
