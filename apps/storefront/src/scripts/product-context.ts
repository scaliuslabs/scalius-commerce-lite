// `context.product` for app islands on a product page: the store's buy form
// as the buyer has it now, so an app never depends on the form's markup.
// The product controller (components/product/scripts/product-controller.ts)
// is its one source: it publishes its state here once it has applied a
// change, in the frame that shows it (the form, its hidden SKU field and the
// gallery's photo), so a listener runs after the store has applied the
// change and `state()` then equals the listener's state. Until the
// controller runs, the state is the form as the server drew it.
import type { StorefrontIslandContext, StorefrontProductState } from "@scalius/shared/plugins/storefront-protocol";
import { BUYER_INPUT_FIELD_PREFIX } from "@/components/product/lib/buyer-inputs";

type ProductContext = NonNullable<StorefrontIslandContext["product"]>;
type Listener = (state: StorefrontProductState) => void;

interface ProductStore {
  /** The controller's last state; null until it first publishes. */
  state: StorefrontProductState | null;
  listeners: Set<Listener>;
}

const stores = new WeakMap<Document, ProductStore>();

function storeOf(root: Document): ProductStore {
  let store = stores.get(root);
  if (!store) {
    store = { state: null, listeners: new Set() };
    stores.set(root, store);
  }
  return store;
}

function buyForm(root: Document): HTMLFormElement | null {
  // Host-only markers (the sanitizer strips `data-sx-*` from app markup): a skin cannot stand in for them.
  return root.querySelector<HTMLFormElement>("[data-sx-product-summary] form[data-sx-buy-form]");
}

/** Each reader gets its own copy: an island cannot change the store's state. */
function copy(state: StorefrontProductState): StorefrontProductState {
  return { ...state, inputs: { ...state.inputs } };
}

/** The buy form as the server drew it: its SKU field, quantity, inputs, purchase option and Add to cart button. */
function drawnState(form: HTMLFormElement): StorefrontProductState {
  const summary = form.closest("[data-sx-product-summary]")!;
  const variant = form.querySelector<HTMLInputElement>('input[type="hidden"][name="variant"]')?.value.trim() ?? "";
  const quantityInput = summary.querySelector("#quantity");
  const quantity = Number.parseInt(quantityInput instanceof HTMLInputElement ? quantityInput.value : "1", 10);
  const inputs: Record<string, string> = {};
  for (const element of Array.from(form.elements)) {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) continue;
    if (!element.name.startsWith(BUYER_INPUT_FIELD_PREFIX)) continue;
    const key = element.name.slice(BUYER_INPUT_FIELD_PREFIX.length);
    inputs[key] = element instanceof HTMLInputElement && element.type === "checkbox" ? (element.checked ? "true" : "") : element.value;
  }
  const option = summary.querySelector<HTMLInputElement>('[data-product-purchase-options] input[name="purchaseOption"]:checked')?.value ?? "";
  const add = summary.querySelector('[data-action="add-to-cart"]');
  return {
    variantId: variant || null,
    quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : 1,
    inputs,
    purchaseOption: option || null,
    available: Boolean(variant) && add instanceof HTMLButtonElement && !add.disabled,
    busy: false,
    error: null,
  };
}

/**
 * The product controller's state, after it has applied a change: listeners
 * whose last state differs hear it now. One listener's failure stops only
 * that listener's call.
 */
export function publishProductState(state: StorefrontProductState, root: Document = document): void {
  const store = storeOf(root);
  store.state = copy(state);
  for (const listener of [...store.listeners]) {
    try { listener(copy(state)); } catch (error) { console.warn("App product listener failed", error); }
  }
}

/** `context.product` on a product page; undefined elsewhere. */
export function productContext(root: Document = document): ProductContext | undefined {
  const form = buyForm(root);
  if (!form) return undefined;
  const store = storeOf(root);
  const state = () => copy(store.state ?? drawnState(form));
  return {
    state,
    onChange(listener) {
      let last = JSON.stringify(state());
      const heard: Listener = (next) => {
        const key = JSON.stringify(next);
        if (key === last) return;
        last = key;
        listener(next);
      };
      store.listeners.add(heard);
      return () => { store.listeners.delete(heard); };
    },
  };
}
