import type { OrderSupportRequest } from "./types";

export type Resolution = "under_review" | "approved" | "rejected" | "completed";

/**
 * Answers a merchant can give. Accepting a cancellation cancels the order,
 * so it needs the right to cancel orders.
 */
export function resolutionsFor(request: Pick<OrderSupportRequest, "status" | "type">, canCancelOrders: boolean): Resolution[] {
  const options: Resolution[] = request.status === "submitted"
    ? ["under_review", "approved", "rejected", "completed"]
    : request.status === "under_review"
      ? ["approved", "rejected", "completed"]
      : request.status === "approved" ? ["completed"] : [];
  return request.type === "cancel_pre_shipment" && !canCancelOrders
    ? options.filter((option) => option !== "approved")
    : options;
}
