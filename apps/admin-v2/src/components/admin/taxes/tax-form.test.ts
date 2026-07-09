import { describe, expect, it } from "vitest";

import {
  basisPointsToPercent,
  percentToBasisPoints,
  resolveJurisdictionSelection,
  taxSettingsIssue,
} from "./tax-form";

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
