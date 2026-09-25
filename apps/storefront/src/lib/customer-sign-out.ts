// Signing out on a shared device: the next person must not find the previous
// buyer's cart, checkout details or payment in progress. Every sign-out path
// (the account page, the sign-in dialog) goes through here.
import { logoutCustomer } from "@/lib/api/customer-auth";
import { clearCart } from "@/store/cart";
import {
  clearCheckoutAttemptSession,
  clearHostedPaymentRecoverySession,
} from "@/lib/checkout/session-state";
import { clearCartLineEdit } from "@/lib/cart/line-edit";

/**
 * Browser checkout state with no clear call of its own: the cart repair note,
 * a Buy now hand-off, and the submitted cart / last order of this tab.
 */
const CHECKOUT_SESSION_KEYS = [
  "scalius_cart_repair_state",
  "quickBuyData",
  "scalius_submitted_cart",
  "scalius_last_order",
] as const;

/** Empties the cart and every checkout key this browser holds. */
export function clearBrowserShoppingState(): void {
  try {
    clearCart();
  } catch {
    // A cart that can't be read has nothing to show the next person.
  }
  clearCheckoutAttemptSession();
  clearHostedPaymentRecoverySession();
  clearCartLineEdit();
  for (const key of CHECKOUT_SESSION_KEYS) {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // Storage blocked: nothing was kept.
    }
  }
}

/** Ends the session, clears the browser's shopping state, then tells the page. */
export async function signOutCustomer(): Promise<void> {
  await logoutCustomer();
  clearBrowserShoppingState();
  window.dispatchEvent(new CustomEvent("customer-logout"));
}
