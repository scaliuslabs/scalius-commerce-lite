import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
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

import { getOrCreateOrderThread, postConversationMessage, readThread } from "../conversations";
import { sendConversationNotification } from "./conversation-notifications";

describe("conversation notifications at send time", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  const env = { STOREFRONT_URL: "https://shop.example.test", BETTER_AUTH_URL: "https://admin.shop.test" } as unknown as Env;

  function setDocument(document: string, fields: Record<string, unknown>) {
    sqlite.prepare("INSERT OR IGNORE INTO settings (id, key, value, category, type) VALUES (?, 'document', '{}', ?, 'json')")
      .run(document, document);
    sqlite.prepare("UPDATE settings SET value = json_patch(value, ?) WHERE category = ?").run(JSON.stringify(fields), document);
  }

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.exec(`
      INSERT INTO orders (id, customer_name, customer_phone, customer_email, shipping_address, city, zone, city_name, zone_name,
          total_amount_minor, subtotal_amount_minor, status, order_number)
        VALUES ('order_1', 'Rahim', '+8801711111111', 'rahim@example.test', 'House 1', 'c', 'z', 'Dhaka', 'Mirpur', 1000, 1000, 'confirmed', 1057);
      INSERT INTO user (id, name, email, email_verified, role) VALUES ('staff_1', 'Nadia', 'nadia@shop.test', 1, 'admin');
      INSERT INTO admin_fcm_tokens (id, user_id, token, is_active) VALUES ('tok_1', 'staff_1', 'fcm-token-abcdef123456', 1);
    `);
    setDocument("business", { companyName: "River & Loom" });
    mocks.sendEmail.mockReset().mockResolvedValue({ success: true, provider: "mailpit", providerRef: "m1", rawStatus: "captured" });
    mocks.sendSms.mockReset().mockResolvedValue({ success: true, providerRef: "sms1", rawStatus: "accepted" });
    mocks.sendEachForMulticast.mockReset().mockResolvedValue({ responses: [{ success: true, messageId: "fcm1" }] });
  });

  afterEach(() => sqlite.close());

  async function post(actor: "buyer" | "staff", body: string) {
    const thread = await getOrCreateOrderThread(db, "order_1");
    const result = await postConversationMessage(db, (await readThread(db, thread.id))!, {
      actor: actor === "buyer" ? { kind: "guest_receipt", orderId: "order_1" } : { kind: "staff", userId: "staff_1" },
      body,
    });
    const outbox = sqlite.prepare("SELECT id, notification_type, payload FROM notification_outbox WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC")
      .get(result.conversationId) as { id: string; notification_type: string; payload: string };
    return { ...result, outbox };
  }

  it("emails the buyer the staff reply, HTML-escaped, and keeps the text out of the outbox payload", async () => {
    const reply = await post("staff", "Your parcel <b>ships</b> tomorrow & arrives Friday");
    expect(reply.outbox.notification_type).toBe("conversation_reply");
    expect(JSON.parse(reply.outbox.payload)).toEqual({ notificationType: "conversation_reply", data: { seq: 1 } });

    const outcome = await sendConversationNotification(db, {
      outboxId: reply.outbox.id,
      conversationId: reply.conversationId,
      notificationType: "conversation_reply",
      seq: reply.seq,
    }, { env });
    expect(outcome).toMatchObject({ kind: "dispatched", result: { hasRetryableFailure: false } });
    const email = mocks.sendEmail.mock.calls[0]![0] as { to: string; subject: string; html: string; text: string };
    expect(email.to).toBe("rahim@example.test");
    expect(email.subject).toBe("River & Loom replied about order #1057");
    expect(email.html).toContain("Your parcel &lt;b&gt;ships&lt;/b&gt; tomorrow &amp; arrives Friday");
    expect(email.html).not.toContain("<b>ships</b>");
    expect(email.html).toContain("https://shop.example.test/track-order?order=1057");
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it("coalesces reply SMS to one per thread per hour and never puts the message in it", async () => {
    setDocument("notifications", { orderChannels: { conversation_reply: ["sms"] } });
    const first = await post("staff", "Secret tracking detail 123");
    await sendConversationNotification(db, { outboxId: first.outbox.id, conversationId: first.conversationId, notificationType: "conversation_reply", seq: first.seq }, { env });
    const second = await post("staff", "One more thing");
    await sendConversationNotification(db, { outboxId: second.outbox.id, conversationId: second.conversationId, notificationType: "conversation_reply", seq: second.seq }, { env });

    expect(mocks.sendSms).toHaveBeenCalledTimes(1);
    expect(mocks.sendSms.mock.calls[0]![0].message).not.toContain("Secret");
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT status, last_error FROM notification_delivery_receipts WHERE channel = 'sms' ORDER BY created_at, rowid").all())
      .toEqual([
        { status: "accepted", last_error: null },
        { status: "skipped", last_error: "conversation_sms_coalesced" },
      ]);

    // After the hour, the next reply texts again.
    sqlite.exec("UPDATE notification_delivery_receipts SET accepted_at = accepted_at - 3601");
    const third = await post("staff", "Later");
    await sendConversationNotification(db, { outboxId: third.outbox.id, conversationId: third.conversationId, notificationType: "conversation_reply", seq: third.seq }, { env });
    expect(mocks.sendSms).toHaveBeenCalledTimes(2);
  });

  it("pushes staff 'New message about #1234' with no message text, linked to the inbox", async () => {
    const message = await post("buyer", "My bKash TrxID is 8H6K2L");
    expect(message.outbox.notification_type).toBe("conversation_message");
    await sendConversationNotification(db, { outboxId: message.outbox.id, conversationId: message.conversationId, notificationType: "conversation_message", seq: message.seq }, { env });
    const push = mocks.sendEachForMulticast.mock.calls[0]![0] as { notification: { title: string; body: string }; data: Record<string, string> };
    expect(push.notification.title).toBe("New message about #1057");
    expect(JSON.stringify(push)).not.toContain("8H6K2L");
    expect(push.data.link).toBe(`https://admin.shop.test/admin/inbox/${message.conversationId}`);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("sends nothing for internal notes", async () => {
    const thread = await getOrCreateOrderThread(db, "order_1");
    const note = await postConversationMessage(db, thread, { actor: { kind: "staff", userId: "staff_1" }, body: "note", visibility: "internal" });
    expect(sqlite.prepare("SELECT count(*) AS n FROM notification_outbox").get()).toEqual({ n: 0 });
    expect(await sendConversationNotification(db, { outboxId: "ono_x", conversationId: note.conversationId, notificationType: "conversation_reply", seq: note.seq }, { env }))
      .toEqual({ kind: "nothing_to_send", reason: "not_a_public_message" });
  });
});
