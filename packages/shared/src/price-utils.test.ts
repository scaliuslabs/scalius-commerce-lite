import { describe, expect, it } from "vitest";
import {
  calculateDiscountedPrice,
  roundPriceToPrecision,
} from "./price-utils";

describe("roundPriceToPrecision", () => {
  it("preserves configured three-decimal currency amounts", () => {
    expect(roundPriceToPrecision(1.1106, 3)).toBe(1.111);
    expect(roundPriceToPrecision(1.234, 3)).toBe(1.234);
  });
});

describe("calculateDiscountedPrice", () => {
  it("applies percentage and flat discounts with the checkout integer rule", () => {
    expect(calculateDiscountedPrice(1800, "percentage", 15, 0, "USD")).toBe(1530);
    expect(calculateDiscountedPrice(1800, "flat", 0, 200, "USD")).toBe(1600);
    expect(calculateDiscountedPrice(100, "flat", 0, 150, "USD")).toBe(0);
  });

  it("rounds the discounted unit price half-up in minor units", () => {
    // 10.05 at 50% is 502.5 paisa, which rounds up to 5.03.
    expect(calculateDiscountedPrice(10.05, "percentage", 50, null, "USD")).toBe(5.03);
    expect(calculateDiscountedPrice(1.005, "percentage", 10, null, "USD")).toBe(0.91);
  });

  it("rounds BDT percentage prices to whole taka", () => {
    expect(calculateDiscountedPrice(8990, "percentage", 8, null, "BDT")).toBe(8271);
    expect(calculateDiscountedPrice(8990, "flat", 0, 0.5, "BDT")).toBe(8989.5);
  });
});
