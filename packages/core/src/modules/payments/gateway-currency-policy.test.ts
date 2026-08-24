import { describe, expect, it } from "vitest";

import {
  filterPaymentGatewayIdsForCurrency,
  getPaymentGatewayCurrencyEligibilityIssue,
  isPaymentGatewayCurrencyEligible,
} from "./gateway-currency-policy";

describe("payment gateway currency policy", () => {
  it("keeps all known methods for BDT", () => {
    expect(filterPaymentGatewayIdsForCurrency(
      ["stripe", "sslcommerz", "polar", "cod"],
      "BDT",
    )).toEqual(["stripe", "sslcommerz", "polar", "cod"]);
  });

  it("excludes SSLCommerz outside BDT without changing the saved order", () => {
    expect(filterPaymentGatewayIdsForCurrency(
      ["sslcommerz", "cod", "stripe", "unknown"],
      "usd",
    )).toEqual(["cod", "stripe"]);
    expect(isPaymentGatewayCurrencyEligible("sslcommerz", "USD")).toBe(false);
    expect(getPaymentGatewayCurrencyEligibilityIssue("sslcommerz", "USD"))
      .toBe("SSLCommerz checkout requires the store currency to be BDT. Current currency: USD.");
  });

  it("fails closed for unknown methods and unsupported currencies", () => {
    expect(isPaymentGatewayCurrencyEligible("unknown", "BDT")).toBe(false);
    expect(isPaymentGatewayCurrencyEligible("stripe", "XYZ")).toBe(false);
    expect(filterPaymentGatewayIdsForCurrency(["stripe", "cod"], "XYZ")).toEqual([]);
  });
});
