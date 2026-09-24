import { describe, expect, it } from "vitest";
import {
  bpsToPercent,
  cashRoundingMinor,
  discountedPriceMinor,
  percentOfMinor,
  fromMinor,
  percentToBps,
  roundToCashMinor,
  toCashMinor,
  toMinor,
  WHOLE_TAKA_MESSAGE,
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
    expect(discountedPriceMinor(1_005, "percentage", 5_000, 0, "USD")).toBe(503);
    expect(discountedPriceMinor(999, "percentage", 3_333, 0, "USD")).toBe(666);
    expect(discountedPriceMinor(180_000, "percentage", 1_500, 0, "USD")).toBe(153_000);
    expect(discountedPriceMinor(10_000, "flat", 0, 12_000, "USD")).toBe(0);
    expect(discountedPriceMinor(10_000, null, 5_000, 0, "USD")).toBe(10_000);
  });

  it("rounds BDT percentage prices half-up to whole taka, so COD totals are whole", () => {
    // ৳8,990 at 8% off is ৳8,270.80 exactly; buyers pay ৳8,271.
    expect(discountedPriceMinor(899_000, "percentage", 800, 0, "BDT")).toBe(827_100);
    // ৳250 at 5% off is ৳237.50: half-up to ৳238.
    expect(discountedPriceMinor(25_000, "percentage", 500, 0, "BDT")).toBe(23_800);
    // Flat discounts keep the merchant's exact amount.
    expect(discountedPriceMinor(25_050, "flat", 0, 50, "BDT")).toBe(25_000);
    expect(percentOfMinor(205_000, 1_500, "BDT")).toBe(30_800);
    expect(percentOfMinor(205_000, 1_500, "USD")).toBe(30_750);
    expect(percentOfMinor(40, 10_000, "BDT")).toBe(40);
    expect(cashRoundingMinor(" bdt ")).toBe(100);
  });
});

describe("whole-taka amounts", () => {
  it("accepts whole taka and refuses paisa in BDT; other currencies keep minor units", () => {
    expect(toCashMinor(60, 2, "BDT")).toBe(6_000);
    expect(toCashMinor(1_250, 2, "bdt")).toBe(125_000);
    expect(() => toCashMinor(60.5, 2, "BDT")).toThrow(WHOLE_TAKA_MESSAGE);
    expect(() => toCashMinor(0.01, 2, "BDT")).toThrow(WHOLE_TAKA_MESSAGE);
    expect(toCashMinor(60.5, 2, "USD")).toBe(6_050);
    expect(toCashMinor(0.01, 2, "EUR")).toBe(1);
  });

  it("rounds existing amounts half-up to whole taka, and leaves other currencies alone", () => {
    expect(roundToCashMinor(6_049, "BDT")).toBe(6_000);
    expect(roundToCashMinor(6_050, "BDT")).toBe(6_100);
    expect(roundToCashMinor(6_000, "BDT")).toBe(6_000);
    expect(roundToCashMinor(6_049, "USD")).toBe(6_049);
  });
});
