import { describe, expect, it } from "vitest";

import {
  cashIncrementMinor,
  cashOnDeliveryIncrementMinor,
  currencyExponent,
  currencyPolicy,
  defaultPriceIncrementMinor,
  EXCLUDED_CURRENCY_CODES,
  isPriceIncrementMinor,
  isWholeUnitIncrement,
  priceIncrementChoices,
  resolvePriceIncrementMinor,
  SUPPORTED_CURRENCY_CODES,
} from "./currency-policy";
import { getDecimalPlaces } from "./currency";
import { toMinor } from "./money";

// The ISO 4217 exponents money was stored at before the policy table: the
// table must not move a single stored amount.
const LEGACY_ISO_EXCEPTIONS: Record<string, number> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  PYG: 0, RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};

describe("currency policy table", () => {
  it("has one row for every supported code and keeps every storage exponent", () => {
    expect(SUPPORTED_CURRENCY_CODES).toHaveLength(156);
    for (const code of SUPPORTED_CURRENCY_CODES) {
      expect(currencyExponent(code), code).toBe(LEGACY_ISO_EXCEPTIONS[code] ?? 2);
      expect(getDecimalPlaces(code), code).toBe(currencyExponent(code));
      const policy = currencyPolicy(code);
      expect(policy.exponent).toBeLessThanOrEqual(3);
      expect(Number.isSafeInteger(policy.cashIncrementMinor) && policy.cashIncrementMinor >= 1, code).toBe(true);
      expect(policy.displayDigits).toBeLessThanOrEqual(policy.exponent);
    }
  });

  it("excludes the four-decimal ISO units on purpose: money paths refuse them", () => {
    for (const code of EXCLUDED_CURRENCY_CODES) {
      expect(SUPPORTED_CURRENCY_CODES as readonly string[]).not.toContain(code);
      expect(getDecimalPlaces(code)).toBe(4);
      expect(() => toMinor(1, getDecimalPlaces(code))).toThrow(RangeError);
    }
  });

  it("keeps the CLDR cash and display facts apart from the exponent", () => {
    expect(currencyPolicy("CHF").cashIncrementMinor).toBe(5);
    expect(currencyPolicy("CAD").cashIncrementMinor).toBe(5);
    expect(currencyPolicy("DKK").cashIncrementMinor).toBe(50);
    for (const code of ["SEK", "NOK", "PKR", "TWD", "HUF", "IDR"]) {
      expect(currencyPolicy(code).cashIncrementMinor, code).toBe(100);
    }
    expect(currencyPolicy("IQD")).toEqual({ code: "IQD", exponent: 3, cashIncrementMinor: 1_000, displayDigits: 0 });
    expect(currencyPolicy("KWD")).toEqual({ code: "KWD", exponent: 3, cashIncrementMinor: 1, displayDigits: 3 });
    // CLDR has no BDT entry: whole taka is policy, not a currency fact.
    expect(currencyPolicy(" bdt ")).toEqual({ code: "BDT", exponent: 2, cashIncrementMinor: 1, displayDigits: 2 });
    expect(currencyPolicy("ZZZ")).toEqual({ code: "ZZZ", exponent: 2, cashIncrementMinor: 1, displayDigits: 2 });
  });
});

describe("price increment policy", () => {
  it("defaults a BDT market to whole taka and every other currency to its minor unit", () => {
    expect(defaultPriceIncrementMinor("BDT")).toBe(100);
    expect(defaultPriceIncrementMinor("usd")).toBe(1);
    expect(defaultPriceIncrementMinor("JPY")).toBe(1);
    expect(isWholeUnitIncrement("BDT", 100)).toBe(true);
    expect(isWholeUnitIncrement("BDT", 1)).toBe(false);
    expect(isWholeUnitIncrement("JPY", 1)).toBe(false);
  });

  it("offers the minor or the whole unit and resolves anything else to the default", () => {
    expect(priceIncrementChoices("BDT")).toEqual([1, 100]);
    expect(priceIncrementChoices("KWD")).toEqual([1, 1_000]);
    expect(priceIncrementChoices("JPY")).toEqual([1]);
    expect(isPriceIncrementMinor("BDT", 1)).toBe(true);
    expect(isPriceIncrementMinor("BDT", 10)).toBe(false);
    expect(isPriceIncrementMinor("BDT", "100")).toBe(false);
    expect(resolvePriceIncrementMinor("BDT", undefined)).toBe(100);
    expect(resolvePriceIncrementMinor("BDT", 1)).toBe(1);
    expect(resolvePriceIncrementMinor("USD", 100)).toBe(100);
    expect(resolvePriceIncrementMinor("JPY", 100)).toBe(1);
  });
});

describe("cash increment", () => {
  it("collects whole taka in BDT and the CLDR cash increment elsewhere", () => {
    expect(cashOnDeliveryIncrementMinor("BDT")).toBe(100);
    expect(cashIncrementMinor("CHF")).toBe(5);
    expect(cashIncrementMinor("SEK")).toBe(100);
    expect(cashOnDeliveryIncrementMinor("CHF")).toBe(5);
    expect(cashOnDeliveryIncrementMinor("USD")).toBe(1);
    expect(cashIncrementMinor("JPY")).toBe(1);
  });
});
