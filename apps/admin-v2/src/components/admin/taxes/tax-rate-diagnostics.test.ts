import { describe, expect, it } from "vitest";

import type {
  TaxConfigurationPayload,
  TaxJurisdictionType,
  TaxRateRecord,
} from "@/lib/api-functions/taxes";
import { getTaxRateDiagnostics, getTaxRateDraftOverlap } from "./tax-rate-diagnostics";

function rate(
  id: string,
  jurisdictionType: TaxJurisdictionType,
  jurisdictionId: string | null,
  overrides: Partial<TaxRateRecord> = {},
): TaxRateRecord {
  return {
    id,
    taxClassId: "class_standard",
    name: id,
    rateBps: 1_500,
    jurisdictionType,
    jurisdictionId,
    jurisdictionLabel: jurisdictionId,
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

function configuration(rates: TaxRateRecord[]): TaxConfigurationPayload {
  return {
    settings: {
      id: "default",
      enabled: true,
      pricesIncludeTax: false,
      taxShipping: true,
      defaultTaxClassId: "class_standard",
      shippingTaxClassId: null,
      displayLabel: "Tax",
      version: 1,
      createdAt: null,
      updatedAt: null,
    },
    classes: [
      {
        id: "class_standard",
        name: "Standard",
        description: null,
        isExempt: false,
        version: 1,
        createdAt: null,
        updatedAt: null,
        deletedAt: null,
      },
      {
        id: "class_exempt",
        name: "Exempt",
        description: null,
        isExempt: true,
        version: 1,
        createdAt: null,
        updatedAt: null,
        deletedAt: null,
      },
    ],
    rates,
    jurisdictions: [
      { id: "city_dhaka", name: "Dhaka", type: "city", parentId: null },
      { id: "zone_banani", name: "Banani", type: "zone", parentId: "city_dhaka" },
      { id: "zone_mirpur", name: "Mirpur", type: "zone", parentId: "city_dhaka" },
      { id: "area_11", name: "Road 11", type: "area", parentId: "zone_banani" },
    ],
  };
}

describe("tax rate diagnostics", () => {
  it("separates all-destination, scoped-only, empty, and exempt coverage", () => {
    const all = getTaxRateDiagnostics(configuration([rate("all", "all", null)]));
    expect(all.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({
        classId: "class_standard",
        state: "all",
        roles: ["default products", "shipping"],
        needsBroadRate: false,
      }),
      expect.objectContaining({ classId: "class_exempt", state: "exempt" }),
    ]));

    const scoped = getTaxRateDiagnostics(configuration([rate("city", "city", "city_dhaka")]));
    expect(scoped.coverage[0]).toMatchObject({
      state: "scoped",
      scopedDestinationCount: 1,
      needsBroadRate: true,
      detail: expect.stringContaining("every other destination receives zero tax"),
    });

    const empty = getTaxRateDiagnostics(configuration([]));
    expect(empty.coverage[0]).toMatchObject({ state: "none", needsBroadRate: true });
  });

  it("diagnoses exact duplicate scopes and explains equal-priority layering", () => {
    const diagnostics = getTaxRateDiagnostics(configuration([
      rate("first", "zone", "zone_banani", { priority: 10 }),
      rate("second", "zone", "zone_banani", { priority: 10 }),
    ]));

    expect(diagnostics.overlaps).toContainEqual(expect.objectContaining({
      kind: "same-scope",
      title: "2 active rates share Banani",
      detail: expect.stringContaining("priority 10"),
      rateIds: ["first", "second"],
    }));
  });

  it("diagnoses broad-plus-local and proven ancestor overlaps", () => {
    const diagnostics = getTaxRateDiagnostics(configuration([
      rate("all", "all", null),
      rate("city", "city", "city_dhaka", { priority: 5 }),
      rate("zone", "zone", "zone_banani", { priority: 10, isCompound: true }),
      rate("area", "area", "area_11", { priority: 20 }),
    ]));

    expect(diagnostics.overlaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "all-with-scoped" }),
      expect.objectContaining({
        kind: "nested-scope",
        title: "Dhaka and Banani rates stack",
      }),
      expect.objectContaining({
        kind: "nested-scope",
        title: "Banani and Road 11 rates stack",
      }),
      expect.objectContaining({
        kind: "nested-scope",
        title: "Dhaka and Road 11 rates stack",
      }),
    ]));
    expect(diagnostics.coverage[0]).toMatchObject({ hasStacking: true });
  });

  it("does not infer overlap across unrelated locations, inactive rates, or classes", () => {
    const diagnostics = getTaxRateDiagnostics(configuration([
      rate("banani", "zone", "zone_banani"),
      rate("mirpur", "zone", "zone_mirpur"),
      rate("inactive", "all", null, { isActive: false }),
      rate("other-class", "zone", "zone_banani", { taxClassId: "class_exempt" }),
    ]));

    expect(diagnostics.overlapCount).toBe(0);
  });

  it("keeps rendered overlap details bounded while preserving the total", () => {
    const rates = Array.from({ length: 9 }, (_, index) => [
      rate(`first_${index}`, "zone", `zone_${index}`),
      rate(`second_${index}`, "zone", `zone_${index}`),
    ]).flat();

    const diagnostics = getTaxRateDiagnostics(configuration(rates));
    expect(diagnostics.overlapCount).toBe(9);
    expect(diagnostics.overlaps).toHaveLength(8);
    expect(diagnostics.hiddenOverlapCount).toBe(1);
    expect(diagnostics.overlaps.every((item) => item.rateIds.length <= 3)).toBe(true);
  });

  it("previews draft stacking without counting the edited rate itself", () => {
    const config = configuration([
      rate("broad", "all", null, { name: "Store rate", priority: 0 }),
      rate("editing", "zone", "zone_banani", { name: "Saved Banani", priority: 10 }),
    ]);
    const draft = getTaxRateDraftOverlap(config, {
      taxClassId: "class_standard",
      jurisdictionType: "zone",
      jurisdictionId: "zone_banani",
      priority: 0,
      isActive: true,
    }, "editing");

    expect(draft).toMatchObject({
      count: 1,
      rateNames: ["Store rate"],
      detail: expect.stringContaining("shares priority 0"),
    });
    expect(getTaxRateDraftOverlap(config, {
      taxClassId: "class_exempt",
      jurisdictionType: "all",
      jurisdictionId: null,
      priority: 0,
      isActive: true,
    }, null)).toBeNull();
    expect(getTaxRateDraftOverlap(config, {
      taxClassId: "class_standard",
      jurisdictionType: "zone",
      jurisdictionId: "zone_mirpur",
      priority: 0,
      isActive: false,
    }, null)).toBeNull();
  });
});
