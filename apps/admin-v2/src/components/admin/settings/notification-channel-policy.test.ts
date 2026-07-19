import { describe, expect, it } from "vitest";
import {
  adminNotificationConfigsEqual,
  buildAdminNotificationConfig,
  buildCustomerNotificationConfig,
  customerNotificationConfigsEqual,
  getAdminPushSelection,
  getCustomerChannelSelection,
  serializeAdminNotificationConfig,
  serializeCustomerNotificationConfig,
  setAdminPushForEveryEvent,
  setCustomerChannelForEveryEvent,
} from "./notification-channel-policy";

describe("notification channel policy", () => {
  it("preserves saved customer intent while a provider is unavailable", () => {
    const config = buildCustomerNotificationConfig({
      order_created: ["email", "sms", "whatsapp"],
      order_confirmed: ["sms"],
    });

    expect(config.order_created).toEqual({
      email: true,
      sms: true,
      whatsapp: true,
    });
    expect(serializeCustomerNotificationConfig(config).order_confirmed).toEqual([
      "sms",
    ]);
  });

  it("preserves saved admin push intent while Firebase is unavailable", () => {
    const config = buildAdminNotificationConfig({
      order_created: ["push"],
      order_confirmed: [],
    });

    expect(config.order_created.push).toBe(true);
    expect(serializeAdminNotificationConfig(config).order_created).toEqual([
      "push",
    ]);
  });

  it("supports explicit whole-column changes without mutating the input", () => {
    const customer = buildCustomerNotificationConfig({});
    const allSms = setCustomerChannelForEveryEvent(customer, "sms", true);
    expect(getCustomerChannelSelection(customer, "sms")).toBe(false);
    expect(getCustomerChannelSelection(allSms, "sms")).toBe(true);
    expect(customerNotificationConfigsEqual(customer, allSms)).toBe(false);

    const admin = buildAdminNotificationConfig({});
    const allPush = setAdminPushForEveryEvent(admin, true);
    expect(getAdminPushSelection(allPush)).toBe(true);
    expect(adminNotificationConfigsEqual(admin, allPush)).toBe(false);
  });

  it("reports mixed columns as indeterminate", () => {
    const customer = buildCustomerNotificationConfig({
      order_created: ["email"],
      order_confirmed: [],
    });
    const admin = buildAdminNotificationConfig({
      order_created: ["push"],
      order_confirmed: [],
    });

    expect(getCustomerChannelSelection(customer, "email")).toBe(
      "indeterminate",
    );
    expect(getAdminPushSelection(admin)).toBe("indeterminate");
  });
});
