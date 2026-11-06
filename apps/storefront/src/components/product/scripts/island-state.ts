// The buy form's state for app islands (`context.product`,
// scripts/product-context.ts). product-controller.ts loads this only on a
// page with app components, so a page without pays nothing for it. Once the
// controller has applied a change, in the frame that shows it, the state
// stays on the form's container and goes out with PRODUCT_STATE_EVENT on
// the document. It imports nothing, so loading it loads nothing else.
import type { StorefrontProductError, StorefrontProductState } from "@scalius/shared/plugins/storefront-protocol";
import type { LinePropertyInput } from "@scalius/shared/line-properties";
import type { Variant } from "../lib/variant-state-machine";

/** Fired on the document with the form's state (`StorefrontProductState`) as `detail`. */
export const PRODUCT_STATE_EVENT = "scalius-product-state";
/** The controller's last state, on the buy form's container (`[data-sx-product-summary]`). */
export const PRODUCT_STATE_KEY = Symbol.for("scalius.product-state");

export type ProductStateHolder = Element & { [PRODUCT_STATE_KEY]?: StorefrontProductState };

/** What the product controller lends the bridge. */
export interface IslandStateSource {
  state: { adding: boolean; purchaseBlocked: boolean; error: StorefrontProductError | null; buyerInputs: { values(): LinePropertyInput[] } | null };
  summary: Element;
  selected(): Variant | null;
  quantity(): number;
  /** The chosen apps' options, one per app, sorted by id. */
  options(): ReadonlyArray<{ id: string }>;
  stock(variants: Variant[]): { canPurchaseAny: boolean };
}

/** The publisher: call it after the form has applied a change. */
export function islandState(source: IslandStateSource): () => void {
  const { state } = source;
  return () => {
    const exact = source.selected();
    const options = source.options().map(({ id }) => id);
    const detail: StorefrontProductState = {
      variantId: exact?.id ?? null,
      quantity: source.quantity(),
      inputs: Object.fromEntries((state.buyerInputs?.values() ?? []).map(({ key, value }) => [key, value])),
      // `purchaseOption` is the first by id, for islands built before a line had one option per app.
      purchaseOption: options[0] ?? null,
      purchaseOptions: options,
      available: Boolean(exact) && !state.purchaseBlocked && source.stock([exact!]).canPurchaseAny,
      busy: state.adding,
      error: state.error,
    };
    (source.summary as ProductStateHolder)[PRODUCT_STATE_KEY] = detail;
    document.dispatchEvent(new CustomEvent(PRODUCT_STATE_EVENT, { detail }));
  };
}
