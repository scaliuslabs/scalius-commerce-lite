import { describe, expect, it } from "vitest";

import {
  DEFAULT_EMI_SETTINGS,
  emiQuote,
  emiQuotes,
  lowestEmiQuote,
  normalizeEmiSettings,
  type EmiPlan,
} from "./emi";

const plan = (overrides: Partial<EmiPlan> = {}): EmiPlan => ({
  id: "city-6",
  provider: "City Bank",
  months: 6,
  feeBps: 300,
  minAmountMinor: 500_000,
  ...overrides,
});

describe("EMI quotes", () => {
  it("adds the conversion fee and rounds the monthly amount up to whole taka", () => {
    // ৳64,999 at 3% over 6 months: fee ৳1,949.97 -> ৳1,950; total ৳66,949; ৳11,158.17 -> ৳11,159.
    expect(emiQuote(6_499_900, plan(), "BDT")).toEqual({
      planId: "city-6",
      provider: "City Bank",
      months: 6,
      feeMinor: 195_000,
      totalMinor: 6_694_900,
      monthlyMinor: 1_115_900,
    });
  });

  it("always covers the total with less than one cash unit per month to spare", () => {
    for (const currency of ["BDT", "USD"]) {
      const unit = currency === "BDT" ? 100 : 1;
      for (let price = 1_000; price < 5_000_000; price += 77_777) {
        for (const months of [2, 3, 6, 9, 12, 18, 24, 36]) {
          for (const feeBps of [0, 150, 450, 999]) {
            const quote = emiQuote(price, plan({ months, feeBps, minAmountMinor: 0 }), currency)!;
            expect(Number.isSafeInteger(quote.monthlyMinor)).toBe(true);
            expect(quote.monthlyMinor % unit).toBe(0);
            expect(quote.monthlyMinor * months).toBeGreaterThanOrEqual(quote.totalMinor);
            expect(quote.monthlyMinor * months - quote.totalMinor).toBeLessThan(months * unit);
            expect(quote.totalMinor).toBe(price + quote.feeMinor);
          }
        }
      }
    }
  });

  it("applies a plan only from its minimum price and never to a free product", () => {
    expect(emiQuote(499_900, plan(), "BDT")).toBeNull();
    expect(emiQuote(0, plan({ minAmountMinor: 0 }), "BDT")).toBeNull();
    expect(() => emiQuote(12.5, plan(), "BDT")).toThrow(RangeError);
  });

  it("offers nothing while EMI is off and the cheapest month first when on", () => {
    const plans = [plan(), plan({ id: "ebl-12", provider: "EBL", months: 12, feeBps: 600 }), plan({ id: "brac-3", months: 3, feeBps: 0 })];
    expect(emiQuotes(6_000_000, { enabled: false, plans }, "BDT")).toEqual([]);
    const quotes = emiQuotes(6_000_000, { enabled: true, plans }, "BDT");
    expect(quotes.map((quote) => quote.planId)).toEqual(["ebl-12", "city-6", "brac-3"]);
    expect(lowestEmiQuote(6_000_000, { enabled: true, plans }, "BDT")?.monthlyMinor).toBe(530_000);
    expect(lowestEmiQuote(100_000, { enabled: true, plans }, "BDT")).toBeNull();
  });

  it("reads stored settings strictly and fails closed", () => {
    expect(normalizeEmiSettings(undefined)).toEqual(DEFAULT_EMI_SETTINGS);
    expect(normalizeEmiSettings({ enabled: true, plans: [plan(), plan()] })).toEqual({ enabled: false, plans: [] });
    expect(normalizeEmiSettings({ enabled: true, plans: [{ ...plan(), feeBps: 9_000 }] })).toEqual({ enabled: false, plans: [] });
    expect(normalizeEmiSettings({ enabled: true, plans: [plan()] })).toEqual({ enabled: true, plans: [plan()] });
  });
});
