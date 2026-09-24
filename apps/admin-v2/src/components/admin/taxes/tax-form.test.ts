import { describe, expect, it } from "vitest";

import type { TaxConfigurationPayload, TaxRateRecord } from "~/lib/api-query-options/taxes";

import {
  basisPointsToPercent,
  getRequiredTaxRateRoles,
  percentToBasisPoints,
  resolveJurisdictionSelection,
  taxSettingsIssue,
} from "./tax-form";

function rate(overrides: Partial<TaxRateRecord> = {}): TaxRateRecord {
  return {
    id: "rate_1",
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
    ...overrides,
  };
}

function configuration(overrides: Partial<TaxConfigurationPayload> = {}): TaxConfigurationPayload {
  return {
    settings: {
      id: "default",
      enabled: false,
      pricesIncludeTax: false,
      taxShipping: false,
      defaultTaxClassId: "class_standard",
      shippingTaxClassId: null,
      displayLabel: "Tax",
      version: 1,
      createdAt: null,
      updatedAt: null,
    },
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
    jurisdictions: [],
    ...overrides,
  };
}

const draft = {
  enabled: true,
  taxShipping: false,
  defaultTaxClassId: "class_standard" as string | null,
  shippingTaxClassId: null as string | null,
  displayLabel: "Tax",
};

describe("tax form boundaries", () => {
  it("converts merchant percentages to exact basis points", () => {
    expect(percentToBasisPoints("15")).toBe(1500);
    expect(percentToBasisPoints("7.25")).toBe(725);
    expect(percentToBasisPoints("100.00")).toBe(10_000);
    expect(percentToBasisPoints("7.255")).toBeNull();
    expect(percentToBasisPoints("100.01")).toBeNull();
    expect(percentToBasisPoints("-1")).toBeNull();
    expect(percentToBasisPoints("১৫")).toBe(1500);
    expect(percentToBasisPoints("৭.২৫")).toBe(725);
    expect(basisPointsToPercent(725)).toBe("7.25");
  });

  it("blocks collecting tax without a default group", () => {
    const config = configuration();
    expect(taxSettingsIssue({ ...draft, defaultTaxClassId: null }, config))
      .toEqual({ field: "default", key: "defaultRequired" });
    expect(taxSettingsIssue({ ...draft, enabled: false, defaultTaxClassId: null }, config)).toBeNull();
    expect(taxSettingsIssue({ ...draft, displayLabel: "  " }, config))
      .toEqual({ field: "label", key: "labelRequired" });
    expect(taxSettingsIssue({ ...draft, enabled: false, defaultTaxClassId: "class_gone" }, config))
      .toEqual({ field: "default", key: "groupMissing" });
  });

  it("blocks collecting tax until product and delivery groups have an active rate", () => {
    const config = configuration();
    expect(taxSettingsIssue(draft, config))
      .toEqual({ field: "default", key: "groupNeedsRate", name: "Standard" });

    config.rates.push(rate());
    config.classes.push({ ...config.classes[0]!, id: "class_shipping", name: "Shipping" });
    expect(taxSettingsIssue(draft, config)).toBeNull();
    expect(taxSettingsIssue({ ...draft, taxShipping: true, shippingTaxClassId: "class_shipping" }, config))
      .toEqual({ field: "delivery", key: "groupNeedsRate", name: "Shipping" });

    config.rates.push(rate({ id: "rate_2", taxClassId: "class_shipping", isActive: false }));
    expect(taxSettingsIssue({ ...draft, taxShipping: true, shippingTaxClassId: "class_shipping" }, config))
      .not.toBeNull();
    config.classes[1]!.isExempt = true;
    expect(taxSettingsIssue({ ...draft, taxShipping: true, shippingTaxClassId: "class_shipping" }, config)).toBeNull();
  });

  it("accepts only saved delivery places", () => {
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

  it("protects only the last active rate of the default and delivery groups", () => {
    const config = configuration({ rates: [rate()] });
    config.settings.enabled = true;
    config.settings.taxShipping = true;
    expect(getRequiredTaxRateRoles(config, config.rates[0]!)).toEqual(["products", "delivery"]);

    config.rates.push(rate({ id: "rate_2" }));
    expect(getRequiredTaxRateRoles(config, config.rates[0]!)).toEqual([]);
  });

  it("does not protect rates while tax is off or the group is tax-free", () => {
    const config = configuration({ rates: [rate()] });
    expect(getRequiredTaxRateRoles(config, config.rates[0]!)).toEqual([]);
    config.settings.enabled = true;
    config.classes[0]!.isExempt = true;
    expect(getRequiredTaxRateRoles(config, config.rates[0]!)).toEqual([]);
  });
});
