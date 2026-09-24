import { describe, expect, it } from "vitest";
import type { OrderNotificationReceiptDto } from "./api-query-options/orders";
import {
  canSendNotificationAgain,
  notificationChannelLines,
  notificationIssue,
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
    expect(notificationIssue(null)).toBeNull();
  });

  it("shows each channel with its masked recipient and outcome, leaving staff push out", () => {
    const lines = notificationChannelLines([
      receipt({}),
      receipt({ id: "r2", channel: "sms", recipientMasked: "017••••5601", status: "skipped", lastError: "missing_sms_provider" }),
      receipt({ id: "r3", channel: "push", recipientMasked: null }),
    ]);
    expect(lines).toEqual([
      expect.objectContaining({ channel: "email", recipient: "b***@mail.test", status: "accepted", issue: null }),
      expect.objectContaining({ channel: "sms", recipient: "017••••5601", status: "skipped", issue: "smsNotSetUp" }),
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

  it("offers sending again only when some channel can reach the customer", () => {
    const noEmail = receipt({ status: "skipped", recipientMasked: null, lastError: "missing_email_recipient" });
    expect(canSendNotificationAgain({ lastError: null, receipts: [noEmail] })).toBe(false);
    expect(canSendNotificationAgain({ lastError: null, receipts: [noEmail, receipt({ id: "r2", channel: "sms" })] })).toBe(true);
    expect(canSendNotificationAgain({ lastError: "missing_email_recipient", receipts: [] })).toBe(false);
    expect(canSendNotificationAgain({ lastError: "timeout", receipts: [] })).toBe(true);
  });
});
