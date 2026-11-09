// How long the buyer's typed checkout details (name, phone, address) stay in
// this browser. They are shared by the browser's tabs (localStorage, beside
// the cart), so on a shared phone they must not outlive the checkout: they
// go when the cart empties, when the order is placed, on sign-out or an
// account switch, and after two hours without checkout activity (sliding: a
// read or write in the checkout keeps them). The cart store and the checkout
// both use this module, so it imports nothing.

export const CHECKOUT_FORM_DRAFT_KEY = "scalius_checkout_form_draft";

/** Two hours since the buyer last touched the checkout. */
export const CHECKOUT_FORM_DRAFT_IDLE_MS = 2 * 60 * 60 * 1000;

/** Removes the typed details from this browser (every tab). */
export function dropCheckoutFormDraft(): void {
  try {
    localStorage.removeItem(CHECKOUT_FORM_DRAFT_KEY);
  } catch {
    // Storage blocked: nothing was kept.
  }
}
