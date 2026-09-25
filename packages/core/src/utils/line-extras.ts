/**
 * The shared input of every per-order-line "extras" reader (Wave B §7.1).
 *
 * Extras (review state, downloads, licence keys, issued gift cards, warranty)
 * are composed at the API layer (`apps/api/src/routes/shared/order-line-extras.ts`),
 * never inside `orders`, so the four feature domains stay out of the order
 * cycle group. Each domain's `listLine*` reader takes this input and returns a
 * map keyed by order item id; the caller has already proven access to the order.
 */
export interface LineExtrasInput {
  orderId: string;
  /** The order's item ids; callers chunk at 90 or fewer before any query uses them. */
  orderItemIds: readonly string[];
  /** Buyers see their own facts; staff may see operational ones (counts, last4). */
  audience: "buyer" | "staff";
}
