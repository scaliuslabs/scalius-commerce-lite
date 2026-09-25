// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";

import { ENGLISH_CHECKOUT_LANGUAGE_DATA as copy } from "@scalius/shared/checkout-language";
import {
  applyCheckoutDeliveryMode,
  cashOnDeliveryDescription,
  cashOnDeliveryLabel,
  checkoutAddressForMode,
  CHECKOUT_REQUIRED_FIELDS,
  missingCheckoutFields,
  readCheckoutDeliveryMode,
  resolveCheckoutDeliveryMode,
  type CheckoutDeliveryMode,
} from "./delivery-mode";
import { checkoutInformationFields, enhanceCheckoutFields } from "./field-validation";

describe("checkout paths (Wave A §2.7)", () => {
  it("resolves the path from the cart and the chosen rate's kind", () => {
    expect(resolveCheckoutDeliveryMode(false, "delivery")).toBe("none");
    expect(resolveCheckoutDeliveryMode(false, "pickup")).toBe("none");
    expect(resolveCheckoutDeliveryMode(true, "pickup")).toBe("pickup");
    expect(resolveCheckoutDeliveryMode(true, "delivery")).toBe("delivery");
    expect(resolveCheckoutDeliveryMode(true, null)).toBe("delivery");
  });

  it.each<[CheckoutDeliveryMode, string[]]>([
    ["delivery", ["customerName", "customerPhone", "shippingAddress", "city", "zone", "shippingMethod"]],
    ["pickup", ["customerName", "customerPhone", "shippingMethod"]],
    ["none", ["customerName", "customerPhone"]],
  ])("requires on the %s path exactly %j (phone always)", (mode, fields) => {
    expect(CHECKOUT_REQUIRED_FIELDS[mode]).toEqual(fields);
    expect(missingCheckoutFields(mode, {})).toEqual(fields);
    expect(missingCheckoutFields(mode, {
      customerName: "Anika",
      customerPhone: "+8801712345678",
      shippingAddress: "House 1, Road 2, Dhanmondi",
      city: "dhaka",
      zone: "dhanmondi",
      shippingMethod: "rate_1",
    })).toEqual([]);
  });

  it("sends an address only on the delivery path", () => {
    const typed = {
      shippingAddress: " House 1, Road 2 ",
      city: "dhaka",
      zone: "dhanmondi",
      area: "",
      cityName: "Dhaka",
      zoneName: "Dhanmondi",
      areaName: null,
    };
    expect(checkoutAddressForMode("delivery", typed)).toEqual({
      shippingAddress: "House 1, Road 2",
      city: "dhaka",
      zone: "dhanmondi",
      area: null,
      cityName: "Dhaka",
      zoneName: "Dhanmondi",
      areaName: null,
    });
    for (const mode of ["pickup", "none"] as const) {
      expect(Object.values(checkoutAddressForMode(mode, typed)).every((value) => value === null)).toBe(true);
    }
  });

  it("words cash on delivery for the door, the counter and the service", () => {
    expect(cashOnDeliveryDescription("delivery", copy)).toBe(copy.payOnDeliveryText);
    expect(cashOnDeliveryDescription("pickup", copy)).toBe(copy.payAtPickupText);
    expect(cashOnDeliveryDescription("none", copy)).toBe(copy.payAtServiceText);
    // Its name: only a delivery is "Cash on delivery".
    expect(cashOnDeliveryLabel("delivery", copy)).toBe("Cash on delivery");
    expect(cashOnDeliveryLabel("pickup", copy)).toBe("Pay at pickup");
    expect(cashOnDeliveryLabel("none", copy)).toBe("Pay on service");
  });
});

