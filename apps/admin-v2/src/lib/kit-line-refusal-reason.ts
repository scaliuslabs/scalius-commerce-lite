import { readAdminApiError } from "./admin-api-error";

/** The two bundle (kit) refusals a stock write or an order amendment meets. */
export type KitLineRefusalReason = "kit_stock_movement" | "kit_amended_in_part";

export const isKitLineRefusalReason = (reason: unknown): reason is KitLineRefusalReason =>
  reason === "kit_stock_movement" || reason === "kit_amended_in_part";

/**
 * A failed write the server refused with one of the two reasons (`details.reason`)
 * and the order lines it names (`details.orderItemIds`, an amendment's), or null.
 * No words: a screen loads them only when such a refusal arrives (`useKitLineSentence`).
 */
export function kitLineRefusalOf(error: unknown): { reason: KitLineRefusalReason; orderItemIds: string[] } | null {
  const details = readAdminApiError(error)?.details as { reason?: unknown; orderItemIds?: unknown } | null | undefined;
  if (!details || typeof details !== "object" || !isKitLineRefusalReason(details.reason)) return null;
  return {
    reason: details.reason,
    orderItemIds: Array.isArray(details.orderItemIds) ? details.orderItemIds.filter((id): id is string => typeof id === "string") : [],
  };
}
