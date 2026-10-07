import { describe, expect, it } from "vitest";

import { billingQuoteFields, checkoutBillingFields, storedCheckoutBillingFields } from "./billing-address";

describe("checkoutBillingFields (Shopify's rule)", () => {
  const typed = {
    billingCountryCode: "us",
    billingName: "Ann Lee",
    billingAddress: " 1 Main St ",
    billingLocality: "Springfield",
    billingAdminArea: "IL",
    billingPostalCode: "62701",
  };

  it("sends nothing when checkout did not ask (a shipped or pickup order)", () => {
    expect(checkoutBillingFields("delivery", false, { ...typed, billingSameAsShipping: null })).toEqual({});
    expect(checkoutBillingFields("pickup", false, typed)).toEqual({});
  });

  it("sends only the country, region and postal code of a minimal billing address", () => {
    expect(checkoutBillingFields("none", false, typed))
      .toEqual({ billingCountryCode: "US", billingAdminArea: "IL", billingPostalCode: "62701" });
  });

  it("sends the full address, or same as shipping, when the merchant requires one", () => {
    expect(checkoutBillingFields("delivery", true, { ...typed, billingSameAsShipping: "1" })).toEqual({ billingSameAsShipping: true });
    expect(checkoutBillingFields("delivery", true, { ...typed, billingSameAsShipping: null })).toEqual({
      billingSameAsShipping: false,
      billingCountryCode: "US",
      billingName: "Ann Lee",
      billingAddress: "1 Main St",
      billingLocality: "Springfield",
      billingAdminArea: "IL",
      billingPostalCode: "62701",
    });
    // A pickup or no-ship order has no "same as shipping".
    expect(checkoutBillingFields("pickup", true, { ...typed, billingSameAsShipping: "1" })).not.toHaveProperty("billingSameAsShipping");
  });

  it("keeps the fields through the payment step and quotes only an order that ships nothing", () => {
    const stored = Object.fromEntries(Object.entries(checkoutBillingFields("delivery", true, { ...typed, billingSameAsShipping: null }))
      .map(([key, value]) => [key, String(value)]));
    expect(storedCheckoutBillingFields(stored)).toMatchObject({ billingSameAsShipping: false, billingCountryCode: "US", billingAddress: "1 Main St" });
    expect(billingQuoteFields("none", typed)).toEqual({ billingCountryCode: "US", billingAdminArea: "IL", billingPostalCode: "62701" });
    expect(billingQuoteFields("delivery", typed)).toEqual({});
    expect(billingQuoteFields("none", { billingCountryCode: "x" })).toEqual({});
  });
});
