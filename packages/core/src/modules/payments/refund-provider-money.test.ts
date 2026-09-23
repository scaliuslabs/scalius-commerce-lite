import { describe, expect, it } from "vitest";

import { resolveRefundProviderMoney } from "./refund-provider-money";

describe("refund provider money", () => {
  it("uses immutable three-decimal precision", () => {
    expect(resolveRefundProviderMoney(
      1.235,
      { code: "KWD", decimalPlaces: 3, legacyFallback: false },
    )).toEqual({ amountMinor: 1235, currency: "KWD" });
  });
});
