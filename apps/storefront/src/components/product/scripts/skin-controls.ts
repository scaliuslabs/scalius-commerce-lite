// What a product_main skin's SKU controls (`chooseVariant`, `buyVariant`,
// bound by the host) show of the buy form: the chosen SKU, stock, and an edit
// of a cart line. product-controller.ts takes their presses itself and loads
// this only on a page that has them, so a page without pays nothing for it.
import type { Variant } from "../lib/variant-state-machine";
import { SKIN_BUY_CONTROL, SKIN_CHOOSE_CONTROL } from "../lib/buy-form";

/** Brings every bound control on the page in step with the form (in each frame that shows a change, and when deferred markup enters). */
export function syncSkinControls(
  state: { purchaseBlocked: boolean; edit: unknown; variants: Variant[] },
  selected: () => Variant | null,
  stock: (variants: Variant[]) => { canPurchaseAny: boolean },
): void {
  const chosen = selected()?.id;
  for (const control of document.querySelectorAll<HTMLElement>(SKIN_CHOOSE_CONTROL)) {
    const on = chosen !== undefined && control.dataset.chooseVariant === chosen;
    control.dataset.state = on ? "selected" : "unselected";
    if (control instanceof HTMLButtonElement) control.setAttribute("aria-pressed", String(on));
    else if (on) control.setAttribute("aria-current", "true");
    else control.removeAttribute("aria-current");
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>(SKIN_BUY_CONTROL)) {
    const variant = state.variants.find((candidate) => candidate.id === button.dataset.buyVariant);
    // As the form's own buttons: off when it can't be bought, Buy now gone
    // then, and none while a cart line is edited (the form updates that line).
    button.disabled = !variant || !stock([variant]).canPurchaseAny || state.purchaseBlocked;
    button.hidden = Boolean(state.edit) || (button.dataset.buyIntent === "buy" && button.disabled);
  }
}
