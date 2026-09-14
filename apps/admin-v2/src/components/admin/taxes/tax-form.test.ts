import { describe, expect, it } from "vitest";

import type { TaxConfigurationPayload } from "~/lib/api-functions/taxes";

import {
  basisPointsToPercent,
  buildTaxSettingsDraft,
  percentToBasisPoints,
  resolveJurisdictionSelection,
  taxSettingsFieldIssues,
  taxSettingsFormIsDirty,
  taxSettingsIssue,
  taxSettingsSaveBarState,
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

  it("distinguishes a saved tax policy from a merchant draft", () => {
    const saved = {
      expectedVersion: 4,
      enabled: false,
      pricesIncludeTax: false,
      taxShipping: false,
      defaultTaxClassId: "class_standard",
      shippingTaxClassId: null,
      displayLabel: "Tax",
    };

    expect(taxSettingsFormIsDirty(saved, { ...saved })).toBe(false);
    expect(taxSettingsFormIsDirty({ ...saved, displayLabel: "VAT" }, saved)).toBe(true);
    expect(taxSettingsFormIsDirty({ ...saved, taxShipping: true }, saved)).toBe(true);
  });

  it("reports validation against the field that owns it", () => {
    const configuration = taxConfiguration();

    expect(taxSettingsFieldIssues({
      enabled: false,
      taxShipping: false,
      defaultTaxClassId: "class_standard",
      shippingTaxClassId: null,
      displayLabel: "   ",
    }, configuration)).toEqual({
      displayLabel: "Enter the buyer-facing tax label.",
    });

    const enabledWithoutClass = taxSettingsFieldIssues({
      enabled: true,
      taxShipping: true,
      defaultTaxClassId: null,
      shippingTaxClassId: null,
      displayLabel: "Tax",
    }, configuration);
    expect(enabledWithoutClass.displayLabel).toBeUndefined();
    expect(enabledWithoutClass.defaultTaxClassId).toContain("default tax class");
    expect(enabledWithoutClass.shippingTaxClassId).toContain(
      "shipping or default class",
    );

    expect(taxSettingsFieldIssues({
      enabled: true,
      taxShipping: false,
      defaultTaxClassId: "class_standard",
      shippingTaxClassId: null,
      displayLabel: "Tax",
    }, configuration).defaultTaxClassId).toContain(
      "active rate to default product class",
    );
  });

  it("summarises the first field issue for the save bar", () => {
    const input = {
      enabled: true,
      taxShipping: false,
      defaultTaxClassId: null,
      shippingTaxClassId: null,
      displayLabel: "",
    };

    expect(taxSettingsIssue(input)).toBe("Enter the buyer-facing tax label.");
    expect(taxSettingsIssue({ ...input, displayLabel: "Tax" })).toBe(
      taxSettingsFieldIssues({ ...input, displayLabel: "Tax" })
        .defaultTaxClassId,
    );
  });

  it("starts the draft from the saved settings record", () => {
    const draft = buildTaxSettingsDraft({
      id: "default",
      enabled: true,
      pricesIncludeTax: true,
      taxShipping: false,
      defaultTaxClassId: "class_standard",
      shippingTaxClassId: null,
      displayLabel: "VAT",
      version: 7,
      createdAt: null,
      updatedAt: null,
    });

    expect(draft).toEqual({
      expectedVersion: 7,
      enabled: true,
      pricesIncludeTax: true,
      taxShipping: false,
      defaultTaxClassId: "class_standard",
      shippingTaxClassId: null,
      displayLabel: "VAT",
    });
    expect(taxSettingsFormIsDirty(draft, { ...draft })).toBe(false);
  });

  it("drives the contextual save bar from the draft, not from a per-card button", () => {
    const configuration = taxConfiguration();
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
    const saved = {
      expectedVersion: 4,
      enabled: false,
      pricesIncludeTax: false,
      taxShipping: false,
      defaultTaxClassId: "class_standard",
      shippingTaxClassId: null,
      displayLabel: "Tax",
    };

    expect(taxSettingsSaveBarState(saved, saved, configuration)).toEqual({
      visible: false,
      canSave: true,
      saveDisabled: false,
      disabledReason: null,
    });

    expect(taxSettingsSaveBarState(
      { ...saved, enabled: true },
      saved,
      configuration,
    )).toEqual({
      visible: true,
      canSave: true,
      saveDisabled: false,
      disabledReason: null,
    });

    const invalid = taxSettingsSaveBarState(
      { ...saved, enabled: true, defaultTaxClassId: null },
      saved,
      configuration,
    );
    expect(invalid.visible).toBe(true);
    expect(invalid.saveDisabled).toBe(true);
    expect(invalid.disabledReason).toContain("default tax class");

    const readOnly = taxSettingsSaveBarState(
      { ...saved, displayLabel: "VAT" },
      saved,
      configuration,
      { canManage: false },
    );
    expect(readOnly.visible).toBe(true);
    expect(readOnly.canSave).toBe(false);
    expect(readOnly.disabledReason).toBe(
      "You do not have permission to manage taxes.",
    );
  });
});
