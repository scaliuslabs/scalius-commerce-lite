import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHECKOUT_SETTINGS_SECTION,
  normalizeCheckoutSettingsSection,
} from "./checkout-settings-sections";
import {
  DEFAULT_GENERAL_SETTINGS_SECTION,
  normalizeGeneralSettingsSection,
} from "./general-settings-sections";

describe("settings section normalization", () => {
  it("keeps every supported general settings deep link", () => {
    expect(normalizeGeneralSettingsSection("media")).toBe("media");
    expect(normalizeGeneralSettingsSection("notification-channels")).toBe(
      "notification-channels",
    );
  });

  it("fails closed to the general settings default", () => {
    for (const value of [undefined, null, "", "payments", 42]) {
      expect(normalizeGeneralSettingsSection(value)).toBe(
        DEFAULT_GENERAL_SETTINGS_SECTION,
      );
    }
  });

  it("keeps every supported checkout settings deep link", () => {
    expect(normalizeCheckoutSettingsSection("payment")).toBe("payment");
    expect(normalizeCheckoutSettingsSection("customer-requests")).toBe(
      "customer-requests",
    );
  });

  it("fails closed to the checkout settings default", () => {
    for (const value of [undefined, null, "", "tax", false]) {
      expect(normalizeCheckoutSettingsSection(value)).toBe(
        DEFAULT_CHECKOUT_SETTINGS_SECTION,
      );
    }
  });
});
