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
  "partially_refunded",
  "incomplete",
] as const;

export const PAYMENT_STATUSES = [
  "unpaid",
  "partial",
  "paid",
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
  delivered: ["completed", "returned", "refunded", "partially_refunded"],
  completed: ["returned", "refunded", "partially_refunded"],
  cancelled: ["pending", "confirmed"],
  returned: ["refunded"],
  refunded: [],
  partially_refunded: ["refunded"],
} as const;

export const PAYMENT_STATUS_TRANSITIONS: Record<
  PaymentStatusValue,
  readonly PaymentStatusValue[]
> = {
  unpaid: ["partial", "paid", "failed"],
  partial: ["paid", "unpaid", "refunded", "failed"],
  paid: ["partial", "refunded"],
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
