import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

const mocks = vi.hoisted(() => ({
  sendOrderNotificationEmail: vi.fn(),
  sendOrderNotification: vi.fn(),
  sendStaffOrderEmails: vi.fn(),
  getAdminNotificationChannels: vi.fn(),
  sendResolvedNotification: vi.fn(),
  sendStaffAlertNotification: vi.fn(),
  resolveDigitalDeliveryContent: vi.fn(),
  resolveReviewRequestContent: vi.fn(),
  resolveGiftCardIssuedContent: vi.fn(),
}));

vi.mock("@scalius/core/modules/notifications", async (importOriginal) => ({
  ...await importOriginal<typeof import("@scalius/core/modules/notifications")>(),
  sendOrderNotificationEmail: mocks.sendOrderNotificationEmail,
  sendOrderNotification: mocks.sendOrderNotification,
  sendStaffOrderEmails: mocks.sendStaffOrderEmails,
  sendResolvedNotification: mocks.sendResolvedNotification,
  sendStaffAlertNotification: mocks.sendStaffAlertNotification,
}));

vi.mock("./notification-content/digital", () => ({ resolveDigitalDeliveryContent: mocks.resolveDigitalDeliveryContent }));
vi.mock("./notification-content/review-request", () => ({ resolveReviewRequestContent: mocks.resolveReviewRequestContent }));
vi.mock("./notification-content/gift-card", () => ({ resolveGiftCardIssuedContent: mocks.resolveGiftCardIssuedContent }));

vi.mock("@scalius/core/modules/settings", async (importOriginal) => ({
  ...await importOriginal<typeof import("@scalius/core/modules/settings")>(),
  getAdminNotificationChannels: mocks.getAdminNotificationChannels,
}));

import {
  recordAndEnqueueNotification,
  recordAndEnqueueOrderNotification,
} from "@scalius/core/modules/notifications";
import type { NotificationType } from "@scalius/core/modules/notifications/browser";
import {
  archiveNotificationDlqMessage,
  processNotificationMessage,
} from "./queue-notifications";

const ORDER_ID = "ORDER_QUEUE_0001";

