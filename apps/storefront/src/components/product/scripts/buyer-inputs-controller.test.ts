// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENGLISH_CHECKOUT_LANGUAGE_DATA } from "@scalius/shared/checkout-language";
import { pickBuyerInputCopy } from "../lib/buyer-inputs";
import { initBuyerInputs } from "./buyer-inputs-controller";

const fields = [
  { key: "engraving", label: "Engraving text", type: "text", required: false, help: null, maxLength: 12, price: 200, priceMinor: 20_000, options: [] },
  { key: "wrap", label: "Gift wrap", type: "checkbox", required: false, help: null, maxLength: null, price: 50, priceMinor: 5_000, options: [] },
  {
    key: "fit", label: "Fit", type: "select", required: true, help: null, maxLength: null, price: 0, priceMinor: 0,
    options: [
      { value: "regular", label: "Regular", price: 0, priceMinor: 0 },
      { value: "slim", label: "Slim", price: 100, priceMinor: 10_000 },
    ],
  },
];

// The markup ProductBuyerInputs.astro renders, reduced to what the script reads.
function render() {
  document.body.innerHTML = `
    <form data-buyer-inputs method="post" action="/buy/pen">
      <input type="hidden" name="variant" value="" data-buyer-inputs-variant />
      <script type="application/json" id="product-customization-data">${JSON.stringify(fields)}</script>
      <script type="application/json" id="product-customization-copy">${JSON.stringify(pickBuyerInputCopy(ENGLISH_CHECKOUT_LANGUAGE_DATA))}</script>
      <div data-buyer-input="engraving">
        <input id="product-input-engraving" name="property.engraving" data-buyer-input-max="12" />
        <p data-buyer-input-error class="hidden"></p>
        <span data-buyer-input-counter>0/12</span>
      </div>
      <div data-buyer-input="wrap">
        <input id="product-input-wrap" type="checkbox" name="property.wrap" value="true" />
        <p data-buyer-input-error class="hidden"></p>
      </div>
      <div data-buyer-input="fit">
        <select id="product-input-fit" name="property.fit" required>
          <option value="">Choose…</option><option value="regular">Regular</option><option value="slim">Slim</option>
        </select>
        <p data-buyer-input-error class="hidden"></p>
      </div>
    </form>`;
}

describe("buyer inputs controller", () => {
  beforeEach(() => {
    render();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("does nothing on products without buyer inputs", () => {
    document.body.innerHTML = "<div></div>";
    expect(initBuyerInputs(document, vi.fn())).toBeNull();
  });

  it("counts characters, prices the filled inputs and reports every change", () => {
    const onChange = vi.fn();
    const inputs = initBuyerInputs(document, onChange)!;
    expect(inputs.form.noValidate).toBe(true);
    const engraving = document.querySelector<HTMLInputElement>("#product-input-engraving")!;
    engraving.value = "Anika";
    engraving.dispatchEvent(new Event("input"));
    expect(document.querySelector("[data-buyer-input-counter]")?.textContent).toBe("5/12");
    const wrap = document.querySelector<HTMLInputElement>("#product-input-wrap")!;
    wrap.checked = true;
    wrap.dispatchEvent(new Event("change"));
    const fit = document.querySelector<HTMLSelectElement>("#product-input-fit")!;
    fit.value = "slim";
    fit.dispatchEvent(new Event("change"));
    expect(onChange).toHaveBeenCalled();
    expect(inputs.surchargeMinor()).toBe(35_000);
  });

  it("shows the message under the first missing field and focuses it", () => {
    const inputs = initBuyerInputs(document, vi.fn())!;
    const result = inputs.validate();
    expect(result.ok).toBe(false);
    const fit = document.querySelector<HTMLSelectElement>("#product-input-fit")!;
    const note = document.querySelector('[data-buyer-input="fit"] [data-buyer-input-error]')!;
    expect(note.textContent).toBe("Choose Fit.");
    expect(note.classList.contains("hidden")).toBe(false);
    expect(fit.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(fit);

    fit.value = "regular";
    fit.dispatchEvent(new Event("change"));
    expect(fit.hasAttribute("aria-invalid")).toBe(false);
    expect(inputs.validate()).toMatchObject({ ok: true, properties: [{ key: "fit", value: "regular", displayValue: "Regular" }] });
  });

  it("fills the form from a cart line being edited and keeps the variant field current", () => {
    const inputs = initBuyerInputs(document, vi.fn())!;
    inputs.prefill([
      { key: "engraving", value: "Rafi" },
      { key: "wrap", value: "true" },
      { key: "fit", value: "slim" },
    ]);
    expect(document.querySelector<HTMLInputElement>("#product-input-engraving")!.value).toBe("Rafi");
    expect(document.querySelector<HTMLInputElement>("#product-input-wrap")!.checked).toBe(true);
    expect(document.querySelector("[data-buyer-input-counter]")?.textContent).toBe("4/12");
    inputs.setVariant("var_1");
    expect(document.querySelector<HTMLInputElement>("[data-buyer-inputs-variant]")!.value).toBe("var_1");
  });
});
