import { describe, expect, it } from "vitest";

import {
  formatSavedMinorAmount,
  hasSavedOrderLineMoney,
  hasSavedOrderLineTax,
  resolveSavedOrderLineMoney,
  resolveSavedOrderMoneySummary,
} from "./order-tax-presentation";

const savedOrder = {
  currencyCode: "BDT",
  currencyDecimalPlaces: 2,
  subtotalAmountMinor: 20_000,
  shippingAmountMinor: 6_000,
  discountAmountMinor: 1_000,
  taxAmountMinor: 2_500,
  totalAmountMinor: 27_500,
  taxLabel: "VAT",
  pricesIncludeTax: false,
};

describe("storefront saved order tax presentation", () => {
  it("uses complete immutable minor-unit totals and their saved label", () => {
    const summary = resolveSavedOrderMoneySummary(savedOrder);

    expect(summary).toEqual({
      currencyCode: "BDT",
      decimalPlaces: 2,
      subtotalMinor: 20_000,
      shippingMinor: 6_000,
      discountMinor: 1_000,
      taxMinor: 2_500,
      totalMinor: 27_500,
      taxLabel: "VAT",
      pricesIncludeTax: false,
    });
    expect(formatSavedMinorAmount(summary!.taxMinor, summary!)).toBe("BDT 25.00");
    expect(formatSavedMinorAmount(summary!.totalMinor, summary!)).toBe("BDT 275.00");
    expect(formatSavedMinorAmount(1_234_500, summary!)).toBe("BDT 12,345.00");
  });

  it("falls back for legacy or inconsistent rows instead of inventing tax", () => {
    expect(resolveSavedOrderMoneySummary({
      ...savedOrder,
      subtotalAmountMinor: null,
      taxAmountMinor: 0,
    })).toBeNull();
    expect(resolveSavedOrderMoneySummary({
      ...savedOrder,
      totalAmountMinor: 27_499,
    })).toBeNull();
  });

  it("keeps a complete no-tax snapshot truthful without line-tax decoration", () => {
    const summary = resolveSavedOrderMoneySummary({
      ...savedOrder,
      taxAmountMinor: 0,
      totalAmountMinor: 25_000,
    });

    expect(summary?.taxMinor).toBe(0);
    const line = {
      unitPriceMinor: 20_000,
      lineSubtotalMinor: 20_000,
      discountAmountMinor: 1_000,
      taxableAmountMinor: 19_000,
      taxAmountMinor: 0,
    };
    expect(hasSavedOrderLineMoney(line, summary)).toBe(true);
    expect(hasSavedOrderLineTax(line, summary)).toBe(false);
    expect(resolveSavedOrderLineMoney(line, summary)?.totalMinor).toBe(19_000);
  });

  it("preserves the inclusive flag and accepts line tax only with a full snapshot", () => {
    const summary = resolveSavedOrderMoneySummary({
      ...savedOrder,
      pricesIncludeTax: true,
      totalAmountMinor: 25_000,
    });
    const line = {
      unitPriceMinor: 20_000,
      lineSubtotalMinor: 20_000,
      discountAmountMinor: 1_000,
      taxableAmountMinor: 16_500,
      taxAmountMinor: 2_500,
    };

    expect(summary?.pricesIncludeTax).toBe(true);
    expect(hasSavedOrderLineTax(line, summary)).toBe(true);
    expect(resolveSavedOrderLineMoney(line, summary)?.totalMinor).toBe(19_000);
    expect(hasSavedOrderLineTax({ ...line, taxableAmountMinor: null }, summary)).toBe(false);
  });
});
