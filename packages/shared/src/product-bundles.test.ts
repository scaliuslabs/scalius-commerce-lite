import { describe, expect, it } from "vitest";

import {
  bundleGroupPricing,
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

describe("bundle group pricing (checkout)", () => {
  const line = (key: string, unitPriceMinor: number, quantity: number) => ({ key, unitPriceMinor, quantity });

  it("equals bundleTotalMinor for one unit price, split over the group's lines", () => {
    for (const quantity of [1, 2, 3, 4, 6, 7, 10]) {
      for (const tiers of [[pair], [threeFor], [pair, threeFor]]) {
        const single = bundleTotalMinor(35_000, quantity, tiers, "BDT");
        const split = bundleGroupPricing(
          [line("a", 35_000, Math.ceil(quantity / 2)), ...(quantity > 1 ? [line("b", 35_000, Math.floor(quantity / 2))] : [])],
          tiers,
          "BDT",
        );
        expect(split.totalMinor, `${quantity} × ${tiers.length}`).toBe(single.totalMinor);
        expect(split.savingMinor).toBe(single.savingMinor);
        expect(split.lineSavings.reduce((sum, each) => sum + each.savingMinor, 0)).toBe(single.savingMinor);
      }
    }
  });

  it("counts the whole product group toward the tier, across SKUs", () => {
    // One of each size reaches the pair tier; 10% of ৳500 and of ৳700.
    const result = bundleGroupPricing([line("s", 50_000, 1), line("l", 70_000, 1)], [pair], "BDT");
    expect(result.tier).toBe(pair);
    expect(result.lineSavings).toEqual([{ key: "s", savingMinor: 5_000 }, { key: "l", savingMinor: 7_000 }]);
    expect(result.totalMinor).toBe(108_000);
  });

  it("forms fixed-price sets from the dearest units and splits each set's saving in whole taka", () => {
    // 3 for ৳900 over 2 × ৳400 and 2 × ৳250: the set is 400+400+250 = ৳1,050 -> ৳900; ৳250 stays.
    const result = bundleGroupPricing([line("cheap", 25_000, 2), line("dear", 40_000, 2)], [threeFor], "BDT");
    expect(result.plainMinor).toBe(130_000);
    expect(result.totalMinor).toBe(115_000);
    expect(result.savingMinor).toBe(15_000);
    for (const each of result.lineSavings) expect(each.savingMinor % 100).toBe(0);
    // ৳150 over (400, 400, 250): 57.14 + 57.14 + 35.71 -> 57 + 57 + 36.
    expect(result.lineSavings).toEqual([{ key: "cheap", savingMinor: 3_600 }, { key: "dear", savingMinor: 11_400 }]);
  });

  it("never charges a set more than its units bought singly", () => {
    const result = bundleGroupPricing([line("a", 20_000, 3)], [threeFor], "BDT");
    expect(result).toMatchObject({ tier: null, savingMinor: 0, totalMinor: 60_000 });
  });

  it("keeps whole taka for percentage tiers on odd prices", () => {
    // ৳333 less 10% = ৳299.70 -> ৳300: a ৳33 saving per unit, never paisa.
    const result = bundleGroupPricing([line("a", 33_300, 1), line("b", 33_300, 2)], [pair], "BDT");
    expect(result.lineSavings).toEqual([{ key: "a", savingMinor: 3_300 }, { key: "b", savingMinor: 6_600 }]);
    // USD keeps cents: $3.33 less 10% = $3.00 (half-up of 2.997).
    expect(bundleGroupPricing([line("a", 333, 2)], [pair], "USD").savingMinor).toBe(66);
  });

  it("refuses non-integer money and duplicate line keys", () => {
    expect(() => bundleGroupPricing([line("a", 10.5, 2)], [pair], "BDT")).toThrow(RangeError);
    expect(() => bundleGroupPricing([line("a", 100, 0)], [pair], "BDT")).toThrow(RangeError);
    expect(() => bundleGroupPricing([line("a", 100, 1), line("a", 100, 1)], [pair], "BDT")).toThrow(RangeError);
  });
});
