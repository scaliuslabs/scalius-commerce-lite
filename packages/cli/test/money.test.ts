import { describe, expect, it } from "vitest";
import { amountToMinor, currencyDecimals, formatMinor } from "../src/money.js";

const bdt = { code: "BDT", decimals: 2 };
const jpy = { code: "JPY", decimals: 0 };
const kwd = { code: "KWD", decimals: 3 };

describe("amountToMinor", () => {
  it("converts exactly, with no float error", () => {
    expect(amountToMinor("1500", bdt, "set", { signed: false })).toBe(150000);
    expect(amountToMinor("19.99", bdt, "set", { signed: false })).toBe(1999);
    expect(amountToMinor("0.29", bdt, "set", { signed: false })).toBe(29);
    expect(amountToMinor("1.1", bdt, "set", { signed: false })).toBe(110);
    expect(amountToMinor("2.500", kwd, "set", { signed: false })).toBe(2500);
    expect(amountToMinor("800", jpy, "set", { signed: false })).toBe(800);
    expect(amountToMinor("12.00", jpy, "set", { signed: false })).toBe(12);
  });

  it("keeps the sign only where the flag allows it", () => {
    expect(amountToMinor("-100", bdt, "amount", { signed: true })).toBe(-10000);
    expect(amountToMinor("+5.5", bdt, "amount", { signed: true })).toBe(550);
    expect(() => amountToMinor("-1", bdt, "set", { signed: false })).toThrow(/must not be negative/);
  });

  it("refuses what is not an amount or has too many decimals", () => {
    for (const text of ["", "ten", "1e3", "1,500", ".5", "5.", "0x10"]) {
      expect(() => amountToMinor(text, bdt, "set", { signed: false })).toThrow(/must be an amount in BDT/);
    }
    expect(() => amountToMinor("1.005", bdt, "set", { signed: false })).toThrow(/BDT has 2 decimal places/);
    expect(() => amountToMinor("1.5", jpy, "set", { signed: false })).toThrow(/JPY has 0 decimal places/);
    expect(() => amountToMinor("99999999999999", bdt, "set", { signed: false })).toThrow(/too large/);
  });
});

describe("formatMinor and currencyDecimals", () => {
  it("prints minor units as an amount in the currency", () => {
    expect(formatMinor(150000, bdt)).toBe("1500.00 BDT");
    expect(formatMinor(-5, bdt)).toBe("-0.05 BDT");
    expect(formatMinor(1500, jpy)).toBe("1500 JPY");
    expect(formatMinor(2500, kwd)).toBe("2.500 KWD");
  });

  it("knows the ISO decimal places of a currency", () => {
    expect(currencyDecimals("BDT")).toBe(2);
    expect(currencyDecimals("JPY")).toBe(0);
    expect(currencyDecimals("KWD")).toBe(3);
    expect(currencyDecimals("not-a-code")).toBeUndefined();
  });
});
