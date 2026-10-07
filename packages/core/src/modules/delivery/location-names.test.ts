import { describe, expect, it } from "vitest";

import {
  normalizeDeliveryLocationName,
  normalizeRequiredDeliveryLocationName,
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
});
