// `context.product` for app islands on a product page: the store's buy form
// as the buyer has it now, so an app never depends on the form's markup.
// The product controller (components/product/scripts/product-controller.ts)
// is its one source: once it has applied a change, in the frame that shows
// it (the form, its hidden SKU field and the gallery's photo), it keeps its
// state on the form's container and fires PRODUCT_STATE_EVENT
// (components/product/scripts/island-state.ts), so a listener runs after
// the store has applied the change and `state()` then equals its state.
// Until the controller runs, the state is the form as the server drew it.
// Only pages with app islands load this.
import type { StorefrontIslandContext, StorefrontProductState } from "@scalius/shared/plugins/storefront-protocol";
import { BUYER_INPUT_FIELD_PREFIX } from "@/components/product/lib/buy-form";
import { buyFormPart, buyFormQuery, buyFormQueryAll, buyFormScopes } from "@/components/product/lib/buy-scope";
import { PRODUCT_STATE_EVENT, PRODUCT_STATE_KEY, type ProductStateHolder } from "@/components/product/scripts/island-state";

type ProductContext = NonNullable<StorefrontIslandContext["product"]>;

/** Each reader gets its own copy: an island cannot change the store's state. */
function copy(state: StorefrontProductState): StorefrontProductState {
  return { ...state, inputs: { ...state.inputs }, ...(state.purchaseOptions ? { purchaseOptions: [...state.purchaseOptions] } : {}) };
}

/** The buy form as the server drew it: its SKU field, quantity, inputs, purchase options and Add to cart button. */
function drawnState(summary: Element, form: HTMLFormElement): StorefrontProductState {
  const variant = form.querySelector<HTMLInputElement>('input[type="hidden"][name="variant"]')?.value.trim() ?? "";
  // The form's own parts (host-only roles), never an app slot's look-alikes in
  // the same container; a part a skin placed apart is still the form's.
  const scopes = buyFormScopes(summary.ownerDocument, summary);
  const quantityInput = buyFormPart(scopes, "quantity");
  const quantity = Number.parseInt(quantityInput instanceof HTMLInputElement ? quantityInput.value : "1", 10);
  const inputs: Record<string, string> = {};
  for (const element of Array.from(form.elements)) {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) continue;
    if (!element.name.startsWith(BUYER_INPUT_FIELD_PREFIX)) continue;
    const key = element.name.slice(BUYER_INPUT_FIELD_PREFIX.length);
    inputs[key] = element instanceof HTMLInputElement && element.type === "checkbox" ? (element.checked ? "true" : "") : element.value;
  }
  // One checked radio per app's group (or the one group); "none" has no value.
  const options = [...new Set(buyFormQueryAll<HTMLInputElement>(scopes, '[data-sx-buy="purchase-option"]:checked')
    .map((input) => input.value).filter(Boolean))].sort();
  // The form's own Add to cart (hidden, not gone, under `actions={false}`) says whether it can be bought.
  const add = buyFormPart(scopes, "add");
  return {
    variantId: variant || null,
    quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : 1,
    inputs,
    purchaseOption: options[0] ?? null,
    purchaseOptions: options,
    available: Boolean(variant) && add instanceof HTMLButtonElement && !add.disabled,
    busy: false,
    error: null,
  };
}

/** `context.product` on a product page; undefined elsewhere. */
export function productContext(root: Document = document): ProductContext | undefined {
  // Host-only markers (the sanitizer strips `data-sx-*` from app markup): a skin cannot stand in for them.
  const summary = root.querySelector<ProductStateHolder>("[data-sx-product-summary]");
  // The form may be a part a skin placed apart from its container (`<BuyFormPart name="inputs" />`).
  const form = summary ? buyFormQuery<HTMLFormElement>(buyFormScopes(root, summary), "form[data-sx-buy-form]") : null;
  if (!summary || !form) return undefined;
  const state = () => copy(summary[PRODUCT_STATE_KEY] ?? drawnState(summary, form));
  return {
    state,
    onChange(listener) {
      let last = JSON.stringify(state());
      const heard = (event: Event) => {
        const next = (event as CustomEvent<StorefrontProductState>).detail;
        const key = JSON.stringify(next);
        if (key === last) return;
        last = key;
        // One listener's failure stops only that listener's call.
        try { listener(copy(next)); } catch (error) { console.warn("App product listener failed", error); }
      };
      root.addEventListener(PRODUCT_STATE_EVENT, heard);
      return () => root.removeEventListener(PRODUCT_STATE_EVENT, heard);
    },
  };
}
