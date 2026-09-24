import { describe, expect, it } from "vitest";
import type { OrderNotificationReceiptDto } from "./api-query-options/orders";
import {
  canSendNotificationAgain,
  notificationChannelLines,
  notificationIssue,
  notificationOutboxIssue,
  summarizeNotificationDelivery,
} from "./order-notification-display";

function receipt(overrides: Partial<OrderNotificationReceiptDto>): OrderNotificationReceiptDto {
  return {
    id: "rcpt_1", receiptKey: "k", channel: "email", provider: "resend", recipientMasked: "b***@mail.test",
    status: "accepted", providerMessageId: null, providerStatus: null, attempts: 1, nextAttemptAt: null,
    lastAttemptAt: null, lastError: null, acceptedAt: null, deliveredAt: null, failedAt: null, skippedAt: null,
    createdAt: 1, updatedAt: 1,
    ...overrides,
  } as OrderNotificationReceiptDto;
}

describe("order notification display", () => {
  it("names why a message wasn't sent in words a merchant can act on", () => {
    expect(notificationIssue("missing_email_recipient")).toBe("noEmail");
    expect(notificationIssue("missing_sms_recipient")).toBe("noPhone");
    expect(notificationIssue("missing_sms_provider")).toBe("smsNotSetUp");
    expect(notificationIssue("Resend API error 401: unauthorized")).toBe("providerSetup");
    expect(notificationIssue("delivery_attempt_limit_reached")).toBe("stopped");
    expect(notificationIssue("socket hang up")).toBe("other");
    expect(notificationIssue("notification_turned_off")).toBe("turnedOff");
    expect(notificationIssue(null)).toBeNull();
  });

  it("shows each channel with its masked recipient and outcome, leaving staff push and unset channels out", () => {
    const lines = notificationChannelLines([
      receipt({}),
      receipt({ id: "r2", channel: "sms", recipientMasked: "017••••5601", status: "skipped", lastError: "missing_sms_provider" }),
      receipt({ id: "r3", channel: "push", recipientMasked: null }),
      receipt({ id: "r4", channel: "whatsapp", recipientMasked: "017••••5601", status: "failed", lastError: "invalid token" }),
    ]);
    expect(lines).toEqual([
      expect.objectContaining({ channel: "email", recipient: "b***@mail.test", status: "accepted", issue: null }),
      expect.objectContaining({ channel: "whatsapp", status: "failed", issue: "providerSetup" }),
    ]);
  });

  it("reads one outcome for the message from its channels", () => {
    expect(summarizeNotificationDelivery({ status: "sent", receipts: [receipt({})] })).toBe("accepted");
    expect(summarizeNotificationDelivery({
      status: "sent",
      receipts: [receipt({}), receipt({ id: "r2", channel: "sms", status: "skipped" })],
    })).toBe("partial");
    expect(summarizeNotificationDelivery({ status: "failed", receipts: [] })).toBe("failed");
  });

  it("calls a message sent when every channel it was sent on succeeded", () => {
    // Email is the only channel set up; SMS and WhatsApp were never tried, and a staff device failing is not the customer.
    const receipts = [
      receipt({}),
      receipt({ id: "r2", channel: "sms", status: "skipped", lastError: "missing_sms_provider" }),
      receipt({ id: "r3", channel: "whatsapp", status: "skipped", lastError: "missing_whatsapp_credentials" }),
      receipt({ id: "r4", channel: "push", recipientMasked: null, status: "failed", lastError: "unregistered" }),
    ];
    expect(summarizeNotificationDelivery({ status: "sent", receipts })).toBe("accepted");
    // No email address for this customer, SMS went out.
    expect(summarizeNotificationDelivery({
      status: "sent",
      receipts: [
        receipt({ status: "skipped", recipientMasked: "missing-email", lastError: "missing_email_recipient" }),
        receipt({ id: "r2", channel: "sms", status: "delivered" }),
      ],
    })).toBe("delivered");
    // A configured channel that failed still makes it partial.
    expect(summarizeNotificationDelivery({
      status: "sent",
      receipts: [receipt({}), receipt({ id: "r2", channel: "sms", status: "failed", lastError: "socket hang up" })],
    })).toBe("partial");
  });

  it("calls a message skipped when no channel could be tried", () => {
    expect(summarizeNotificationDelivery({
      status: "sent",
      receipts: [
        receipt({ status: "skipped", lastError: "missing_email_recipient" }),
        receipt({ id: "r2", channel: "sms", status: "skipped", lastError: "missing_sms_provider" }),
      ],
    })).toBe("skipped");
  });

  it("never calls a message sent when no customer channel has a delivery record", () => {
    const nothing = { status: "sent", lastError: null, receipts: [] };
    expect(summarizeNotificationDelivery(nothing)).toBe("skipped");
    expect(notificationOutboxIssue(nothing)).toBe("noChannel");
    expect(canSendNotificationAgain(nothing)).toBe(false);
    // A staff device isn't the customer.
    const staffOnly = { ...nothing, receipts: [receipt({ channel: "push", recipientMasked: null })] };
    expect(summarizeNotificationDelivery(staffOnly)).toBe("skipped");
    expect(notificationOutboxIssue(staffOnly)).toBe("noChannel");
    // The recorded reason wins over the generic one.
    expect(notificationOutboxIssue({ ...nothing, lastError: "missing_email_recipient" })).toBe("noEmail");
    // Every channel unset: no line explains it, so the message does.
    expect(notificationOutboxIssue({
      ...nothing,
      receipts: [receipt({ channel: "sms", status: "skipped", lastError: "missing_sms_provider" })],
    })).toBe("noChannel");
    expect(notificationOutboxIssue({ ...nothing, receipts: [receipt({})] })).toBeNull();
  });

  it("offers sending again only when some channel can reach the customer", () => {
    const noEmail = receipt({ status: "skipped", recipientMasked: null, lastError: "missing_email_recipient" });
    expect(canSendNotificationAgain({ status: "sent", lastError: null, receipts: [noEmail] })).toBe(false);
    expect(canSendNotificationAgain({ status: "sent", lastError: null, receipts: [noEmail, receipt({ id: "r2", channel: "sms" })] })).toBe(true);
    expect(canSendNotificationAgain({ status: "sent", lastError: "missing_email_recipient", receipts: [] })).toBe(false);
    expect(canSendNotificationAgain({ status: "sent", lastError: "timeout", receipts: [] })).toBe(true);
    const smsNotSetUp = receipt({ id: "r3", channel: "sms", status: "skipped", lastError: "missing_sms_provider" });
    expect(canSendNotificationAgain({ status: "sent", lastError: null, receipts: [noEmail, smsNotSetUp] })).toBe(false);
  });
});
