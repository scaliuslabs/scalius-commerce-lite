const ADMIN_STATUS_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  incomplete: ["pending", "cancelled"],
  pending: ["processing", "confirmed", "cancelled"],
  processing: ["confirmed", "cancelled"],
  confirmed: ["shipped", "cancelled"],
  shipped: ["delivered"],
  delivered: ["completed"],
  completed: [],
  cancelled: ["pending", "confirmed"],
  returned: [],
  refunded: [],
  partially_refunded: [],
};

export const WORKFLOW_OWNED_ORDER_STATUSES = new Set([
  "returned",
  "refunded",
  "partially_refunded",
]);

export function getAdminOrderStatusTransitions(status: string): string[] {
  return [...(ADMIN_STATUS_TRANSITIONS[status.toLowerCase()] ?? [])].filter(
    (candidate) => !WORKFLOW_OWNED_ORDER_STATUSES.has(candidate),
  );
}
