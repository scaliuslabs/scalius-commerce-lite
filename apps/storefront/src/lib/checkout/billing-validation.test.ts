// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import type { AddressRules } from "@scalius/shared/address";
import { ENGLISH_CHECKOUT_LANGUAGE_DATA as copy } from "@scalius/shared/checkout-language";
import { billingAddressAsked, billingAddressProblems, billingRequiredFields } from "./billing-validation";
import { checkoutInformationFields, enhanceCheckoutFields } from "./field-validation";
import type { CheckoutDeliveryMode } from "./delivery-mode";

// The rules the API serves (GET /api/v1/address-rules/{countryCode}).
const BD: AddressRules = {
  countryCode: "BD",
  format: "%N%n%O%n%A%n%C - %Z",
  rows: [["name"], ["company"], ["line1"], ["line2"], ["locality", "postalCode"]],
  allowedFields: ["name", "company", "line1", "line2", "locality", "postalCode"],
  requiredFields: ["line1", "locality"],
  upperFields: ["locality"],
  postalCodePattern: "\\d{4}",
  postalCodeExamples: ["1340"],
  labels: { adminArea: "province", locality: "city", dependentLocality: "suburb", postalCode: "postal" },
  adminAreas: [],
};
const US: AddressRules = {
  ...BD,
  countryCode: "US",
  rows: [["name"], ["company"], ["line1"], ["line2"], ["locality", "adminArea", "postalCode"]],
  allowedFields: ["name", "company", "line1", "line2", "locality", "adminArea", "postalCode"],
  requiredFields: ["line1", "locality", "adminArea", "postalCode"],
  postalCodePattern: "\\d{5}([ \\-]\\d{4})?",
  adminAreas: [{ code: "CA", name: "California", isoCode: "US-CA" } as AddressRules["adminAreas"][number]],
};

describe("billing address checks (Shopify's rule)", () => {
  it("asks an order with nothing to ship for its billing address, a shipped one only when it is not the shipping address", () => {
    expect(billingAddressAsked({ path: "none", requireFullBillingAddress: false, sameAsShipping: false })).toEqual({ asked: true, mode: "minimal" });
    expect(billingAddressAsked({ path: "none", requireFullBillingAddress: true, sameAsShipping: true })).toEqual({ asked: true, mode: "full" });
    expect(billingAddressAsked({ path: "delivery", requireFullBillingAddress: true, sameAsShipping: true })).toEqual({ asked: false });
    expect(billingAddressAsked({ path: "delivery", requireFullBillingAddress: true, sameAsShipping: false })).toEqual({ asked: true, mode: "full" });
    expect(billingAddressAsked({ path: "pickup", requireFullBillingAddress: false, sameAsShipping: false })).toEqual({ asked: false });
  });

  it("needs only the country for a minimal Bangladesh address, and the street and city for a full one", () => {
    expect(billingRequiredFields(BD, "minimal")).toEqual([]);
    expect(billingAddressProblems(BD, "minimal", {})).toEqual([]);
    expect(billingRequiredFields(BD, "full")).toEqual(["billingAddress", "billingLocality"]);
    expect(billingAddressProblems(BD, "full", {})).toEqual([
      { field: "billingAddress", problem: "required" },
      { field: "billingLocality", problem: "required" },
    ]);
    expect(billingAddressProblems(BD, "full", { billingAddress: "House 1, Road 2", billingLocality: "Dhaka", billingPostalCode: "12" }))
      .toEqual([{ field: "billingPostalCode", problem: "invalid" }]);
  });

  it("asks a minimal address abroad only for what tax regions match on", () => {
    expect(billingRequiredFields(US, "minimal")).toEqual(["billingAdminArea", "billingPostalCode"]);
    expect(billingAddressProblems(US, "minimal", { billingAdminArea: "Texas", billingPostalCode: "9410" })).toEqual([
      { field: "billingAdminArea", problem: "invalid" },
      { field: "billingPostalCode", problem: "invalid" },
    ]);
    expect(billingAddressProblems(US, "minimal", { billingAdminArea: "California", billingPostalCode: "94103" })).toEqual([]);
  });
});

describe("billing fields on the cart form", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  function renderBilling(requireFull: boolean) {
    const field = (name: string, label: string) => `
      <div data-address-rule="${name}">
        <label for="billing-${name}">${label}<span data-required-mark>*</span></label>
        <input id="billing-${name}" name="${name}" data-billing-field="${name}" aria-describedby="billing-${name}-error" />
        <p id="billing-${name}-error" class="hidden" role="alert"></p>
      </div>`;
    document.body.innerHTML = `
      <form>
        <input id="customerName" name="customerName" value="Anika Rahman" /><p id="customerName-error" class="hidden"></p>
        <section data-billing-section data-billing-full="${requireFull}">
          <label><input type="checkbox" name="billingSameAsShipping" value="1" checked data-billing-same /></label>
          <div data-billing-fields>
            <input type="hidden" name="billingCountryCode" value="BD" />
            ${field("billingAddress", "Address")}
            ${field("billingLocality", "City")}
            ${field("billingPostalCode", "Postal code")}
          </div>
        </section>
      </form>`;
    return document.body.querySelector("form")!;
  }

  const validate = (mode: CheckoutDeliveryMode, rules: AddressRules | null) =>
    enhanceCheckoutFields(checkoutInformationFields(document.body, copy, () => mode, () => rules)).validateAll();

  it("stops an order with nothing to ship at its first empty billing field, with a message under each", () => {
    renderBilling(true);
    const first = validate("none", BD);
    expect(first).toBe(document.getElementById("billing-billingAddress"));
    expect(document.getElementById("billing-billingAddress-error")!.textContent).toBe("Address is required.");
    expect(document.getElementById("billing-billingLocality-error")!.textContent).toBe("City is required.");
    expect(document.getElementById("billing-billingLocality")!.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById("billing-billingPostalCode-error")!.textContent).toBe("");

    (document.getElementById("billing-billingAddress") as HTMLInputElement).value = "House 1, Road 2";
    (document.getElementById("billing-billingLocality") as HTMLInputElement).value = "Dhaka";
    expect(validate("none", BD)).toBeNull();
  });

  it("leaves a shipped order billed at its shipping address alone until it asks for a separate one", () => {
    renderBilling(true);
    expect(validate("delivery", BD)).toBeNull();
    document.querySelector<HTMLInputElement>("[data-billing-same]")!.checked = false;
    expect(validate("delivery", BD)).toBe(document.getElementById("billing-billingAddress"));
    // Rules not loaded yet: the API checks the address when the order is placed.
    expect(validate("none", null)).toBeNull();
  });
});
