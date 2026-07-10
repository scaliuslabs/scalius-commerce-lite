import { describe, expect, it } from "vitest";

import {
  resolvePolarRefundProviderMoney,
  resolveStripeRefundProviderMoney,
} from "./refund-provider-money";

describe("refund provider money", () => {
  it("derives converted Polar USD minors from the immutable source snapshot", () => {
    expect(resolvePolarRefundProviderMoney(
      1100,
      { code: "BDT", decimalPlaces: 2, legacyFallback: false },
      {
        amount: 1100,
        metadata: JSON.stringify({
          originalCurrency: "bdt",
          gatewayCurrency: "usd",
          exchangeRate: "110",
          originalAmount: "1100",
          gatewayAmount: 10,
        }),
      },
    )).toEqual({ amountMinor: 1000, currency: "USD" });
  });

  it("fails closed when Polar source-payment conversion metadata is missing", () => {
    expect(() => resolvePolarRefundProviderMoney(
      1100,
      { code: "BDT", decimalPlaces: 2, legacyFallback: false },
      { amount: 1100, metadata: null },
    )).toThrow("currency metadata is missing");
  });

  it("preserves direct Polar zero-decimal provider amounts", () => {
    expect(resolvePolarRefundProviderMoney(
      1250,
      { code: "JPY", decimalPlaces: 0, legacyFallback: false },
      {
        amount: 1250,
        metadata: {
          originalCurrency: "jpy",
          gatewayCurrency: "jpy",
          exchangeRate: "1",
          originalAmount: "1250",
          gatewayAmount: 1250,
        },
      },
    )).toEqual({ amountMinor: 1250, currency: "JPY" });
  });

  it("uses the persisted captured amount for a native half-cent full refund", () => {
    expect(resolvePolarRefundProviderMoney(
      100.5,
      { code: "BDT", decimalPlaces: 2, legacyFallback: false },
      {
        amount: 100.5,
        metadata: {
          originalCurrency: "bdt",
          gatewayCurrency: "usd",
          exchangeRate: "100",
          originalAmount: "100.5",
          gatewayAmount: 1,
        },
      },
    )).toEqual({ amountMinor: 100, currency: "USD" });
  });

  it("rejects Polar gateway amounts that contradict the saved rate", () => {
    expect(() => resolvePolarRefundProviderMoney(
      1100,
      { code: "BDT", decimalPlaces: 2, legacyFallback: false },
      {
        amount: 1100,
        metadata: {
          originalCurrency: "bdt",
          gatewayCurrency: "usd",
          exchangeRate: "110",
          originalAmount: "1100",
          gatewayAmount: 11,
        },
      },
    )).toThrow("gateway amount metadata is inconsistent");
  });

  it("uses immutable three-decimal precision for Stripe", () => {
    expect(resolveStripeRefundProviderMoney(
      1.235,
      { code: "KWD", decimalPlaces: 3, legacyFallback: false },
    )).toEqual({ amountMinor: 1235, currency: "KWD" });
  });
});
