import { describe, expect, it } from "vitest";

import {
  bundleTotalMinor,
  productBundleTierListSchema,
  selectBundleTier,
  type ProductBundleTier,
} from "./product-bundles";

const pair: ProductBundleTier = { quantity: 2, discountType: "percentage", discountBps: 1_000, label: "Pair", isActive: true };
const threeFor: ProductBundleTier = { quantity: 3, discountType: "fixed_price", priceMinor: 90_000, label: null, isActive: true };

describe("quantity bundles", () => {
  it("picks the deepest active tier the quantity reaches", () => {
    expect(selectBundleTier(1, [pair, threeFor])).toBeNull();
    expect(selectBundleTier(2, [pair, threeFor])).toBe(pair);
    expect(selectBundleTier(7, [pair, threeFor])).toBe(threeFor);
    expect(selectBundleTier(7, [pair, { ...threeFor, isActive: false }])).toBe(pair);
  });

  it("prices percentage tiers per unit with whole-taka rounding", () => {
    // ৳333 less 10% = ৳299.70 -> ৳300 per unit (half-up to whole taka).
    expect(bundleTotalMinor(33_300, 2, [pair], "BDT")).toEqual({ totalMinor: 60_000, savingMinor: 6_600, tier: pair });
    expect(bundleTotalMinor(33_300, 1, [pair], "BDT")).toEqual({ totalMinor: 33_300, savingMinor: 0, tier: null });
  });

  it("prices fixed sets and leaves the remainder at the unit price, never above buying singly", () => {
    expect(bundleTotalMinor(35_000, 7, [pair, threeFor], "BDT")).toEqual({
      totalMinor: 2 * 90_000 + 35_000,
      savingMinor: 7 * 35_000 - (2 * 90_000 + 35_000),
      tier: threeFor,
    });
    expect(bundleTotalMinor(20_000, 3, [threeFor], "BDT").totalMinor).toBe(60_000);
  });

  it("refuses non-integer money and duplicate tiers", () => {
    expect(() => bundleTotalMinor(10.5, 2, [pair], "BDT")).toThrow(RangeError);
    expect(productBundleTierListSchema.safeParse([pair, { ...pair, discountBps: 500 }]).success).toBe(false);
    expect(productBundleTierListSchema.safeParse([pair, threeFor]).success).toBe(true);
    expect(productBundleTierListSchema.safeParse([{ ...threeFor, priceMinor: 0 }]).success).toBe(false);
  });
});
