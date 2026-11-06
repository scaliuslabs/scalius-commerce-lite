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

/**
 * The store refused the check itself (not one line's issue): its error body
 * and status, worded for the buyer by `buyerApiErrorText` (two apps' options
 * that both price the line: `purchase_options_conflict`).
 */
export type CartLineRefusal = { refused: { payload: unknown; status?: number } };

/** The store's check of lines: its answer, its refusal, or null when it could not be reached. */
export type CartLineValidator = (items: CartValidationRequestItem[]) => Promise<CartValidationResult | CartLineRefusal | null>;

export function isCartLineRefusal(value: unknown): value is CartLineRefusal {
  return typeof value === "object" && value !== null && "refused" in value;
}

/** The line is priced by apps at checkout: it has their purchase options or line inputs. */
export function appPricedLine(item: Pick<CartValidationRequestItem, "purchaseOptions" | "properties">): boolean {
  return (item.purchaseOptions?.length ?? 0) > 0 || (item.properties ?? []).some(({ key }) => isAppScopedKey(key));
}

export async function validateNewCartLine(
  validate: CartLineValidator,
  item: CartValidationRequestItem,
): Promise<CartValidationResult | CartLineRefusal | null> {
  const first = await validate([item]);
  if (!first || isCartLineRefusal(first) || first.valid || !appPricedLine(item) || first.issues.length !== 1) return first;
  const [issue] = first.issues;
  if (issue?.code !== "price_changed" || typeof issue.currentPrice !== "number") return first;
  return validate([{ ...item, price: issue.currentPrice }]);
}

/**
 * The checked line, or null with the page's catalogue reason why not (an
 * issue's, or the store's refusal's). An app's cart rule ("at most 10 per
 * order") is not the line's problem: the cart says it and blocks checkout
 * until it holds.
 */
export function acceptedNewCartLine(
  result: CartValidationResult | CartLineRefusal | null,
): { item: CartValidationItem; message?: never } | { item?: never; message: string | null } {
  if (!result) return { message: null };
  if (isCartLineRefusal(result)) return { message: buyerApiErrorText(result.refused.payload, { status: result.refused.status }) };
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
    if (json?.success && json.data) return json.data;
    // A refusal the store answered (its error body) is worded, never read as "unreachable".
    return json && response.status < 500 ? { refused: { payload: json, status: response.status } } : null;
  } catch {
    return null;
  }
};
