import { describe, expect, it } from "vitest";
import {
  buildAdminNotificationConfig,
  buildCustomerNotificationConfig,
  serializeAdminNotificationConfig,
  serializeCustomerNotificationConfig,
} from "./notification-channel-policy";

describe("notification channel policy", () => {
  it("preserves saved customer intent while a provider is unavailable", () => {
    const config = buildCustomerNotificationConfig({
      order_created: ["email", "sms", "whatsapp"],
      order_confirmed: ["sms"],
    });

    expect(config.order_created).toEqual({ email: true, sms: true, whatsapp: true });
    expect(serializeCustomerNotificationConfig(config).order_confirmed).toEqual(["sms"]);
  });

  it("preserves saved admin push intent while Firebase is unavailable", () => {
    const config = buildAdminNotificationConfig({ order_created: ["push"], order_confirmed: [] });

    expect(config.order_created.push).toBe(true);
    expect(config.order_confirmed.push).toBe(false);
    expect(serializeAdminNotificationConfig(config).order_created).toEqual(["push"]);
  });

  it("serializes channels in a stable order whatever order they were toggled in", () => {
    const config = buildCustomerNotificationConfig({ order_shipped: ["whatsapp", "email"] });
    expect(serializeCustomerNotificationConfig(config).order_shipped).toEqual(["email", "whatsapp"]);
  });
});
