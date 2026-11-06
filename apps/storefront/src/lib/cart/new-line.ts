import { buyerApiErrorText } from "../buyer-api-errors";
// One line the buyer is adding, checked by the store before it joins the
// cart. A line bought with apps' purchase options (a subscription), or
// carrying an app's line inputs (a gift message it charges for), is priced
// by those apps at checkout, so the product page's price is only the first
// guess: when the store's only objection is the price, the line is checked
// once more at the price the store answered, and that is its price.
import { isAppScopedKey } from "@scalius/shared/plugins/ids";
import type {
  CartValidationItem,
  CartValidationRequestItem,
  CartValidationResult,
} from "@/lib/api/orders";
import { currentPresence } from "@/lib/presence-url";

export type CartLineValidator = (items: CartValidationRequestItem[]) => Promise<CartValidationResult | null>;

/** The line is priced by apps at checkout: it has their purchase options or line inputs. */
export function appPricedLine(item: Pick<CartValidationRequestItem, "purchaseOptions" | "properties">): boolean {
  return (item.purchaseOptions?.length ?? 0) > 0 || (item.properties ?? []).some(({ key }) => isAppScopedKey(key));
}

export async function validateNewCartLine(
  validate: CartLineValidator,
  item: CartValidationRequestItem,
): Promise<CartValidationResult | null> {
  const first = await validate([item]);
  if (!first || first.valid || !appPricedLine(item) || first.issues.length !== 1) return first;
  const [issue] = first.issues;
  if (issue?.code !== "price_changed" || typeof issue.currentPrice !== "number") return first;
  return validate([{ ...item, price: issue.currentPrice }]);
}

/**
 * The checked line, or null with the page's catalogue reason why not. An app's
 * cart rule ("at most 10 per order") is not the line's problem: the cart says
 * it and blocks checkout until it holds.
 */
export function acceptedNewCartLine(
  result: CartValidationResult | null,
): { item: CartValidationItem; message?: never } | { item?: never; message: string | null } {
  if (!result) return { message: null };
  const item = result.items[0];
  if (result.issues.length > 0 || !item) return { message: result.issues[0] ? buyerApiErrorText(result.issues[0]) : null };
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
