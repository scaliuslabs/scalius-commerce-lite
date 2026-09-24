import { describe, expect, it } from "vitest";

import {
  SUPPORTED_CURRENCY_CODES,
  formatMoney,
  normalizeSupportedCurrencyCode,
} from "./currency";

describe("supported currency codes", () => {
  it("keeps the dashboard catalog canonical and unique", () => {
    expect(SUPPORTED_CURRENCY_CODES).toHaveLength(156);
    expect(new Set(SUPPORTED_CURRENCY_CODES).size).toBe(
      SUPPORTED_CURRENCY_CODES.length,
    );
    expect(SUPPORTED_CURRENCY_CODES.every((code) => /^[A-Z]{3}$/.test(code)))
      .toBe(true);
  });

  it.each([
    ["BDT", "BDT"],
    [" bdt ", "BDT"],
    ["usd", "USD"],
    ["JPY", "JPY"],
  ] as const)("normalizes supported code %s", (input, expected) => {
    expect(normalizeSupportedCurrencyCode(input)).toBe(expected);
  });

  it.each(["", "US", "ZZZ", "USDT", "12A", null, 123])(
    "rejects unsupported code %s",
    (input) => {
      expect(normalizeSupportedCurrencyCode(input)).toBeNull();
    },
  );
});

describe("buyer money format", () => {
  it("uses the taka sign, lakh grouping and drops decimals only for whole amounts", () => {
    expect(formatMoney(1690, { code: "BDT" })).toBe("৳1,690");
    expect(formatMoney(230690, { code: "BDT" })).toBe("৳2,30,690");
    expect(formatMoney(12060.8, { code: "BDT" })).toBe("৳12,060.80");
    expect(formatMoney(1822.5, { code: "BDT" })).toBe("৳1,822.50");
    expect(formatMoney(-150, { code: "BDT" })).toBe("-৳150");
    expect(formatMoney(0, { code: "BDT" })).toBe("৳0");
  });

  it("honors other currencies' grouping and precision", () => {
    expect(formatMoney(1200.4, { symbol: "¥", code: "JPY" })).toBe("¥1,200");
    expect(formatMoney(1.2, { symbol: "KD ", code: "KWD" })).toBe("KD 1.200");
    expect(formatMoney(1234567.5, { code: "USD" })).toBe("$1,234,567.50");
  });
});
