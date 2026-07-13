import { describe, expect, it } from "vitest";

import type { TaxConfigurationPayload } from "@/lib/api-functions/taxes";
import { getTaxReadiness } from "./tax-readiness";

function configuration(
  overrides: Partial<TaxConfigurationPayload> = {},
): TaxConfigurationPayload {
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

describe("tax workspace readiness", () => {
  it("keeps disabled zero-tax behavior truthful and directs a zero-rate store to Rates", () => {
    const readiness = getTaxReadiness(configuration());

    expect(readiness.state).toBe("off");
    expect(readiness.description).toContain("records zero tax");
    expect(readiness.nextTab).toBe("rates");
    expect(readiness.nextAction).toBe("Add an active rate");
  });

  it("prioritizes a missing default class before rates", () => {
    const config = configuration();
    config.settings.defaultTaxClassId = null;

    expect(getTaxReadiness(config)).toMatchObject({
      state: "off",
      nextTab: "policy",
      nextAction: "Choose default class",
    });
  });

  it("recognizes exempt defaults and a complete enabled setup", () => {
    const exempt = configuration();
    exempt.classes[0]!.isExempt = true;
    exempt.settings.enabled = true;
    expect(getTaxReadiness(exempt).state).toBe("ready");

    const configured = configuration({
      rates: [{
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
      }],
    });
    configured.settings.enabled = true;
    expect(getTaxReadiness(configured)).toMatchObject({
      state: "ready",
      nextTab: "preview",
      nextAction: "Test calculation",
    });
  });

  it("keeps a separately taxed shipping class in the readiness sequence", () => {
    const config = configuration({
      classes: [
        ...configuration().classes,
        {
          ...configuration().classes[0]!,
          id: "class_shipping",
          name: "Shipping",
        },
      ],
      rates: [{
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
      }],
    });
    config.settings.enabled = true;
    config.settings.taxShipping = true;
    config.settings.shippingTaxClassId = "class_shipping";

    expect(getTaxReadiness(config)).toMatchObject({
      state: "attention",
      nextTab: "rates",
      nextAction: "Add a shipping rate",
    });
    expect(getTaxReadiness(config).steps).toContainEqual(expect.objectContaining({
      id: "shipping-rates",
      ready: false,
    }));
  });
});
