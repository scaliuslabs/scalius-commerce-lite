import { describe, expect, it } from "vitest";
import {
  calculateDiscountedPrice,
  calculateDiscountedPriceAtPrecision,
  roundPriceToPrecision,
} from "./price-utils";

describe("calculateDiscountedPrice", () => {
  it("applies percentage discounts", () => {
    expect(calculateDiscountedPrice(1800, "percentage", 15, 0)).toBe(1530);
  });

  it("applies flat amount discounts", () => {
    expect(calculateDiscountedPrice(1800, "flat", 0, 200)).toBe(1600);
  });

  it("does not produce negative prices for flat discounts", () => {
    expect(calculateDiscountedPrice(100, "flat", 0, 150)).toBe(0);
  });
});

describe("roundPriceToPrecision", () => {
  it("preserves configured three-decimal currency amounts", () => {
    expect(roundPriceToPrecision(1.1106, 3)).toBe(1.111);
    expect(roundPriceToPrecision(1.234, 3)).toBe(1.234);
  });
});

describe("calculateDiscountedPriceAtPrecision", () => {
  it("discounts the raw price before currency rounding like checkout", () => {
    expect(
      calculateDiscountedPriceAtPrecision(1.005, "percentage", 10, null, 2),
    ).toBe(0.9);
  });
});
