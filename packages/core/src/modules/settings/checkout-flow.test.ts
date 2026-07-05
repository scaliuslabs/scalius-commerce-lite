import { describe, expect, it } from "vitest";

import {
  getCheckoutFlowValidationIssues,
  isCheckoutGatewayUsableForFlow,
} from "./checkout-flow";

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

  it("rejects Standard mode when no compatible payment method is available", () => {
    expect(getCheckoutFlowValidationIssues({
      checkoutMode: "all",
      partialPaymentEnabled: false,
      partialPaymentAmount: 0,
      availablePaymentMethods: [],
    })).toContain("Standard checkout needs at least one enabled and configured payment method.");
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

  it("rejects advance payments below the SSLCommerz provider minimum when SSLCommerz can receive them", () => {
    expect(getCheckoutFlowValidationIssues({
      checkoutMode: "gateways_only",
      partialPaymentEnabled: true,
      partialPaymentAmount: 5,
      availablePaymentMethods: ["sslcommerz"],
    })).toContain("SSLCommerz advance payment amount must be between 10.00 BDT and 500000.00 BDT.");

    expect(getCheckoutFlowValidationIssues({
      checkoutMode: "all",
      partialPaymentEnabled: true,
      partialPaymentAmount: 5,
      availablePaymentMethods: ["stripe", "sslcommerz"],
    })).toContain("SSLCommerz advance payment amount must be between 10.00 BDT and 500000.00 BDT.");

    expect(getCheckoutFlowValidationIssues({
      checkoutMode: "gateways_only",
      partialPaymentEnabled: true,
      partialPaymentAmount: 5,
      availablePaymentMethods: ["stripe", "polar"],
    })).not.toContain("SSLCommerz advance payment amount must be between 10.00 BDT and 500000.00 BDT.");
  });

  it.each([
    ["all", false, 0, "cod", true],
    ["all", false, 0, "sslcommerz", true],
    ["guest_cod_only", false, 0, "cod", true],
    ["guest_cod_only", false, 0, "stripe", false],
    ["gateways_only", false, 0, "cod", false],
    ["gateways_only", false, 0, "polar", true],
    ["all", true, 200, "cod", false],
    ["all", true, 200, "stripe", true],
    ["all", true, 0, "stripe", false],
  ] as const)(
    "resolves gateway visibility for mode=%s partial=%s amount=%s gateway=%s",
    (checkoutMode, partialPaymentEnabled, partialPaymentAmount, gatewayId, expected) => {
      expect(isCheckoutGatewayUsableForFlow({
        gatewayId,
        checkoutMode,
        partialPaymentEnabled,
        partialPaymentAmount,
      })).toBe(expected);
    },
  );
});
