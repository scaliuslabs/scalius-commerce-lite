import { describe, expect, it } from "vitest";

import type { TaxConfigurationPayload } from "@/lib/api-functions/taxes";

import {
  basisPointsToPercent,
  percentToBasisPoints,
  resolveJurisdictionSelection,
  taxSettingsIssue,
} from "./tax-form";

function taxConfiguration(): Pick<TaxConfigurationPayload, "classes" | "rates"> {
  return {
    classes: [{
      id: "class_standard",
      name: "Standard",
      description: null,
      isExempt: false,
      version: 1,
      createdAt: null,
      updatedAt: null,
      deletedAt: null,
    }],
    rates: [],
  };
}

describe("tax form boundaries", () => {
  it("converts merchant percentages to exact basis points", () => {
    expect(percentToBasisPoints("15")).toBe(1500);
    expect(percentToBasisPoints("7.25")).toBe(725);
    expect(percentToBasisPoints("100.00")).toBe(10_000);
    expect(percentToBasisPoints("7.255")).toBeNull();
    expect(percentToBasisPoints("100.01")).toBeNull();
    expect(basisPointsToPercent(725)).toBe("7.25");
  });

  it("prevents enabling an unclassified configuration", () => {
    expect(taxSettingsIssue({
      enabled: true,
      taxShipping: false,
      defaultTaxClassId: null,
      shippingTaxClassId: null,
      displayLabel: "Tax",
    })).toContain("default tax class");
    expect(taxSettingsIssue({
      enabled: false,
      taxShipping: false,
      defaultTaxClassId: null,
      shippingTaxClassId: null,
      displayLabel: "Tax",
    })).toBeNull();
  });

  it("explains missing product and shipping rates before submit", () => {
    const configuration = taxConfiguration();
    expect(taxSettingsIssue({
      enabled: true,
      taxShipping: false,
      defaultTaxClassId: "class_standard",
      shippingTaxClassId: null,
      displayLabel: "Tax",
    }, configuration)).toContain("active rate to default product class");

    configuration.rates.push({
      id: "rate_standard",
      taxClassId: "class_standard",
      name: "Standard rate",
      rateBps: 1500,
      jurisdictionType: "all",
      jurisdictionId: null,
      jurisdictionLabel: null,
      priority: 0,
      isCompound: false,
      isActive: true,
      version: 1,
      createdAt: null,
      updatedAt: null,
      deletedAt: null,
    });
    configuration.classes.push({
      ...configuration.classes[0]!,
      id: "class_shipping",
      name: "Shipping",
    });

    expect(taxSettingsIssue({
      enabled: true,
      taxShipping: true,
      defaultTaxClassId: "class_standard",
      shippingTaxClassId: "class_shipping",
      displayLabel: "Tax",
    }, configuration)).toContain("active rate to shipping class");
  });

  it("accepts only authoritative jurisdiction options", () => {
    const options = [{ id: "city_1", name: "Dhaka", type: "city" as const, parentId: null }];
    expect(resolveJurisdictionSelection("city", "city_1", options)).toEqual({
      jurisdictionId: "city_1",
      jurisdictionLabel: "Dhaka",
    });
    expect(resolveJurisdictionSelection("zone", "city_1", options)).toBeNull();
    expect(resolveJurisdictionSelection("all", "anything", options)).toEqual({
      jurisdictionId: null,
      jurisdictionLabel: null,
    });
  });
});
