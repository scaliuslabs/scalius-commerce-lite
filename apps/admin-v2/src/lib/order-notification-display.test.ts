import { describe, expect, it } from "vitest";
import type { OrderNotificationReceiptDto } from "./api-functions/orders";
import {
  buildReceiptDisplayGroups,
  deliveryAttemptLabel,
  describeNotificationIssue,
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
    });
    expect(deliveryAttemptLabel(groups[0]!)).toBe("Stopped after 56 attempts");
    expect(groups[1]).toMatchObject({
      channel: "whatsapp",
      providerStatus: "WhatsApp is enabled, but Meta Cloud API credentials are not ready.",
    });
  });

  it("keeps unknown provider text short enough for the order card", () => {
    expect(describeNotificationIssue("x".repeat(220))).toBe(`${"x".repeat(157)}...`);
  });
});
