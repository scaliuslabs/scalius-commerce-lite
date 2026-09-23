import { describe, expect, it } from "vitest";
import {
  bpsToPercent,
  discountedPriceMinor,
  fromMinor,
  percentToBps,
  toMinor,
} from "./money";

describe("toMinor / fromMinor", () => {
  it("converts decimal HTTP amounts to exact minor units at the currency precision", () => {
    expect(toMinor(12.6, 0)).toBe(13);
    expect(toMinor(12.345, 2)).toBe(1_235);
    expect(toMinor(1.005, 2)).toBe(101);
    expect(toMinor(12.345, 3)).toBe(12_345);
    expect(fromMinor(12_345, 3)).toBe(12.345);
    expect(fromMinor(1_235, 2)).toBe(12.35);
  });

  it("keeps 0.1 + 0.2 exact once amounts are integers", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(toMinor(0.1 + 0.2, 2)).toBe(30);
    expect(toMinor(0.1, 2) + toMinor(0.2, 2)).toBe(toMinor(0.3, 2));
    expect(fromMinor(toMinor(0.1, 2) + toMinor(0.2, 2), 2)).toBe(0.3);
  });

  it("rejects amounts that cannot be money", () => {
    expect(() => toMinor(-1, 2)).toThrow(RangeError);
    expect(() => toMinor(Number.NaN, 2)).toThrow(RangeError);
    expect(() => toMinor(1, 4)).toThrow(RangeError);
    expect(() => fromMinor(1.5, 2)).toThrow(RangeError);
  });
});

describe("percentage discounts", () => {
  it("stores percentages as basis points", () => {
    expect(percentToBps(12.5)).toBe(1_250);
    expect(percentToBps(null)).toBe(0);
    expect(percentToBps(150)).toBe(10_000);
    expect(bpsToPercent(1_250)).toBe(12.5);
  });

  it("prices each unit at round-half-up of price × (1 − rate)", () => {
    expect(discountedPriceMinor(1_005, "percentage", 5_000, 0)).toBe(503);
    expect(discountedPriceMinor(999, "percentage", 3_333, 0)).toBe(666);
    expect(discountedPriceMinor(180_000, "percentage", 1_500, 0)).toBe(153_000);
    expect(discountedPriceMinor(10_000, "flat", 0, 12_000)).toBe(0);
    expect(discountedPriceMinor(10_000, null, 5_000, 0)).toBe(10_000);
  });
});
