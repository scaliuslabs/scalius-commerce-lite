import { describe, expect, it } from "vitest";

import {
  calculateCatalogFeedDiscountedAmount,
  formatCatalogFeedAmount,
  getCatalogFeedFractionDigits,
  isCatalogFeedSalePrice,
  isPositiveCatalogFeedAmount,
  quantizeCatalogFeedAmount,
} from "./catalog-feed-money";

describe("catalog feed money", () => {
  it.each([
    ["BDT", 2],
    ["KWD", 2],
    ["JPY", 0],
    ["CLP", 0],
    ["UGX", 0],
    ["krw", 0],
    ["VND", 0],
  ] as const)("uses the supported feed precision for %s", (currency, digits) => {
    expect(getCatalogFeedFractionDigits(currency)).toBe(digits);
  });

  it.each([
    [0.004, "BDT", false],
    [0.005, "BDT", true],
    [0.4, "JPY", false],
    [0.5, "JPY", true],
    [1, "BDT", true],
    [0, "BDT", false],
    [-1, "BDT", false],
    [Number.NaN, "BDT", false],
  ] as const)(
    "classifies %s %s after feed quantization",
    (amount, currency, expected) => {
      expect(isPositiveCatalogFeedAmount(amount, currency)).toBe(expected);
    },
  );

  it("uses currency.js quantization for the exact 1.005 boundary", () => {
    expect(quantizeCatalogFeedAmount(1.005, "BDT")).toBe(1.01);
    expect(formatCatalogFeedAmount(1.005, "BDT")).toBe("1.01");
    expect(isPositiveCatalogFeedAmount(1.005, "BDT")).toBe(true);
    expect(
      calculateCatalogFeedDiscountedAmount(
        1.005,
        "percentage",
        10,
        null,
        "USD",
        1,
      ),
    ).toBe(0.91);
    // Feed prices follow checkout's price increment: whole taka by default in BDT.
    expect(calculateCatalogFeedDiscountedAmount(8990, "percentage", 8, null, "BDT", 100)).toBe(8271);
    expect(calculateCatalogFeedDiscountedAmount(8990, "percentage", 8, null, "BDT", 1)).toBe(8270.8);
  });

  it("rejects exponent-form legacy amounts instead of emitting invalid XML money", () => {
    expect(formatCatalogFeedAmount(1e21, "BDT")).toBeNull();
    expect(isPositiveCatalogFeedAmount(1e21, "BDT")).toBe(false);
    expect(isCatalogFeedSalePrice(1e21, 1, "BDT")).toBe(false);
  });

  it("calculates at currency precision before catalog comparison", () => {
    expect(
      calculateCatalogFeedDiscountedAmount(10.4, "flat", null, 10, "BDT", 100),
    ).toBe(0.4);
    expect(
      calculateCatalogFeedDiscountedAmount(10.4, "flat", null, 10, "JPY", 1),
    ).toBe(0);
    expect(
      calculateCatalogFeedDiscountedAmount(
        1.236,
        "percentage",
        1,
        null,
        "KWD",
        1,
      ),
    ).toBe(1.22);
    expect(isCatalogFeedSalePrice(1.234, 1.233, "KWD")).toBe(false);
    expect(isCatalogFeedSalePrice(1.236, 1.224, "KWD")).toBe(true);
  });
});
