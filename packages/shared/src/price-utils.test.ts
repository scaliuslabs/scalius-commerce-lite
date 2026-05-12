import { describe, expect, it } from "vitest";
import { calculateDiscountedPrice } from "./price-utils";

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
