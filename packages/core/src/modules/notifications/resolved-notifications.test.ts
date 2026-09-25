// Resolved notifications (Wave B §10) on the real schema: the templates the
// buyer gets, and the redaction that keeps gift-card codes and licence keys
// out of every delivery receipt, outcome and log.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { notificationOutbox } from "@scalius/database/schema";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  sendSms: vi.fn(),
  sendEachForMulticast: vi.fn(),
}));

vi.mock("../../integrations/email", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("../../integrations/sms", () => ({
  getSmsProviderReadiness: vi.fn(async () => ({ status: "ready", activeProvider: "gennet", issues: [] })),
  getActiveSmsProvider: vi.fn(async () => ({ name: "gennet", sendSms: mocks.sendSms })),
}));
vi.mock("../../integrations/firebase/settings", () => ({ readFirebaseServiceAccountJson: vi.fn(async () => "{}") }));
vi.mock("../../integrations/firebase/admin", () => ({
  getFirebaseAdminMessaging: vi.fn(() => ({ sendEachForMulticast: mocks.sendEachForMulticast })),
}));

import { createNotificationOutboxInsertValues, type NotificationInput } from "./notification-outbox";
import {
  NOTHING_TO_SEND,
  recordNothingToSend,
  sendResolvedNotification,
  sendStaffAlertNotification,
} from "./resolved-notifications";

const CODE = "GC7K2M9QX4RT8WPZ";
const KEYS = "KEY-AAAA-1111, KEY-BBBB-2222";

describe("resolved notifications", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  const env = { STOREFRONT_URL: "https://shop.example.test", BETTER_AUTH_URL: "https://admin.shop.test" } as unknown as Env;

  function setDocument(document: string, fields: Record<string, unknown>) {
    sqlite.prepare("INSERT OR IGNORE INTO settings (id, key, value, category, type) VALUES (?, 'document', '{}', ?, 'json')")
      .run(document, document);
    sqlite.prepare("UPDATE settings SET value = json_patch(value, ?) WHERE category = ?").run(JSON.stringify(fields), document);
  }

  async function outbox(input: Omit<NotificationInput, "dedupeKey" | "source">): Promise<string> {
    const values = createNotificationOutboxInsertValues({ ...input, dedupeKey: crypto.randomUUID(), source: "test" });
    await db.insert(notificationOutbox).values(values);
    return String(values.id);
  }

  const receipts = () => sqlite.prepare("SELECT * FROM notification_delivery_receipts ORDER BY channel").all() as Array<Record<string, unknown>>;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.exec(`
      INSERT INTO orders (id, customer_name, customer_phone, customer_email, shipping_address, city, zone, city_name, zone_name,
          total_amount_minor, subtotal_amount_minor, status, order_number)
        VALUES ('order_1', 'Rahim', '+8801711111111', 'rahim@example.test', 'House 1', 'c', 'z', 'Dhaka', 'Mirpur', 1000, 1000, 'delivered', 1057);
    `);
    setDocument("business", { companyName: "River & Loom" });
    mocks.sendEmail.mockReset().mockResolvedValue({ success: true, provider: "mailpit", providerRef: "m1", rawStatus: "captured" });
    mocks.sendSms.mockReset().mockResolvedValue({ success: true, providerRef: "sms1", rawStatus: "accepted" });
    mocks.sendEachForMulticast.mockReset().mockResolvedValue({ responses: [] });
  });

  afterEach(() => sqlite.close());

  it("sends a gift card to its recipient from the default template, and records neither the code nor a raw response", async () => {
    const outboxId = await outbox({ subjectType: "gift_card", subjectId: "gc_1", audience: "customer", notificationType: "gift_card_issued" });
    // Providers that echo the message back in their status.
    mocks.sendEmail.mockResolvedValue({ success: true, provider: "mailpit", providerRef: "m1", rawStatus: `queued: ${CODE}` });
    mocks.sendSms.mockResolvedValue({ success: false, providerRef: null, rawStatus: `rejected text "Code: ${CODE}"`, retryable: true });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await sendResolvedNotification(db, {
      outboxId,
      notificationType: "gift_card_issued",
      subjectType: "gift_card",
      subjectId: "gc_1",
      orderId: null,
      orderNumber: null,
      recipient: { name: "Nadia", email: "nadia@example.test", phone: "+8801722222222" },
      extraTemplateData: { gift_card_code: CODE, gift_card_value: "৳1,000", gift_card_sender: "Rahim" },
    }, { env });

    const email = mocks.sendEmail.mock.calls[0]![0] as { to: string; subject: string; text: string; html: string };
    expect(email.to).toBe("nadia@example.test");
    expect(email.subject).toBe("Your River & Loom gift card");
    expect(email.text).toContain(`Gift card code: ${CODE}`);
    expect(email.text).toContain("Hi Nadia,");
    expect(email.text).not.toContain("Expires:");
    const sms = mocks.sendSms.mock.calls[0]![0] as { to: string; message: string };
    expect(sms.to).toBe("+8801722222222");
    expect(sms.message).toContain(`Code: ${CODE}`);

    expect(result.hasRetryableFailure).toBe(true);
    const rows = receipts();
    expect(rows.map((row) => [row.channel, row.status, row.subject_type, row.subject_id, row.order_id]))
      .toEqual([["email", "accepted", "gift_card", "gc_1", null], ["sms", "failed", "gift_card", "gc_1", null]]);
    for (const row of rows) expect(row.raw_response).toBeNull();
    const recorded = JSON.stringify([rows, result, errors.mock.calls]);
    expect(recorded).not.toContain(CODE);
    expect(recorded).toContain("[redacted]");
    errors.mockRestore();
  });

  it("keeps licence keys out of receipts even when the provider throws with the message", async () => {
    const outboxId = await outbox({ subjectType: "order", subjectId: "order_1", audience: "customer", notificationType: "order_digital_delivered" });
    mocks.sendEmail.mockRejectedValue(new Error(`SMTP 451 body was: Licence keys: ${KEYS}`));
    mocks.sendSms.mockResolvedValue({ success: true, providerRef: "sms1", rawStatus: `sent: Keys: ${KEYS}` });

    const result = await sendResolvedNotification(db, {
      outboxId,
      notificationType: "order_digital_delivered",
      subjectType: "order",
      subjectId: "order_1",
      orderId: "order_1",
      orderNumber: "#1057",
      recipient: { name: "Rahim", email: "rahim@example.test", phone: "+8801711111111" },
      extraTemplateData: { licence_keys: KEYS, sms_licence_keys: KEYS, download_names: "Recipes.pdf" },
    }, { env });

    const rows = receipts();
    expect(rows.map((row) => [row.channel, row.status, row.order_id])).toEqual([["email", "failed", "order_1"], ["sms", "accepted", "order_1"]]);
    const recorded = JSON.stringify([rows, result]);
    for (const part of ["KEY-AAAA-1111", "KEY-BBBB-2222"]) expect(recorded).not.toContain(part);
    for (const row of rows) expect(row.raw_response).toBeNull();
  });

  it("keeps the provider response for messages without codes", async () => {
    const outboxId = await outbox({ subjectType: "order", subjectId: "order_1", audience: "customer", notificationType: "review_request" });
    await sendResolvedNotification(db, {
      outboxId,
      notificationType: "review_request",
      subjectType: "order",
      subjectId: "order_1",
      orderId: "order_1",
      orderNumber: "#1057",
      recipient: { name: "Rahim", email: "rahim@example.test", phone: "+8801711111111" },
      extraTemplateData: { review_products: "Cotton panjabi", review_link: "https://shop.example.test/account/orders/order_1#reviews" },
    }, { env });

    // Review requests are email only by default (an SMS costs the merchant).
    expect(mocks.sendSms).not.toHaveBeenCalled();
    const email = mocks.sendEmail.mock.calls[0]![0] as { subject: string; text: string };
    expect(email.subject).toBe("How was your order #1057?");
    expect(email.text).toContain("Write a review: https://shop.example.test/account/orders/order_1#reviews");
    expect(receipts()).toMatchObject([{ channel: "email", status: "accepted", raw_response: "captured" }]);
  });

  it("records nothing-to-send as one skipped receipt", async () => {
    const outboxId = await outbox({ subjectType: "order", subjectId: "order_1", audience: "customer", notificationType: "review_request" });
    await recordNothingToSend(db, { outboxId, notificationType: "review_request", subjectType: "order", subjectId: "order_1", orderId: "order_1" });
    expect(receipts()).toMatchObject([{ status: "skipped", last_error: NOTHING_TO_SEND, order_id: "order_1" }]);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("alerts staff by email with the dashboard link, never the buyer", async () => {
    setDocument("notifications", { staffEmailRecipients: ["ops@shop.test"], adminChannels: { digital_keys_exhausted: ["email"] } });
    const outboxId = await outbox({ subjectType: "order", subjectId: "order_1", audience: "staff", notificationType: "digital_keys_exhausted" });

    const result = await sendStaffAlertNotification(db, { outboxId, orderId: "order_1", notificationType: "digital_keys_exhausted" }, { env });

    expect(result.hasRetryableFailure).toBe(false);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const email = mocks.sendEmail.mock.calls[0]![0] as { to: string; subject: string; text: string };
    expect(email.to).toBe("ops@shop.test");
    expect(email.subject).toBe("[River & Loom] Licence keys ran out");
    expect(email.text).toContain("Order #1057 is waiting for licence keys.");
    expect(email.text).toContain("https://admin.shop.test/admin/orders/order_1");
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });
});
