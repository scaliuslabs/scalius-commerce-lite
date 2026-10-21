import { describe, expect, it } from "vitest";
import { defaultPriceIncrementMinor } from "./currency-policy";
import {
  bpsToPercent,
  discountedPriceMinor,
  floorToIncrementMinor,
  isIncrementMultipleMinor,
  percentOfMinor,
  fromMinor,
  percentToBps,
  discountPercentOff,
  priceIncrementMessage,
  PriceIncrementError,
  roundToIncrementMinor,
  toIncrementMinor,
  toMinor,
  WHOLE_TAKA_MESSAGE,
} from "./money";

const WHOLE_TAKA = defaultPriceIncrementMinor("BDT");
const MINOR = 1;

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
    // One badge rule for every theme: 3,800 of 4,400 is 13.6% off, shown as 13%.
    expect(discountPercentOff(4400, 3800)).toBe(13);
    expect(discountPercentOff(100, 80)).toBe(20);
    expect(discountPercentOff(1000, 999)).toBe(1);
    expect(discountPercentOff(100, 100)).toBeNull();
    expect(discountPercentOff(0, 0)).toBeNull();
    expect(percentToBps(null)).toBe(0);
    expect(percentToBps(150)).toBe(10_000);
    expect(bpsToPercent(1_250)).toBe(12.5);
  });

  it("prices each unit at round-half-up of price × (1 − rate)", () => {
    expect(discountedPriceMinor(1_005, "percentage", 5_000, 0, MINOR)).toBe(503);
    expect(discountedPriceMinor(999, "percentage", 3_333, 0, MINOR)).toBe(666);
    expect(discountedPriceMinor(180_000, "percentage", 1_500, 0, MINOR)).toBe(153_000);
    expect(discountedPriceMinor(10_000, "flat", 0, 12_000, MINOR)).toBe(0);
    expect(discountedPriceMinor(10_000, null, 5_000, 0, MINOR)).toBe(10_000);
  });

  it("rounds percentage prices half-up to a whole-taka increment, so COD totals are whole", () => {
    // ৳8,990 at 8% off is ৳8,270.80 exactly; buyers pay ৳8,271.
    expect(discountedPriceMinor(899_000, "percentage", 800, 0, WHOLE_TAKA)).toBe(827_100);
    // ৳250 at 5% off is ৳237.50: half-up to ৳238.
    expect(discountedPriceMinor(25_000, "percentage", 500, 0, WHOLE_TAKA)).toBe(23_800);
    // Flat discounts keep the merchant's exact amount.
    expect(discountedPriceMinor(25_050, "flat", 0, 50, WHOLE_TAKA)).toBe(25_000);
    expect(percentOfMinor(205_000, 1_500, WHOLE_TAKA)).toBe(30_800);
    expect(percentOfMinor(205_000, 1_500, MINOR)).toBe(30_750);
    expect(percentOfMinor(40, 10_000, WHOLE_TAKA)).toBe(40);
  });

  it("follows the market's increment, not the currency: a BDT store with paisa prices keeps paisa", () => {
    expect(discountedPriceMinor(899_000, "percentage", 800, 0, MINOR)).toBe(827_080);
    // A CHF market pricing in 5-rappen steps.
    expect(percentOfMinor(1_003, 1_000, 5)).toBe(100);
    expect(discountedPriceMinor(1_990, "percentage", 1_000, 0, 5)).toBe(1_790);
  });
});

describe("price increment amounts", () => {
  it("accepts multiples of the increment and refuses the rest with the policy's message", () => {
    expect(toIncrementMinor(60, 2, WHOLE_TAKA, "BDT")).toBe(6_000);
    expect(toIncrementMinor(1_250, 2, WHOLE_TAKA, "bdt")).toBe(125_000);
    expect(() => toIncrementMinor(60.5, 2, WHOLE_TAKA, "BDT")).toThrow(WHOLE_TAKA_MESSAGE);
    expect(() => toIncrementMinor(0.01, 2, WHOLE_TAKA, "BDT")).toThrow(PriceIncrementError);
    expect(toIncrementMinor(60.5, 2, MINOR, "BDT")).toBe(6_050);
    expect(toIncrementMinor(60.5, 2, MINOR, "USD")).toBe(6_050);
    expect(toIncrementMinor(0.01, 2, MINOR, "EUR")).toBe(1);
    expect(() => toIncrementMinor(12.5, 2, 100, "USD")).toThrow("USD amounts are whole numbers.");
    expect(priceIncrementMessage("CHF", 5)).toBe("CHF amounts go in steps of 0.05.");
  });

  it("rounds, floors and checks against the increment", () => {
    expect(roundToIncrementMinor(6_049, WHOLE_TAKA)).toBe(6_000);
    expect(roundToIncrementMinor(6_050, WHOLE_TAKA)).toBe(6_100);
    expect(roundToIncrementMinor(6_000, WHOLE_TAKA)).toBe(6_000);
    expect(roundToIncrementMinor(6_049, MINOR)).toBe(6_049);
    expect(floorToIncrementMinor(6_099, WHOLE_TAKA)).toBe(6_000);
    expect(floorToIncrementMinor(6_099, MINOR)).toBe(6_099);
    expect(isIncrementMultipleMinor(6_000, WHOLE_TAKA)).toBe(true);
    expect(isIncrementMultipleMinor(6_050, WHOLE_TAKA)).toBe(false);
    expect(isIncrementMultipleMinor(6_050, MINOR)).toBe(true);
    expect(() => roundToIncrementMinor(1, 0)).toThrow(RangeError);
  });
});
