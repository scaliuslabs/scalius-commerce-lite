import { describe, expect, it } from "vitest";
import { CUSTOMER_NOTIFICATION_TYPES, STAFF_NOTIFICATION_TYPES } from "./notification-event-types";
import {
  CUSTOMER_EVENT_GROUPS,
  STAFF_EVENT_GROUPS,
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

  it("defaults every customer event to email, including the support request acknowledgement", () => {
    const config = buildCustomerNotificationConfig(undefined);

    expect(config.support_request_submitted).toEqual({ email: true, sms: false, whatsapp: false });
    expect(Object.values(config).every((channels) => channels.email)).toBe(true);
    expect(serializeCustomerNotificationConfig(config).support_request_submitted).toEqual(["email"]);
  });

  it("lists every customer and staff event exactly once in the grouped tables", () => {
    const customer = CUSTOMER_EVENT_GROUPS.flatMap((group) => group.events);
    const staff = STAFF_EVENT_GROUPS.flatMap((group) => group.events);
    expect([...customer].sort()).toEqual([...CUSTOMER_NOTIFICATION_TYPES].sort());
    expect([...staff].sort()).toEqual([...STAFF_NOTIFICATION_TYPES].sort());
    expect(CUSTOMER_EVENT_GROUPS.find((group) => group.key === "groupReviews")?.events).toEqual(["review_request"]);
    expect(CUSTOMER_EVENT_GROUPS.find((group) => group.key === "groupDigitalGiftCards")?.events)
      .toEqual(["order_digital_delivered", "gift_card_issued"]);
    expect(STAFF_EVENT_GROUPS.find((group) => group.key === "groupReviews")?.events).toEqual(["review_pending"]);
    expect(STAFF_EVENT_GROUPS.find((group) => group.key === "groupDigital")?.events).toEqual(["digital_keys_exhausted"]);
  });

  it("defaults the Wave B events like the server: email and SMS for codes and keys, email for review requests", () => {
    const customer = serializeCustomerNotificationConfig(buildCustomerNotificationConfig(undefined));
    expect(customer.order_digital_delivered).toEqual(["email", "sms"]);
    expect(customer.gift_card_issued).toEqual(["email", "sms"]);
    expect(customer.review_request).toEqual(["email"]);

    const staff = serializeAdminNotificationConfig(buildAdminNotificationConfig(undefined));
    expect(staff.review_pending).toEqual(["push"]);
    expect(staff.digital_keys_exhausted).toEqual(["push", "email"]);
  });

  it("never offers WhatsApp for codes, keys or review links, and keeps staff email to the alerts that allow it", () => {
    const customer = buildCustomerNotificationConfig({ gift_card_issued: ["email", "whatsapp"], review_request: ["whatsapp"] });
    expect(customer.gift_card_issued).toEqual({ email: true, sms: false, whatsapp: false });
    expect(serializeCustomerNotificationConfig(customer).review_request).toEqual([]);

    const staff = buildAdminNotificationConfig({ review_pending: ["push", "email"], order_created: ["push", "email"] });
    expect(staff.review_pending).toEqual({ push: true, email: true });
    expect(staff.order_created).toEqual({ push: true, email: false });
  });

  it("serializes channels in a stable order whatever order they were toggled in", () => {
    const config = buildCustomerNotificationConfig({ order_shipped: ["whatsapp", "email"] });
    expect(serializeCustomerNotificationConfig(config).order_shipped).toEqual(["email", "whatsapp"]);
  });
});
