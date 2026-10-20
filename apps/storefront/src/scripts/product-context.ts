// `context.product` for app islands on a product page: the store's buy form
// as the buyer has it now (the chosen SKU, the quantity, the buyer input
// answers), read here, in the store's own code, so an app never depends on
// the form's markup. The product controller sets the SKU and quantity in
// place as the buyer chooses, so a change is read after each input, change or
// click inside the forms has been handled.
import type { StorefrontIslandContext, StorefrontProductState } from "@scalius/shared/plugins/storefront-protocol";
import { BUYER_INPUT_FIELD_PREFIX } from "@/components/product/lib/buyer-inputs";

type ProductContext = NonNullable<StorefrontIslandContext["product"]>;

function buyForm(root: Document): HTMLFormElement | null {
  return root.querySelector<HTMLFormElement>("form[data-product-buy-form]");
}

/** The buy form's state now; null off a product page. */
export function readProductState(root: Document = document): StorefrontProductState | null {
  const form = buyForm(root);
  if (!form) return null;
  const variant = form.querySelector<HTMLInputElement>('input[name="variant"]')?.value.trim() ?? "";
  const quantity = Number.parseInt(root.getElementById("quantity") instanceof HTMLInputElement ? (root.getElementById("quantity") as HTMLInputElement).value : "1", 10);
  const inputs: Record<string, string> = {};
  const answers = root.querySelector<HTMLFormElement>("form[data-buyer-inputs]");
  if (answers) {
    for (const element of Array.from(answers.elements)) {
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) continue;
      if (!element.name.startsWith(BUYER_INPUT_FIELD_PREFIX)) continue;
      const key = element.name.slice(BUYER_INPUT_FIELD_PREFIX.length);
      inputs[key] = element instanceof HTMLInputElement && element.type === "checkbox" ? (element.checked ? "true" : "") : element.value;
    }
  }
  return { variantId: variant || null, quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : 1, inputs };
}

/** `context.product` on a product page; undefined elsewhere. */
export function productContext(root: Document = document): ProductContext | undefined {
  if (!buyForm(root)) return undefined;
  return {
    state: () => readProductState(root) ?? { variantId: null, quantity: 1, inputs: {} },
    onChange(listener) {
      let last = JSON.stringify(readProductState(root));
      let queued = false;
      const check = () => {
        queued = false;
        const state = readProductState(root);
        const next = JSON.stringify(state);
        if (!state || next === last) return;
        last = next;
        listener(state);
      };
      // After the store's own handlers for the same event have run.
      const schedule = (event: Event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target?.closest("form[data-product-buy-form], form[data-buyer-inputs], [data-product-summary], #quantity") || queued) return;
        queued = true;
        setTimeout(check, 0);
      };
      const events = ["input", "change", "click"] as const;
      for (const type of events) root.addEventListener(type, schedule, true);
      return () => { for (const type of events) root.removeEventListener(type, schedule, true); };
    },
  };
}
