import {
  OrderStatus as OrderStatusValues,
  type OrderStatus,
} from "~/types/api-responses";

const ADMIN_STATUS_TRANSITIONS: Readonly<Partial<Record<OrderStatus, readonly OrderStatus[]>>> = {
  incomplete: ["pending", "cancelled"],
  pending: ["processing", "confirmed", "cancelled"],
  processing: ["confirmed", "cancelled"],
  confirmed: ["shipped", "cancelled"],
  shipped: ["delivered"],
  delivered: ["completed"],
  completed: [],
  cancelled: [],
  returned: [],
  refunded: [],
  partially_refunded: [],
};

export const WORKFLOW_OWNED_ORDER_STATUSES = new Set([
  "returned",
  "refunded",
  "partially_refunded",
]);

export function isAdminOrderStatus(status: string): status is OrderStatus {
  return Object.values(OrderStatusValues).includes(status as OrderStatus);
}

export function getAdminOrderStatusTransitions(status: string): OrderStatus[] {
  const normalized = status.toLowerCase();
  if (!isAdminOrderStatus(normalized)) return [];
  return [...(ADMIN_STATUS_TRANSITIONS[normalized] ?? [])].filter(
    (candidate) => !WORKFLOW_OWNED_ORDER_STATUSES.has(candidate),
  );
}
