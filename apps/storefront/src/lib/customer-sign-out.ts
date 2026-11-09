// Signing out on a shared device: the next person must not find the account's
// cart, checkout details or payment in progress. A guest's cart (built before
// signing in, nothing added while signed in) belongs to the device and stays.
// Every sign-out path (the account page, the sign-in dialog) goes through here.
import { logoutCustomer } from "@/lib/api/customer-auth";
import { browserPushDeps, releasePushForSignOut } from "./account-push";
import { clearCart, syncCartFromStorage } from "@/store/cart";
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

/**
 * Ends every checkout key this browser holds, and the cart when it is the
 * account's (lines were added while signed in): a guest's cart belongs to
 * the device and stays for whoever uses it next, as it was before sign-in.
 */
export function clearBrowserShoppingState(): void {
  try {
    if (syncCartFromStorage().accountCart) clearCart();
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
  await releasePushForSignOut(browserPushDeps(window));
  await logoutCustomer();
  clearBrowserShoppingState();
  window.dispatchEvent(new CustomEvent("customer-logout"));
}
