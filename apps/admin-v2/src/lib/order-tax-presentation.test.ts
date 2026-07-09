import { describe, expect, it } from "vitest";

import {
  formatSavedMinorAmount,
  hasSavedOrderLineMoney,
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

describe("admin saved order tax presentation", () => {
  it("renders the complete saved calculation in its original currency", () => {
    const summary = resolveSavedOrderMoneySummary(savedOrder);
    expect(summary?.taxLabel).toBe("VAT");
    expect(formatSavedMinorAmount(summary!.totalMinor, summary!)).toBe("BDT 275.00");
  });

  it("rejects legacy, partial, and mismatched snapshots", () => {
    expect(resolveSavedOrderMoneySummary({ ...savedOrder, currencyCode: null })).toBeNull();
    expect(resolveSavedOrderMoneySummary({ ...savedOrder, totalAmountMinor: 27_499 })).toBeNull();
  });

  it("keeps a complete zero-tax snapshot without fabricating line tax", () => {
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
    expect(resolveSavedOrderLineMoney(line, summary)?.totalMinor).toBe(19_000);
  });

  it("preserves inclusive-tax semantics", () => {
    const summary = resolveSavedOrderMoneySummary({
      ...savedOrder,
      pricesIncludeTax: true,
      totalAmountMinor: 25_000,
    });
    expect(summary?.pricesIncludeTax).toBe(true);
    expect(summary?.taxMinor).toBe(2_500);
    expect(resolveSavedOrderLineMoney({
      unitPriceMinor: 20_000,
      lineSubtotalMinor: 20_000,
      discountAmountMinor: 1_000,
      taxableAmountMinor: 16_500,
      taxAmountMinor: 2_500,
    }, summary)?.totalMinor).toBe(19_000);
  });
});