describe("notification queue messages (outbox id only)", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  const env = { PUBLIC_API_BASE_URL: "https://api.shop.test" } as unknown as Env;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.exec(`INSERT INTO orders (id, customer_name, customer_phone, customer_email, shipping_address, city, zone,
        city_name, zone_name, total_amount_minor, subtotal_amount_minor, status)
      VALUES ('${ORDER_ID}', 'Saved Name', '+8801711111111', 'saved@example.test', 'House 1', 'city_1', 'zone_1',
        'Dhaka', 'Mirpur', 50000, 50000, 'confirmed')`);
    mocks.sendOrderNotificationEmail.mockReset().mockResolvedValue({ outcomes: [], hasRetryableFailure: false });
    mocks.sendOrderNotification.mockReset().mockResolvedValue({ outcomes: [], hasRetryableFailure: false });
    mocks.sendStaffOrderEmails.mockReset().mockResolvedValue({ outcomes: [], hasRetryableFailure: false });
    mocks.getAdminNotificationChannels.mockReset().mockResolvedValue({ order_shipped: ["push"] });
    mocks.sendResolvedNotification.mockReset().mockResolvedValue({ outcomes: [], hasRetryableFailure: false });
    mocks.sendStaffAlertNotification.mockReset().mockResolvedValue({ outcomes: [], hasRetryableFailure: false });
    // The B0 stubs: nothing to send.
    mocks.resolveDigitalDeliveryContent.mockReset().mockResolvedValue(null);
    mocks.resolveReviewRequestContent.mockReset().mockResolvedValue(null);
    mocks.resolveGiftCardIssuedContent.mockReset().mockResolvedValue(null);
  });

  afterEach(() => sqlite.close());

  async function recordOrderRow(data?: Record<string, unknown>) {
    const result = await recordAndEnqueueOrderNotification({
      db,
      queue: { send: vi.fn() },
      notification: {
        dedupeKey: `order_status:${ORDER_ID}:shipped`,
        orderId: ORDER_ID,
        customerEmail: "stale@example.test",
        customerName: "Stale Name",
        notificationType: "order_shipped",
        source: "test",
        data,
      },
    });
    return result.outboxId;
  }

  const status = () => (sqlite.prepare("SELECT status FROM notification_outbox").get() as { status: string }).status;

  it("resolves the order contact at send time, dispatches like order.notification, and marks the row sent", async () => {
    const outboxId = await recordOrderRow({ trackingId: "PX-1" });
    await processNotificationMessage({ type: "notification", outboxId }, db, env);

    expect(mocks.sendOrderNotificationEmail).toHaveBeenCalledWith(
      "saved@example.test",
      "Saved Name",
      ORDER_ID,
      "order_shipped",
      { trackingId: "PX-1" },
      db,
      expect.objectContaining({ outboxId }),
    );
    expect(mocks.sendOrderNotification).toHaveBeenCalledWith(
      db,
      { id: ORDER_ID, customerName: "Saved Name", notificationType: "order_shipped" },
      env,
      "https://api.shop.test",
      { outboxId },
    );
    expect(mocks.sendStaffOrderEmails).toHaveBeenCalledTimes(1);
    expect(status()).toBe("sent");

    // A replay of the same message is a no-op.
    await processNotificationMessage({ type: "notification", outboxId }, db, env);
    expect(mocks.sendOrderNotificationEmail).toHaveBeenCalledTimes(1);
  });

  it("marks the row failed (not thrown) when a channel needs a retry", async () => {
    mocks.sendOrderNotificationEmail.mockResolvedValue({
      outcomes: [{ channel: "email", provider: "resend", retryable: true, error: "503" }],
      hasRetryableFailure: true,
    });
    const outboxId = await recordOrderRow();
    await expect(processNotificationMessage({ type: "notification", outboxId }, db, env)).resolves.toBeUndefined();
    expect(status()).toBe("failed");
  });

  it("dead-letters rows whose subject has no sender", async () => {
    const outboxId = await recordOrderRow();
    sqlite.exec("UPDATE notification_outbox SET notification_type = 'digital_delivered'");
    await processNotificationMessage({ type: "notification", outboxId }, db, env);
    expect(status()).toBe("dead_lettered");
    expect(mocks.sendOrderNotificationEmail).not.toHaveBeenCalled();
  });

  async function recordRow(input: {
    subjectType: "order" | "gift_card";
    subjectId: string;
    audience?: "customer" | "staff";
    notificationType: NotificationType;
    data?: Record<string, unknown>;
  }) {
    const result = await recordAndEnqueueNotification({
      db,
      queue: undefined,
      notification: { audience: "customer", ...input, dedupeKey: crypto.randomUUID(), source: "test" },
    });
    return result.outboxId;
  }

  const receipts = () => sqlite.prepare("SELECT subject_type, subject_id, order_id, status, last_error FROM notification_delivery_receipts").all();

  it.each([
    ["order", ORDER_ID, "order_digital_delivered", ORDER_ID],
    ["order", ORDER_ID, "review_request", ORDER_ID],
    ["gift_card", "gc_0001", "gift_card_issued", null],
  ] as const)("ends a %s %s row whose resolver has nothing to send: sent, one skipped receipt, no retry", async (subjectType, subjectId, notificationType, orderId) => {
    const outboxId = await recordRow({ subjectType, subjectId, notificationType, data: { fulfillmentId: "ful_1" } });
    await processNotificationMessage({ type: "notification", outboxId }, db, env);

    expect(status()).toBe("sent");
    expect(receipts()).toEqual([{ subject_type: subjectType, subject_id: subjectId, order_id: orderId, status: "skipped", last_error: "nothing_to_send" }]);
    expect(mocks.sendResolvedNotification).not.toHaveBeenCalled();
    expect(mocks.sendOrderNotificationEmail).not.toHaveBeenCalled();
    expect(mocks.sendOrderNotification).not.toHaveBeenCalled();
  });

  it("hands resolved variables to the dispatcher with the order's own contact, never persisting them", async () => {
    mocks.resolveReviewRequestContent.mockResolvedValue({ review_products: "Cotton panjabi", review_link: "https://shop.test/account/orders/x#reviews" });
    sqlite.exec(`UPDATE orders SET order_number = 1057 WHERE id = '${ORDER_ID}'`);
    const outboxId = await recordRow({ subjectType: "order", subjectId: ORDER_ID, notificationType: "review_request" });
    await processNotificationMessage({ type: "notification", outboxId }, db, env);

    expect(mocks.resolveReviewRequestContent).toHaveBeenCalledWith(db, env, { orderId: ORDER_ID, data: {} });
    expect(mocks.sendResolvedNotification).toHaveBeenCalledWith(db, {
      outboxId,
      notificationType: "review_request",
      subjectType: "order",
      subjectId: ORDER_ID,
      orderId: ORDER_ID,
      orderNumber: "#1057",
      recipient: { name: "Saved Name", email: "saved@example.test", phone: "+8801711111111" },
      extraTemplateData: { review_products: "Cotton panjabi", review_link: "https://shop.test/account/orders/x#reviews" },
    }, expect.objectContaining({ env }));
    expect(status()).toBe("sent");
    const row = sqlite.prepare("SELECT payload, last_error FROM notification_outbox").get() as { payload: string; last_error: string | null };
    expect(row.payload).not.toContain("panjabi");
    // The order status path never runs for it.
    expect(mocks.sendOrderNotificationEmail).not.toHaveBeenCalled();
  });

  it("sends an issued gift card to the resolver's recipient and retries a retryable failure", async () => {
    mocks.resolveGiftCardIssuedContent.mockResolvedValue({
      recipient: { name: "Nadia", email: "nadia@example.test", phone: null },
      orderId: ORDER_ID,
      orderNumber: "#1057",
      extraTemplateData: { gift_card_code: "GC7K2M9QX4RT8WPZ" },
    });
    mocks.sendResolvedNotification.mockResolvedValue({
      outcomes: [{ channel: "email", provider: "resend", retryable: true, error: "503 [redacted]" }],
      hasRetryableFailure: true,
    });
    const outboxId = await recordRow({ subjectType: "gift_card", subjectId: "gc_0001", notificationType: "gift_card_issued" });
    await processNotificationMessage({ type: "notification", outboxId }, db, env);

    expect(mocks.sendResolvedNotification).toHaveBeenCalledWith(db, expect.objectContaining({
      subjectType: "gift_card",
      subjectId: "gc_0001",
      orderId: ORDER_ID,
      recipient: { name: "Nadia", email: "nadia@example.test", phone: null },
    }), expect.anything());
    expect(status()).toBe("failed");
    const row = sqlite.prepare("SELECT last_error FROM notification_outbox").get() as { last_error: string };
    expect(row.last_error).not.toContain("GC7K2M9QX4RT8WPZ");
  });

  it("routes staff alerts to the staff dispatcher and dead-letters an unknown gift-card type", async () => {
    const alert = await recordRow({ subjectType: "order", subjectId: ORDER_ID, audience: "staff", notificationType: "digital_keys_exhausted" });
    await processNotificationMessage({ type: "notification", outboxId: alert }, db, env);
    expect(mocks.sendStaffAlertNotification).toHaveBeenCalledWith(
      db,
      { outboxId: alert, orderId: ORDER_ID, notificationType: "digital_keys_exhausted" },
      expect.objectContaining({ env }),
    );
    expect(status()).toBe("sent");

    sqlite.exec("DELETE FROM notification_outbox");
    const wrong = await recordRow({ subjectType: "gift_card", subjectId: "gc_0001", notificationType: "review_request" });
    await processNotificationMessage({ type: "notification", outboxId: wrong }, db, env);
    expect(status()).toBe("dead_lettered");
    expect(mocks.resolveGiftCardIssuedContent).not.toHaveBeenCalled();
  });

  it("archives an exhausted notification message into its outbox row without sending", async () => {
    const outboxId = await recordOrderRow();
    const msg = { id: "m1", attempts: 6, body: { type: "notification", outboxId } } as unknown as Message<{ type: "notification"; outboxId: string }>;
    expect(await archiveNotificationDlqMessage(msg, db)).toEqual({ status: "outbox_failed", outboxId });
    const row = sqlite.prepare("SELECT status, last_error FROM notification_outbox").get() as Record<string, string>;
    expect(row.status).toBe("dead_lettered");
    expect(row.last_error).toMatch(/^notification_dlq_terminal/);
    expect(mocks.sendOrderNotificationEmail).not.toHaveBeenCalled();
  });
});
