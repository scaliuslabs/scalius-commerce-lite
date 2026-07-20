import { describe, expect, it } from "vitest";

import {
  normalizeDeliveryLocationName,
  normalizeRequiredDeliveryLocationName,
  shouldSuppressPathaoLocationName,
} from "./location-names";

describe("delivery location names", () => {
  it("normalizes boundary and repeated whitespace without changing merchant spelling", () => {
    expect(normalizeDeliveryLocationName("  Cox's   Bazar\nSadar  ")).toBe(
      "Cox's Bazar Sadar",
    );
    expect(normalizeDeliveryLocationName("BUET")).toBe("BUET");
  });

  it("rejects empty and excessively long required names", () => {
    expect(() => normalizeRequiredDeliveryLocationName(" \n ")).toThrow(
      "Location name is required",
    );
    expect(() => normalizeRequiredDeliveryLocationName("x".repeat(121))).toThrow(
      "120 characters or fewer",
    );
  });

  it("suppresses provider placeholders and Pathao routing buckets", () => {
    for (const name of [
      "lost",
      " Unknown ",
      "Bulk Merchant",
      "Central Fulfillment",
      "Document-Central",
      "On-Demand-Chattogram",
      "On-demand  transfer",
      "Pathao Central Inbound",
      "banani hq",
    ]) {
      expect(shouldSuppressPathaoLocationName(name, "zone"), name).toBe(true);
    }
  });

  it("keeps legitimate locations that share ordinary words with routing buckets", () => {
    for (const name of [
      "Central Road",
      "Central Girls School",
      "Waste Transfer Point Mirpur 10",
      "Pathao Office Ashuganj",
      "On Demand Road",
    ]) {
      expect(shouldSuppressPathaoLocationName(name, "area"), name).toBe(false);
    }
    expect(shouldSuppressPathaoLocationName("Central Road", "zone")).toBe(false);
  });
});
