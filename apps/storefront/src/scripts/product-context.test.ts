// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import type { StorefrontIslandContext, StorefrontProductState } from "@scalius/shared/plugins/storefront-protocol";
import { productContext } from "./product-context";

const page = `
  <div data-product-summary>
    <form id="buy" method="post" action="/buy/ring" data-product-buy-form><input type="hidden" name="variant" value=""></form>
    <fieldset><input type="radio" name="option-size" value="m"><input type="radio" name="option-size" value="l"></fieldset>
    <form method="post" action="/buy/ring" data-buyer-inputs>
      <input type="text" name="property.engraving" value="">
      <input type="checkbox" name="property.gift_wrap">
    </form>
    <input type="text" id="quantity" name="quantity" value="1" form="buy">
  </div>`;

/** A configurator island as an app writes it: it previews the engraving for the chosen variant. */
function engravingIsland(element: HTMLElement, context: StorefrontIslandContext): () => void {
  const draw = (state: StorefrontProductState) => {
    element.textContent = `${state.variantId ?? "choose a size"}: ${state.inputs.engraving || "(no text)"} x${state.quantity}`;
  };
  draw(context.product!.state());
  return context.product!.onChange(draw);
}

/** What the store's product controller does when a size is picked: it sets the SKU in place. */
function pickSize(sku: string) {
  const radio = document.querySelector<HTMLInputElement>(`input[value="${sku.slice(-1)}"]`)!;
  radio.checked = true;
  radio.addEventListener("change", () => { document.querySelector<HTMLInputElement>('input[name="variant"]')!.value = sku; }, { once: true });
  radio.dispatchEvent(new Event("change", { bubbles: true }));
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => { document.body.innerHTML = ""; });

describe("context.product for islands", () => {
  it("is absent off a product page", () => {
    document.body.innerHTML = "<main></main>";
    expect(productContext()).toBeUndefined();
  });

  it("lets an engraving island read the buy form and follow a variant change, without reading the form's markup", async () => {
    document.body.innerHTML = `${page}<div id="preview"></div>`;
    const product = productContext()!;
    const preview = document.getElementById("preview")!;
    const stop = engravingIsland(preview, { product } as StorefrontIslandContext);
    expect(preview.textContent).toBe("choose a size: (no text) x1");

    pickSize("ring_l");
    await tick();
    expect(preview.textContent).toBe("ring_l: (no text) x1");

    const engraving = document.querySelector<HTMLInputElement>('input[name="property.engraving"]')!;
    engraving.value = "A & B";
    engraving.dispatchEvent(new Event("input", { bubbles: true }));
    const quantity = document.getElementById("quantity") as HTMLInputElement;
    quantity.value = "3";
    quantity.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(preview.textContent).toBe("ring_l: A & B x3");
    expect(product.state()).toEqual({ variantId: "ring_l", quantity: 3, inputs: { engraving: "A & B", gift_wrap: "" }, purchaseOption: null });

    stop();
    pickSize("ring_m");
    await tick();
    expect(preview.textContent).toBe("ring_l: A & B x3");
    expect(product.state().variantId).toBe("ring_m");
  });
});