describe("checkout field validation per path", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function renderForm(options: { need?: "method" | "none"; mode?: "delivery" | "pickup" } = {}) {
    document.body.innerHTML = `
      <div id="cartPageRoot" data-delivery-need="${options.need ?? "method"}">
        <form id="checkoutForm">
          <input id="customerName" name="customerName" /><p id="customerName-error" class="hidden"></p>
          <input id="customerEmail" name="customerEmail" /><p id="customerEmail-error" class="hidden"></p>
          <input type="radio" name="deliveryMode" value="delivery" ${options.mode !== "pickup" ? "checked" : ""} />
          <input type="radio" name="deliveryMode" value="pickup" ${options.mode === "pickup" ? "checked" : ""} />
          <fieldset data-address-fields>
            <textarea id="shippingAddress" name="shippingAddress"></textarea><p id="shippingAddressError" class="hidden"></p>
            <select id="checkout-city" name="city"><option value=""></option><option value="dhaka">Dhaka</option></select>
            <select id="checkout-zone" name="zone"><option value=""></option><option value="mirpur">Mirpur</option></select>
            <p id="shippingLocationError" class="hidden"></p>
          </fieldset>
          <fieldset id="shippingMethods"><div data-shipping-options></div></fieldset>
          <p id="shippingMethodError" class="hidden"></p>
        </form>
      </div>`;
    const form = document.getElementById("checkoutForm")!;
    const fields = enhanceCheckoutFields(checkoutInformationFields(form, copy, () => readCheckoutDeliveryMode()));
    const messages = () => ({
      name: document.getElementById("customerName-error")!.textContent,
      address: document.getElementById("shippingAddressError")!.textContent,
      location: document.getElementById("shippingLocationError")!.textContent,
      method: document.getElementById("shippingMethodError")!.textContent,
    });
    return { fields, messages };
  }

  it("delivery: asks for the address, city/thana and a delivery option", () => {
    const { fields, messages } = renderForm();
    expect(applyCheckoutDeliveryMode()).toBe("delivery");
    expect(fields.validateAll()?.id).toBe("customerName");
    expect(messages()).toEqual({
      name: copy.nameRequiredText,
      address: copy.addressRequiredText,
      location: copy.cityZoneRequiredText,
      // Without a city and thana the location message already says what to do.
      method: "",
    });
    expect((document.querySelector("fieldset[data-address-fields]") as HTMLFieldSetElement).disabled).toBe(false);
  });

  it("pickup: never asks for an address, asks for a pickup location, and leaves the address out of the form", () => {
    const { fields, messages } = renderForm({ mode: "pickup" });
    expect(applyCheckoutDeliveryMode()).toBe("pickup");
    (document.getElementById("customerName") as HTMLInputElement).value = "Anika Rahman";
    (document.getElementById("shippingAddress") as HTMLTextAreaElement).value = "stale typed address";
    expect(fields.validateAll()?.id).toBe("shippingMethods");
    expect(messages()).toEqual({ name: "", address: "", location: "", method: copy.pickupLocationRequiredText });
    expect(document.getElementById("cartPageRoot")!.dataset.deliveryMode).toBe("pickup");
    // A disabled fieldset submits nothing in a browser, and the server drops
    // an address sent with a pickup order anyway (checkoutAddressForMode).
    expect((document.querySelector("fieldset[data-address-fields]") as HTMLFieldSetElement).disabled).toBe(true);

    const option = document.createElement("input");
    option.type = "radio";
    option.name = "shippingLocation";
    option.value = "pickup_1";
    option.checked = true;
    document.querySelector("[data-shipping-options]")!.append(option);
    expect(fields.validateAll()).toBeNull();
  });

  it("none: only contact details (the phone field checks itself), whatever the switch says", () => {
    const { fields, messages } = renderForm({ need: "none", mode: "delivery" });
    expect(applyCheckoutDeliveryMode()).toBe("none");
    (document.getElementById("customerName") as HTMLInputElement).value = "Anika Rahman";
    expect(fields.validateAll()).toBeNull();
    expect(messages()).toEqual({ name: "", address: "", location: "", method: "" });
    expect((document.querySelector("fieldset[data-address-fields]") as HTMLFieldSetElement).disabled).toBe(true);
  });
});
