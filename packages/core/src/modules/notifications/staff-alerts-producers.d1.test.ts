import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { seedStaffAlerts, seedStaffAlertEvent } from "./testing/staff-alerts";
import { readStaffAlerts } from "./staff-alerts";
import { sendStaffOrderEmails } from "./notifications.service";
import { sendStaffAlertNotification } from "./resolved-notifications";
import { sendConversationNotification } from "./conversation-notifications";
import { postConversationMessage, readThread } from "../conversations";

const mocks = vi.hoisted(() => ({ email: vi.fn() }));
vi.mock("../../integrations/email", () => ({ sendEmail: mocks.email }));
let sqlite: DatabaseSync;
let db: Database;
const env = {} as Env;
function settings(value: Record<string, unknown>) {
  sqlite.prepare("INSERT INTO settings(id,key,value,category,type) VALUES('bell_rules','document',?,'notifications','json')").run(JSON.stringify(value));
}
beforeEach(async () => {
  ({ sqlite, db } = createSqliteD1Database());
  await seedStaffAlerts(db);
  mocks.email.mockReset().mockImplementation(async () => {
    // The actual dispatcher must durably record before any provider invocation.
    expect((await readStaffAlerts(db, "bell_a")).items).toHaveLength(1);
    return { success: true, provider: "mailpit", providerRef: "captured", rawStatus: "captured" };
  });
});
afterEach(() => sqlite.close());

describe("durable bell in existing notification dispatchers", () => {
  it("records an email-only new order with no devices and keeps the retry idempotent", async () => {
    settings({ adminChannels: { order_created: [] }, staffEmailRecipients: ["ops@example.test"] });
    await seedStaffAlertEvent(db, "bell_email_only");
    const input = { id: "bell_order", customerName: "Private Buyer", notificationType: "order_created" as const };
    await sendStaffOrderEmails(db, input, { outboxId: "bell_email_only", env });
    await sendStaffOrderEmails(db, input, { outboxId: "bell_email_only", env });
    expect(mocks.email).toHaveBeenCalledTimes(1);
    expect((await readStaffAlerts(db, "bell_a")).items.map((item) => item.id)).toEqual(["bell_email_only"]);
  });

  it("uses the existing staff defaults when no settings document is saved", async () => {
    await seedStaffAlertEvent(db, "bell_default_rules");
    await sendStaffOrderEmails(db, { id: "bell_order", customerName: "Private Buyer", notificationType: "order_created" }, { outboxId: "bell_default_rules", env });
    expect((await readStaffAlerts(db, "bell_a")).items.map((item) => item.id)).toEqual(["bell_default_rules"]);
    expect(mocks.email).not.toHaveBeenCalled();
  });

  it("does not record a disabled order event", async () => {
    settings({ adminChannels: { order_created: [] }, staffEmailRecipients: [] });
    await seedStaffAlertEvent(db, "bell_disabled_dispatch");
    await sendStaffOrderEmails(db, { id: "bell_order", customerName: "Private Buyer", notificationType: "order_created" }, { outboxId: "bell_disabled_dispatch", env });
    expect((await readStaffAlerts(db, "bell_a")).items).toEqual([]);
    expect(mocks.email).not.toHaveBeenCalled();
  });

  it("records enabled order history without a configured push origin or email recipients", async () => {
    settings({ adminChannels: { order_created: ["push"] }, staffEmailRecipients: [] });
    await seedStaffAlertEvent(db, "bell_no_sender");
    await sendStaffOrderEmails(db, { id: "bell_order", customerName: "Private Buyer", notificationType: "order_created" }, { outboxId: "bell_no_sender", env });
    expect((await readStaffAlerts(db, "bell_a")).items.map((item) => item.id)).toEqual(["bell_no_sender"]);
    expect(mocks.email).not.toHaveBeenCalled();
  });

  it("records the existing order-subject staff alert before email-only dispatch", async () => {
    settings({ adminChannels: { digital_keys_exhausted: ["email"] }, staffEmailRecipients: ["ops@example.test"] });
    await seedStaffAlertEvent(db, "bell_keys");
    sqlite.exec("UPDATE notification_outbox SET notification_type='digital_keys_exhausted' WHERE id='bell_keys'");
    await sendStaffAlertNotification(db, { outboxId: "bell_keys", orderId: "bell_order", notificationType: "digital_keys_exhausted" }, { env });
    expect(mocks.email).toHaveBeenCalledTimes(1);
    expect((await readStaffAlerts(db, "bell_a")).items[0]).toMatchObject({ kind: "digital_keys_exhausted", href: "/admin/orders/bell_order" });
  });

  it("records an actual buyer-message outbox through the email-only conversation dispatcher", async () => {
    settings({ adminChannels: { conversation_message: ["email"] }, staffEmailRecipients: ["ops@example.test"] });
    const thread = await readThread(db, "cnv_bell_00001");
    const message = await postConversationMessage(db, thread!, { actor: { kind: "guest_receipt", orderId: "bell_order" }, body: "Private message text" });
    const outbox = sqlite.prepare("SELECT id FROM notification_outbox WHERE conversation_id=? AND notification_type='conversation_message'").get(message.conversationId)!;
    await sendConversationNotification(db, { outboxId: String(outbox.id), conversationId: message.conversationId, notificationType: "conversation_message", seq: message.seq }, { env });
    expect(mocks.email).toHaveBeenCalledTimes(1);
    const page = await readStaffAlerts(db, "bell_a");
    expect(page.items[0]).toMatchObject({ kind: "conversation_message", href: "/admin/inbox/cnv_bell_00001" });
    expect(JSON.stringify(page)).not.toContain("Private message text");
  });
});
