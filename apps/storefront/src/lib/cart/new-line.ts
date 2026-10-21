// One line the buyer is adding, checked by the store before it joins the
// cart. A line bought with an app's purchase option (a subscription) is
// priced by that app at checkout, so the product page's price is only the
// first guess: when the store's only objection is the price, the line is
// checked once more at the price the store answered, and that is its price.
import type {
  CartValidationItem,
  CartValidationRequestItem,
  CartValidationResult,
} from "@/lib/api/orders";
import { currentPresence } from "@/lib/presence-url";

export type CartLineValidator = (items: CartValidationRequestItem[]) => Promise<CartValidationResult | null>;

export async function validateNewCartLine(
  validate: CartLineValidator,
  item: CartValidationRequestItem,
): Promise<CartValidationResult | null> {
  const first = await validate([item]);
  if (!first || first.valid || !item.purchaseOption || first.issues.length !== 1) return first;
  const [issue] = first.issues;
  if (issue?.code !== "price_changed" || typeof issue.currentPrice !== "number") return first;
  return validate([{ ...item, price: issue.currentPrice }]);
}

/**
 * The checked line, or null with the store's words for why not. An app's
 * cart rule ("at most 10 per order") is not the line's problem: the cart says
 * it and blocks checkout until it holds.
 */
export function acceptedNewCartLine(
  result: CartValidationResult | null,
): { item: CartValidationItem; message?: never } | { item?: never; message: string | null } {
  if (!result) return { message: null };
  const item = result.items[0];
  if (result.issues.length > 0 || !item) return { message: result.issues[0]?.message ?? null };
  return { item };
}

/** The browser's check, through this origin (the buyer's session prices segment and contract lines). */
export const validateCartLinesInBrowser: CartLineValidator = async (items) => {
  try {
    const presence = currentPresence();
    const response = await fetch("/api/checkout/validate-cart", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, ...(presence ? { presence } : {}) }),
    });
    const json = await response.json().catch(() => null) as { success?: boolean; data?: CartValidationResult } | null;
    return json?.success && json.data ? json.data : null;
  } catch {
    return null;
  }
};
