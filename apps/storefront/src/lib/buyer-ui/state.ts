import { parseCheckoutAttributeValues } from "./checkout-attributes";
import { STOREFRONT_UI_SLOT_PAGES, type StorefrontUiSlot } from "@scalius/shared/plugins/storefront-protocol";

/**
 * Whether a UI slot is in the checkout form (the cart page and the payment
 * step): editable fields belong only there, where a required answer is
 * checked and the form carries it.
 */
export function isCheckoutSlot(target: StorefrontUiSlot): boolean {
  return STOREFRONT_UI_SLOT_PAGES[target] === "checkout";
}

/**
 * Whether a UI slot is on a cart surface (the checkout form or the cart
 * drawer): cart operations (add a line, apply a code, set an answer) run
 * only there. The drawer shows a field's current answer, read-only.
 */
export function isCartSlot(target: StorefrontUiSlot): boolean {
  return isCheckoutSlot(target) || STOREFRONT_UI_SLOT_PAGES[target] === "cart_drawer";
}

const STORAGE_KEY = "scalius:buyer-attributes";

/** Buyer inputs live in the tab and request bodies, never in URLs or analytics. */
export function readBuyerAttributes(): Record<string, string> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw || raw.length > 8192) return {};
    return parseCheckoutAttributeValues(JSON.parse(raw)) ?? {};
  } catch { return {}; }
}

export function writeBuyerAttribute(key: string, value: string): boolean {
  const answers = parseCheckoutAttributeValues({ ...readBuyerAttributes(), [key]: value });
  if (!answers) return false;
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(answers)); return true; }
  catch { return false; }
}

export function clearBuyerAttributes(): void {
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* Storage may be unavailable. */ }
}
