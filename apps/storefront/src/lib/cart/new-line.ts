import { buyerApiErrorText } from "../buyer-api-errors";
// One line the buyer is adding, checked by the store before it joins the
// cart. It goes without a price: the store answers today's price (the apps'
// price for a line bought with their purchase options or carrying their line
// inputs), and that is the line's price, never a "price changed" refusal.
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

/** Checks one new line at the store's price (sent without one). */
export function validateNewCartLine(
  validate: CartLineValidator,
  item: Omit<CartValidationRequestItem, "price">,
): Promise<CartValidationResult | CartLineRefusal | null> {
  return validate([item]);
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
