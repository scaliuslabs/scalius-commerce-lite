import { describe, expect, it } from "vitest";
import {
  calculateDiscountedPriceAtPrecision,
  roundPriceToPrecision,
} from "./price-utils";

describe("roundPriceToPrecision", () => {
  it("preserves configured three-decimal currency amounts", () => {
    expect(roundPriceToPrecision(1.1106, 3)).toBe(1.111);
    expect(roundPriceToPrecision(1.234, 3)).toBe(1.234);
  });
});

describe("calculateDiscountedPriceAtPrecision", () => {
  it("applies percentage and flat discounts with the checkout integer rule", () => {
    expect(calculateDiscountedPriceAtPrecision(1800, "percentage", 15, 0, 2)).toBe(1530);
    expect(calculateDiscountedPriceAtPrecision(1800, "flat", 0, 200, 2)).toBe(1600);
    expect(calculateDiscountedPriceAtPrecision(100, "flat", 0, 150, 2)).toBe(0);
  });

  it("rounds the discounted unit price half-up in minor units", () => {
    // 10.05 at 50% is 502.5 paisa, which rounds up to 5.03.
    expect(calculateDiscountedPriceAtPrecision(10.05, "percentage", 50, null, 2)).toBe(5.03);
    expect(calculateDiscountedPriceAtPrecision(1.005, "percentage", 10, null, 2)).toBe(0.91);
  });
});
