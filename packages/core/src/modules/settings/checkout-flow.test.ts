import { describe, expect, it } from "vitest";

import { getCheckoutFlowValidationIssues } from "./checkout-flow";

describe("checkout flow validation", () => {
  it("rejects Fast COD Only when COD is not enabled", () => {
    expect(getCheckoutFlowValidationIssues({
      checkoutMode: "guest_cod_only",
      partialPaymentEnabled: false,
      partialPaymentAmount: 0,
      availablePaymentMethods: ["stripe"],
    })).toContain("Fast COD Only needs Cash on Delivery to be enabled.");
  });

  it("rejects Online Gateways Only when no online gateway is usable", () => {
    expect(getCheckoutFlowValidationIssues({
      checkoutMode: "gateways_only",
      partialPaymentEnabled: false,
      partialPaymentAmount: 0,
      availablePaymentMethods: ["cod"],
    })).toContain("Online Gateways Only needs at least one enabled and configured online gateway.");
  });

  it("allows All mode with either COD or an online gateway", () => {
    expect(getCheckoutFlowValidationIssues({
      checkoutMode: "all",
      partialPaymentEnabled: false,
      partialPaymentAmount: 0,
      availablePaymentMethods: ["cod"],
    })).toEqual([]);
    expect(getCheckoutFlowValidationIssues({
      checkoutMode: "all",
      partialPaymentEnabled: false,
      partialPaymentAmount: 0,
      availablePaymentMethods: ["sslcommerz"],
    })).toEqual([]);
  });

  it("keeps partial payment online-gateway guards", () => {
    expect(getCheckoutFlowValidationIssues({
      checkoutMode: "guest_cod_only",
      partialPaymentEnabled: true,
      partialPaymentAmount: 0,
      availablePaymentMethods: ["cod"],
    })).toEqual(expect.arrayContaining([
      "Advance payment amount must be greater than zero.",
      "Partial payment needs an online payment gateway, so Fast COD Only cannot be used.",
      "Partial payment needs at least one enabled and configured online payment gateway.",
    ]));
  });
});
