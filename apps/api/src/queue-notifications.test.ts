import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

const mocks = vi.hoisted(() => ({
  sendOrderNotificationEmail: vi.fn(),
  sendOrderNotification: vi.fn(),
  sendStaffOrderEmails: vi.fn(),
  getAdminNotificationChannels: vi.fn(),
}));

vi.mock("@scalius/core/modules/notifications", async (importOriginal) => ({
  ...await importOriginal<typeof import("@scalius/core/modules/notifications")>(),
  sendOrderNotificationEmail: mocks.sendOrderNotificationEmail,
  sendOrderNotification: mocks.sendOrderNotification,
  sendStaffOrderEmails: mocks.sendStaffOrderEmails,
}));

vi.mock("@scalius/core/modules/settings", async (importOriginal) => ({
  ...await importOriginal<typeof import("@scalius/core/modules/settings")>(),
  getAdminNotificationChannels: mocks.getAdminNotificationChannels,
}));

import { recordAndEnqueueOrderNotification } from "@scalius/core/modules/notifications";
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
