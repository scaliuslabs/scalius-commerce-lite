// The cart's drawn controls (remove, the quantity steppers, an issue's fix,
// the bulk repairs, a line's edit link) name the page function they call and
// the line it acts on in data attributes; one delegated listener calls it. No
// inline `onclick`: the page's Content-Security-Policy runs no inline handler.

/** The page functions a cart control may call (lib/cart/client.ts defines them on `window`). */
export type CartCall =
  | "removeFromCart"
  | "updateCartQuantity"
  | "editCartLine"
  | "removeCartIssueItem"
  | "reduceCartIssueItem"
  | "refreshCartIssueItem"
  | "bulkRemoveCartIssueItems"
  | "bulkReduceCartIssueItems"
  | "bulkRefreshCartIssueItems";

const CALLS: ReadonlySet<string> = new Set<CartCall>([
  "removeFromCart",
  "updateCartQuantity",
  "editCartLine",
  "removeCartIssueItem",
  "reduceCartIssueItem",
  "refreshCartIssueItem",
  "bulkRemoveCartIssueItems",
  "bulkReduceCartIssueItems",
  "bulkRefreshCartIssueItems",
]);

function attribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The attributes (with a leading space) that make a drawn control call `call` for a line. */
export function cartCallAttributes(call: CartCall, cartKey?: string, quantity?: number): string {
  return ` data-cart-call="${call}"`
    + (cartKey === undefined ? "" : ` data-cart-key="${attribute(cartKey)}"`)
    + (quantity === undefined ? "" : ` data-cart-quantity="${quantity}"`);
}

type CartCallFunction = (cartKey?: string, quantity?: number) => unknown;

let installed = false;

/**
 * Installs the one listener for the document. A call that answers `false`
 * (the edit link when it cannot hand the line over) keeps the link's own
 * navigation from happening, as the inline handler's `return` did.
 */
export function installCartCalls(target: Document = document): void {
  if (installed) return;
  installed = true;
  target.addEventListener("click", (event) => {
    const control = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-cart-call]") : null;
    const name = control?.dataset.cartCall;
    if (!control || !name || !CALLS.has(name) || control.matches(":disabled")) return;
    const call = (window as unknown as Record<string, CartCallFunction | undefined>)[name];
    if (typeof call !== "function") return;
    const quantity = control.dataset.cartQuantity;
    const result = call(control.dataset.cartKey, quantity === undefined ? undefined : Number(quantity));
    if (result === false) event.preventDefault();
  });
}
