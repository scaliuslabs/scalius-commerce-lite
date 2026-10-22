import type { CartValidationIssue } from "@/lib/api/orders";

/**
 * A "only N left" answer the cart has already followed: the variant's lines
 * now ask for no more than is left. The check that said it read an older
 * cart (the add asked for 12, the line was capped to the 3 left), so showing
 * it would contradict the line beside it and hold checkout back (buyer QA m2).
 */
export function isFollowedQuantityIssue(
  issue: Pick<CartValidationIssue, "code" | "action" | "availableQuantity" | "variantId">,
  lineQuantity: number,
  variantQuantity: number = lineQuantity,
): boolean {
  return issue.code === "quantity_unavailable"
    && issue.action === "reduce_quantity"
    && typeof issue.availableQuantity === "number"
    && lineQuantity >= 1
    && variantQuantity <= issue.availableQuantity;
}

/** The units every line of each variant asks for together. */
export function quantitiesByVariant(items: Record<string, { variantId?: string; quantity: number }>): Map<string, number> {
  const totals = new Map<string, number>();
  for (const item of Object.values(items)) {
    if (item.variantId) totals.set(item.variantId, (totals.get(item.variantId) ?? 0) + item.quantity);
  }
  return totals;
}
