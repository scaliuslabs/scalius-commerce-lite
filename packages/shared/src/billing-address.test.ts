import { describe, expect, it } from "vitest";

import { billingAddressFields, billingAddressNeed } from "./billing-address";

describe("billingAddressNeed (Shopify's rule)", () => {
  it("asks an order that ships nothing for a minimal billing address", () => {
    expect(billingAddressNeed({ path: "none", requireFullBillingAddress: false }))
      .toEqual({ asked: true, sameAsShippingOffered: false, mode: "minimal" });
    expect(billingAddressNeed({ path: "none", requireFullBillingAddress: true }).mode).toBe("full");
  });

  it("asks a shipped or pickup order only when the merchant requires a full billing address", () => {
    expect(billingAddressNeed({ path: "delivery", requireFullBillingAddress: false }))
      .toEqual({ asked: false, sameAsShippingOffered: true, mode: "full" });
    expect(billingAddressNeed({ path: "delivery", requireFullBillingAddress: true }).asked).toBe(true);
    expect(billingAddressNeed({ path: "pickup", requireFullBillingAddress: false }).asked).toBe(false);
    expect(billingAddressNeed({ path: "pickup", requireFullBillingAddress: true }))
      .toEqual({ asked: true, sameAsShippingOffered: false, mode: "full" });
  });
});

describe("billingAddressFields", () => {
  const rules = (requiredFields: string[], allowedFields: string[], rows: string[][]) =>
    ({ requiredFields, allowedFields, rows }) as Parameters<typeof billingAddressFields>[0];

  it("keeps only the region and postal code a country requires in a minimal address", () => {
    const us = rules(["line1", "locality", "adminArea", "postalCode"], ["name", "line1", "line2", "locality", "adminArea", "postalCode"],
      [["name"], ["line1"], ["line2"], ["locality", "adminArea", "postalCode"]]);
    expect(billingAddressFields(us, "minimal")).toEqual(["adminArea", "postalCode"]);
    expect(billingAddressFields(us, "full")).toEqual(["name", "line1", "line2", "locality", "adminArea", "postalCode"]);
    // Bangladesh requires neither: a minimal billing address is its country alone.
    const bd = rules(["line1", "locality"], ["name", "line1", "line2", "locality", "postalCode"], [["name"], ["line1"], ["line2"], ["locality", "postalCode"]]);
    expect(billingAddressFields(bd, "minimal")).toEqual([]);
  });
});
