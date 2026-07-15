import { describe, expect, it } from "vitest";

import {
  SUPPORTED_CURRENCY_CODES,
  formatPriceShort,
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

describe("short currency formatting", () => {
  it("keeps whole BDT amounts compact and fractional amounts ISO-precise", () => {
    const options = { symbol: "৳", code: "BDT" };

    expect(formatPriceShort(1690, options)).toBe("৳1,690");
    expect(formatPriceShort(2658.8, options)).toBe("৳2,658.80");
  });

  it("honors zero- and three-decimal currencies", () => {
    expect(formatPriceShort(1200.4, { symbol: "¥", code: "JPY" })).toBe("¥1,200");
    expect(formatPriceShort(1.2, { symbol: "KD ", code: "KWD" })).toBe("KD 1.200");
  });
});
