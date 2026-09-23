// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";

import { enhanceShippingMethods } from "./shipping-methods";

afterEach(() => {
  document.body.innerHTML = "";
  delete window.lastShippingEventDetail;
});

describe("enhanceShippingMethods", () => {
  function render() {
    document.body.innerHTML = `
      <div data-shipping-methods data-free-text="Free" data-waived-text="Normally {fee}; waived.">
        <label><input type="radio" name="shippingLocation" value="inside" data-fee="60" data-name="Inside Dhaka" checked />
          <span data-fee-label="৳60">৳60</span></label>
        <label><input type="radio" name="shippingLocation" value="outside" data-fee="120" data-name="Outside Dhaka" />
          <span data-fee-label="৳120">৳120</span></label>
      </div>`;
  }

  it("publishes the selected method and updates it on change", () => {
    render();
    const events: unknown[] = [];
    window.addEventListener("shippingLocationChange", (event) =>
      events.push((event as CustomEvent).detail),
    );
    enhanceShippingMethods(document, {
      readDraftMethod: () => undefined,
      isFeeWaived: () => false,
    });
    expect(window.lastShippingEventDetail).toEqual({ id: "inside", fee: 60, name: "Inside Dhaka" });

    const outside = document.querySelector<HTMLInputElement>('input[value="outside"]')!;
    outside.checked = true;
    outside.dispatchEvent(new Event("change", { bubbles: true }));
    expect(events.at(-1)).toEqual({ id: "outside", fee: 120, name: "Outside Dhaka" });
  });

  it("restores the drafted method", () => {
    render();
    enhanceShippingMethods(document, {
      readDraftMethod: () => "outside",
      isFeeWaived: () => false,
    });
    expect(window.lastShippingEventDetail?.id).toBe("outside");
  });

  it("shows free delivery when a cart item waives the fee", () => {
    render();
    let waived = false;
    const methods = enhanceShippingMethods(document, {
      readDraftMethod: () => undefined,
      isFeeWaived: () => waived,
    })!;
    const labels = () =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-fee-label]"));
    expect(labels().map((label) => label.textContent)).toEqual(["৳60", "৳120"]);

    waived = true;
    methods.refreshFees();
    expect(labels().map((label) => label.textContent)).toEqual(["Free", "Free"]);
    expect(labels()[0].title).toBe("Normally ৳60; waived.");
  });
});
