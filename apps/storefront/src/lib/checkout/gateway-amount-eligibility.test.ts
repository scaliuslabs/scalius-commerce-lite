import { describe, expect, it } from "vitest";

import { isGatewayEligibleForPaymentAmount } from "./gateway-amount-eligibility";

describe("gateway amount eligibility", () => {
  const sslcommerz = {
    amountLimits: { currency: "BDT", min: 10, max: 500_000 },
  };

  it.each([10, 125, 500_000])("accepts SSLCommerz BDT amount %s", (amount) => {
    expect(isGatewayEligibleForPaymentAmount(sslcommerz, amount, "BDT")).toBe(true);
  });

  it.each([0, 9.99, 500_000.01, Number.NaN])(
    "rejects SSLCommerz amount %s outside the published range",
    (amount) => {
      expect(isGatewayEligibleForPaymentAmount(sslcommerz, amount, "BDT")).toBe(false);
    },
  );

  it("fails closed when the published limit currency does not match", () => {
    expect(isGatewayEligibleForPaymentAmount(sslcommerz, 100, "USD")).toBe(false);
  });

  it("does not restrict gateways without an amount policy", () => {
    expect(isGatewayEligibleForPaymentAmount({}, 0, "BDT")).toBe(true);
  });
});
