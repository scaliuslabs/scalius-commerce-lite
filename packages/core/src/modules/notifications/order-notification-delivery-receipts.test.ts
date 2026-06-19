import { describe, expect, it } from "vitest";
import {
  createOrderNotificationDeliveryTarget,
  createProviderClientReference,
} from "./order-notification-delivery-receipts";

describe("order notification delivery receipts", () => {
  it("builds deterministic receipt keys without storing raw recipients in the key", async () => {
    const input = {
      outboxId: "outbox_1",
      orderId: "order_1",
      notificationType: "order_created" as const,
      channel: "email" as const,
      provider: "email",
      recipient: "Buyer@Example.com",
    };

    const first = await createOrderNotificationDeliveryTarget(input);
    const second = await createOrderNotificationDeliveryTarget({
      ...input,
      recipient: "buyer@example.com",
    });

    expect(first.receiptKey).toBe(second.receiptKey);
    expect(first.receiptKey).toContain("outbox_1:email:");
    expect(first.receiptKey).not.toContain("Buyer");
    expect(first.recipientMasked).toBe("B***@Example.com");
  });

  it("compresses receipt keys into provider client references", async () => {
    const target = await createOrderNotificationDeliveryTarget({
      outboxId: "outbox_sms_1",
      orderId: "order_1",
      notificationType: "order_refunded",
      channel: "sms",
      provider: "gennet",
      recipient: "+8801700000000",
    });

    const reference = createProviderClientReference(target);

    expect(reference).toHaveLength(20);
    expect(reference).toMatch(/^[a-zA-Z0-9]+$/);
  });
});
