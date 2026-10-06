import { describe, expect, it } from "vitest";
import { defaultCurrencyForCountry, defaultCurrencySymbol, defaultUnitSystemForCountry } from "./store-country-defaults";
import { normalizeWeightUnit } from "./store-defaults";
import { gramsToWeightUnit, weightUnitToGrams } from "./weight-units";

describe("store defaults", () => {
  it("takes a new store's currency and units from its country (CLDR)", () => {
    expect(defaultCurrencyForCountry("BD")).toBe("BDT");
    expect(defaultCurrencyForCountry("us")).toBe("USD");
    expect(defaultCurrencyForCountry("DE")).toBe("EUR");
    expect(defaultCurrencyForCountry("IN")).toBe("INR");
    // No tender of its own, or one Scalius does not sell in: US dollars.
    expect(defaultCurrencyForCountry("AQ")).toBe("USD");
    expect(defaultUnitSystemForCountry("US")).toBe("imperial");
    expect(defaultUnitSystemForCountry("LR")).toBe("imperial");
    expect(defaultUnitSystemForCountry("GB")).toBe("metric");
    expect(defaultUnitSystemForCountry("BD")).toBe("metric");
    expect(defaultCurrencySymbol("USD")).toBe("$");
    expect(defaultCurrencySymbol("BDT")).toBe("৳");
  });

  it("converts gram weights to the store's unit and back without drift", () => {
    expect(gramsToWeightUnit(1500, "kg")).toBe(1.5);
    expect(gramsToWeightUnit(453.59, "lb")).toBe(1);
    expect(gramsToWeightUnit(250, "g")).toBe(250);
    expect(gramsToWeightUnit(null, "kg")).toBeNull();
    expect(weightUnitToGrams(1.5, "lb")).toBe(680.39);
    expect(weightUnitToGrams(8, "oz")).toBe(226.8);
    expect(gramsToWeightUnit(weightUnitToGrams(1.5, "lb"), "lb")).toBe(1.5);
    expect(gramsToWeightUnit(weightUnitToGrams(2.25, "kg"), "kg")).toBe(2.25);
  });

  it("keeps a weight unit inside its system", () => {
    expect(normalizeWeightUnit(undefined, "metric")).toBe("g");
    expect(normalizeWeightUnit("kg", "metric")).toBe("kg");
    expect(normalizeWeightUnit("kg", "imperial")).toBe("lb");
    expect(normalizeWeightUnit(undefined, "imperial")).toBe("lb");
  });
});
