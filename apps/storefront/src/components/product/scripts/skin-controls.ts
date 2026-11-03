// A product_main skin's SKU controls (`chooseVariant`, `buyVariant`), which
// the host bound to the buy form (lib/extensions/purchase-controls.ts; only
// the host writes `data-sx-*`). product-controller.ts loads this only on a
// page that has them, so a page without pays nothing for it, and stays the
// one authority: a choice goes through its selection, a buy through its add,
// and the controls show its state. It imports nothing, so loading it loads
// nothing else.
import type { Variant } from "../lib/variant-state-machine";

const CHOOSE_CONTROL = "[data-sx-bound][data-choose-variant]";
const BUY_CONTROL = "[data-sx-bound][data-buy-variant]";

/** What the product controller lends the controls. */
export interface SkinControlHost {
  state: { adding: boolean; purchaseBlocked: boolean; edit: unknown; variants: Variant[] };
  /** Chooses a whole SKU through the form's selection; false for one the page does not sell. */
  choose(variantId: string): boolean;
  /** The form's own add (Buy now: `redirect`), with `source` showing its busy state and taking a problem's focus. */
  add(redirect: boolean, source: HTMLElement): Promise<void>;
  selected(): Variant | null;
  stock(variants: Variant[]): { canPurchaseAny: boolean };
}

/**
 * Binds the page's controls to the form: the nearest bound control is the
 * one pressed (a buy button inside a choice card buys). A buy button
 * chooses its SKU, is taken at once (a second press is refused), then,
 * after the frame that shows the SKU (and tells islands), runs the form's
 * add; while a cart line is edited the form's "Update cart" is the only
 * way to buy. Returns `sync`, which the controller calls in each frame that
 * shows a change and when deferred markup enters the page.
 */
export function bindSkinControls(host: SkinControlHost, signal: AbortSignal): { sync(): void } {
  const { state } = host;
  const soldOut = (variantId: string | undefined) => {
    const variant = state.variants.find((candidate) => candidate.id === variantId);
    return !variant || !host.stock([variant]).canPurchaseAny;
  };
  const sync = () => {
    const selected = host.selected()?.id;
    for (const control of document.querySelectorAll<HTMLElement>(CHOOSE_CONTROL)) {
      const chosen = selected !== undefined && control.dataset.chooseVariant === selected;
      control.dataset.state = chosen ? "selected" : "unselected";
      if (control instanceof HTMLButtonElement) control.setAttribute("aria-pressed", String(chosen));
      else if (chosen) control.setAttribute("aria-current", "true");
      else control.removeAttribute("aria-current");
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>(BUY_CONTROL)) {
      // As the form's own buttons: off when it can't be bought, Buy now gone
      // then, and none while a cart line is edited (the form updates that line).
      button.disabled = soldOut(button.dataset.buyVariant) || state.purchaseBlocked;
      button.hidden = Boolean(state.edit) || (button.dataset.buyIntent === "buy" && button.disabled);
    }
  };
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>(BUY_CONTROL);
    const choice = event.target.closest<HTMLElement>(CHOOSE_CONTROL);
    if (button && (!choice || choice.contains(button))) {
      event.preventDefault();
      if (button.disabled || state.adding || state.purchaseBlocked || state.edit) return;
      if (!host.choose(button.dataset.buyVariant ?? "")) return;
      state.adding = true;
      requestAnimationFrame(() => {
        state.adding = false;
        void host.add(button.dataset.buyIntent === "buy", button);
      });
      return;
    }
    if (!choice) return;
    // A new tab or window follows the link itself.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    host.choose(choice.dataset.chooseVariant ?? "");
  }, { signal });
  return { sync };
}
