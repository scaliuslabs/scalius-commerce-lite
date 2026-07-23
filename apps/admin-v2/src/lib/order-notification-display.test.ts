import { describe, expect, it } from "vitest";
import type { OrderNotificationReceiptDto } from "./api-functions/orders";
import {
  buildReceiptDisplayGroups,
  deliveryAttemptLabel,
  describeNotificationIssue,
  outboxAttemptLabel,
  summarizeNotificationDelivery,
} from "./order-notification-display";

function receipt(overrides: Partial<OrderNotificationReceiptDto>): OrderNotificationReceiptDto {
  return {
    id: "receipt_1",
    receiptKey: "outbox_1:push:hash",
    channel: "push",
    provider: "fcm",
    recipientMasked: "token:abc...123",
    status: "accepted",
    providerMessageId: null,
    providerStatus: "accepted",
    attempts: 1,
    nextAttemptAt: null,
    lastAttemptAt: 1_782_156_548,
    lastError: null,
    acceptedAt: 1_782_156_552,
    deliveredAt: null,
    failedAt: null,
    skippedAt: null,
    createdAt: 1_782_156_548,
    updatedAt: 1_782_156_552,
    ...overrides,
  };
}

describe("order notification display", () => {
  it("collapses repeated admin device receipts into one readable row", () => {
    const groups = buildReceiptDisplayGroups(
      Array.from({ length: 10 }, (_, index) =>
        receipt({
          id: `push_${index}`,
          receiptKey: `outbox_1:push:hash_${index}`,
          recipientMasked: `token:${index}...done`,
          acceptedAt: 1_782_156_552 + index,
        }),
      ),
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      channel: "push",
      provider: "fcm",
      status: "accepted",
      count: 10,
      recipientLabel: "10 admin devices",
      totalAttempts: 10,
      maxAttempts: 1,
      latestTimestamp: 1_782_156_561,
    });
    expect(deliveryAttemptLabel(groups[0]!)).toBe("Accepted");
  });

  it("keeps different setup problems separate while translating provider noise", () => {
    const groups = buildReceiptDisplayGroups([
      receipt({
        id: "sms_1",
        channel: "sms",
        provider: "smsnetbd",
        recipientMasked: "***4433",
        status: "skipped",
        providerStatus: "error=405: Authorization required",
        lastError: "error=405: Authorization required",
        attempts: 56,
        acceptedAt: null,
        skippedAt: 1_782_684_758,
      }),
      receipt({
        id: "whatsapp_1",
        channel: "whatsapp",
        provider: "whatsapp",
        recipientMasked: "***4433",
        status: "skipped",
        providerStatus: "missing_whatsapp_credentials",
        lastError: "missing_whatsapp_credentials",
        acceptedAt: null,
        skippedAt: 1_782_438_659,
      }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      channel: "sms",
      providerStatus: "Provider rejected the saved credentials. Save valid credentials or disable this channel.",
      maxAttempts: 56,
      setupIssue: true,
    });
    expect(deliveryAttemptLabel(groups[0]!)).toBe("Paused");
    expect(groups[1]).toMatchObject({
      channel: "whatsapp",
      providerStatus: "WhatsApp is enabled, but Meta Cloud API credentials are not ready.",
    });
  });

  it("collapses repeated provider setup failures into one paused row", () => {
    const groups = buildReceiptDisplayGroups([
      receipt({
        id: "sms_initial_failure",
        receiptKey: "outbox_1:sms:hash_1",
        channel: "sms",
        provider: "smsnetbd",
        recipientMasked: "***4433",
        status: "skipped",
        providerStatus: "error=405: Authorization required",
        lastError: "error=405: Authorization required",
        attempts: 1,
        acceptedAt: null,
        skippedAt: 1_782_684_758,
      }),
      receipt({
        id: "sms_blocked_failure",
        receiptKey: "outbox_1:sms:hash_2",
        channel: "sms",
        provider: "smsnetbd",
        recipientMasked: "***7788",
        status: "skipped",
        providerStatus: "provider_blocked_until_settings_save: error=405: Authorization required",
        lastError: "Provider rejected the API key or token. Save valid credentials or disable this channel.",
        attempts: 1,
        acceptedAt: null,
        skippedAt: 1_782_684_760,
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      channel: "sms",
      provider: "smsnetbd",
      status: "skipped",
      count: 2,
      recipientLabel: "2 recipients",
      providerStatus: "Provider sending is paused after a setup failure. Save corrected provider settings to resume notifications.",
      showLastError: false,
      setupIssue: true,
    });
    expect(deliveryAttemptLabel(groups[0]!)).toBe("Paused");
  });

  it("keeps unknown provider text short enough for the order card", () => {
    expect(describeNotificationIssue("x".repeat(220))).toBe(`${"x".repeat(157)}...`);
  });

  it("does not surface alarming historical parent retry counts as the primary label", () => {
    expect(outboxAttemptLabel({ status: "dead_lettered", attempts: 275 })).toBe("Retry stopped");
    expect(outboxAttemptLabel({ status: "sent", attempts: 275 })).toBeNull();
    expect(outboxAttemptLabel({ status: "failed", attempts: 8 })).toBe("Needs attention");
    expect(outboxAttemptLabel({ status: "failed", attempts: 2 })).toBe("2 attempts");
  });

  it("reports the recorded delivery outcome instead of the parent queue state", () => {
    expect(summarizeNotificationDelivery({
      status: "sent",
      receipts: [receipt({ channel: "email", status: "skipped", acceptedAt: null })],
    })).toEqual({ status: "skipped", label: "Not sent" });

    expect(summarizeNotificationDelivery({
      status: "sent",
      receipts: [
        receipt({ id: "push", status: "accepted" }),
        receipt({ id: "email", channel: "email", status: "skipped", acceptedAt: null }),
      ],
    })).toEqual({ status: "partial", label: "Partially sent" });

    expect(summarizeNotificationDelivery({
      status: "sent",
      receipts: [receipt({ status: "accepted" })],
    })).toEqual({ status: "accepted", label: "Sent" });
  });

  it("does not label capped transient failures as paused provider setup", () => {
    const [group] = buildReceiptDisplayGroups([
      receipt({
        id: "sms_timeout",
        channel: "sms",
        provider: "smsnetbd",
        status: "skipped",
        providerStatus: "delivery_attempt_limit_reached",
        lastError: "delivery_attempt_limit_reached: temporary gateway timeout",
        attempts: 8,
        acceptedAt: null,
        skippedAt: 1_782_684_758,
      }),
    ]);

    expect(group).toMatchObject({
      setupIssue: false,
      providerStatus: "Delivery stopped after repeated provider failures. Check credentials and settings before sending more notifications.",
    });
    expect(deliveryAttemptLabel(group!)).toBe("Stopped after 8 attempts");
  });

  it("translates status-only provider setup failures into merchant actions", () => {
    expect(describeNotificationIssue("Failed to send email: Resend API error: 401")).toBe(
      "Provider rejected the saved credentials. Save valid credentials or disable this channel.",
    );
    expect(describeNotificationIssue("HTTP 400")).toBe(
      "Provider rejected the notification setup. Check credentials, template, sender, and channel settings.",
    );
    expect(describeNotificationIssue("HTTP 403")).toBe(
      "Provider rejected the saved credentials. Save valid credentials or disable this channel.",
    );
    expect(describeNotificationIssue("Failed to get access token: invalid_grant service account disabled")).toBe(
      "Firebase credentials are not usable. Save a valid service account or disable admin push notifications.",
    );
    expect(describeNotificationIssue("delivery_attempt_limit_reached: temporary gateway timeout")).toBe(
      "Delivery stopped after repeated provider failures. Check credentials and settings before sending more notifications.",
    );
    expect(describeNotificationIssue("provider_blocked_until_settings_save: error=405: Authorization required")).toBe(
      "Provider sending is paused after a setup failure. Save corrected provider settings to resume notifications.",
    );
  });
});
