import { describe, expect, it } from "vitest";

import { resolveStripeRefundProviderMoney } from "./refund-provider-money";

describe("refund provider money", () => {
  it("uses immutable three-decimal precision for Stripe", () => {
    expect(resolveStripeRefundProviderMoney(
      1.235,
      { code: "KWD", decimalPlaces: 3, legacyFallback: false },
    )).toEqual({ amountMinor: 1235, currency: "KWD" });
  });
});
