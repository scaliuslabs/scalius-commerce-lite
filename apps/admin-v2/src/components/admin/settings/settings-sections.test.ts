import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHECKOUT_SETTINGS_SECTION,
  normalizeCheckoutSettingsSection,
} from "./checkout-settings-sections";
import {
  DEFAULT_GENERAL_SETTINGS_SECTION,
  normalizeGeneralSettingsPanel,
  normalizeGeneralSettingsSection,
} from "./general-settings-sections";
import {
  DEFAULT_NOTIFICATION_SETTINGS_SECTION,
  normalizeNotificationSettingsSection,
} from "./notification-settings-sections";

describe("settings section normalization", () => {
  it("keeps every supported general settings deep link", () => {
    expect(normalizeGeneralSettingsSection("media")).toBe("media");
  });

  it("fails closed to the general settings default", () => {
    for (const value of [
      undefined,
      null,
      "",
      "payments",
      "notification-channels",
      42,
    ]) {
      expect(normalizeGeneralSettingsSection(value)).toBe(
        DEFAULT_GENERAL_SETTINGS_SECTION,
      );
    }
  });

  it("normalizes nested header and footer panels for deep links", () => {
    expect(normalizeGeneralSettingsPanel("header", "navigation")).toBe(
      "navigation",
    );
    expect(normalizeGeneralSettingsPanel("footer", "social")).toBe("social");
    expect(normalizeGeneralSettingsPanel("header", "unknown")).toBe(
      "branding",
    );
    expect(normalizeGeneralSettingsPanel("seo", "navigation")).toBeUndefined();
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

  it("keeps notification policy and push-provider deep links separate", () => {
    expect(normalizeNotificationSettingsSection("rules")).toBe("rules");
    expect(normalizeNotificationSettingsSection("push")).toBe("push");
  });

  it("fails closed to notification delivery rules", () => {
    for (const value of [undefined, null, "", "firebase", false]) {
      expect(normalizeNotificationSettingsSection(value)).toBe(
        DEFAULT_NOTIFICATION_SETTINGS_SECTION,
      );
    }
  });
});
