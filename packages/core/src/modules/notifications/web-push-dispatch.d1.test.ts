import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { sendAdminPush, sendAdminPushNotice, sendOrderNotification, sendOrderNotificationEmail } from "./notifications.service";
import * as webPush from "./web-push";

const fcm = vi.hoisted(() => ({ sendEachForMulticast: vi.fn() }));
vi.mock("../../integrations/firebase/admin", () => ({ getFirebaseAdminMessaging: () => fcm }));

const ENV = {
  SCALIUS_SECRET: "a-master-secret-for-web-push-tests-0123456789abcdef",
  BETTER_AUTH_URL: "https://admin.example.test",
  STOREFRONT_URL: "https://shop.example.test",
} as unknown as Env;
let sqlite: DatabaseSync;
let db: Database;
let queryFault: ((query: string) => void) | undefined;
let sent: string[];

beforeEach(() => {
  queryFault = undefined;
  sent = [];
  ({ sqlite, db } = createSqliteD1Database({ onQuery: (query) => queryFault?.(query) }));
  sqlite.exec(`
    INSERT INTO user (id, name, email, email_verified, role) VALUES ('staff', 'Staff', 'staff@example.test', 1, 'admin');
    INSERT INTO permissions (id, name, display_name, resource, action, category) VALUES ('orders-view', 'orders.view', 'Orders', 'orders', 'view', 'Orders');
    INSERT INTO user_permissions (id, user_id, permission_id, granted) VALUES ('staff-orders', 'staff', 'orders-view', 1);
    INSERT INTO customers (id, name, phone) VALUES ('buyer', 'Buyer', '+8801711111111');
    INSERT INTO orders (id, customer_id, customer_name, customer_phone, shipping_address, city, zone)
      VALUES ('order_push', 'buyer', 'Buyer', '+8801711111111', 'House 1, Road 2', 'city_1', 'zone_1');
    INSERT INTO notification_outbox (id, dedupe_key, subject_type, subject_id, order_id, audience, notification_type, source, payload)
      VALUES ('outbox_push', 'push-test', 'order', 'order_push', 'order_push', 'customer', 'order_confirmed', 'test', '{}');
    INSERT INTO settings (id, key, value, category, type)
      VALUES ('push-rules', 'document', '{"orderChannels":{"order_confirmed":["push"]}}', 'notifications', 'json');
  `);
  fcm.sendEachForMulticast.mockReset().mockResolvedValue({ failureCount: 0, responses: [{ success: true, messageId: "fcm-accepted" }] });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    sent.push(url);
    return new Response(null, { status: 201 });
  }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  sqlite.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function subscribe(audience: "staff" | "customer", suffix: string) {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const endpoint = `https://fcm.googleapis.com/fcm/send/${suffix}`;
  await webPush.savePushSubscription(db, audience === "staff" ? { audience, userId: "staff" } : { audience, customerId: "buyer" }, {
    endpoint,
    keys: {
      p256dh: Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64url"),
      auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url"),
    },
  });
  return endpoint;
}

function dispatch(audience: "staff" | "customer") {
  return audience === "staff"
    ? sendOrderNotification(db, { id: "order_push", customerName: "Buyer", notificationType: "order_confirmed" }, ENV, "https://api.example.test", { outboxId: "outbox_push" })
    : sendOrderNotificationEmail(null, "Buyer", "order_push", "order_confirmed", undefined, db, { env: ENV, outboxId: "outbox_push" });
}

describe("Web Push dispatch retries", () => {
  it("keeps customer punctuation as plain text in native order notifications", async () => {
    await subscribe("staff", "plain-name");
    sqlite.exec("INSERT INTO admin_fcm_tokens (id, user_id, token, is_active) VALUES ('plain-token', 'staff', 'fcm-test-token', 1)");
    const payload = vi.spyOn(webPush, "webPushPayload");
    const customerName = "A&B O'Neil <shop>";
    await sendOrderNotification(db, { id: "order_push", customerName, notificationType: "order_confirmed" }, ENV, "https://api.example.test");
    const body = `Order Confirmed from ${customerName}. Click to view.`;
    expect(payload).toHaveBeenCalledWith(expect.objectContaining({ body }));
    expect(fcm.sendEachForMulticast).toHaveBeenCalledWith(expect.objectContaining({ notification: expect.objectContaining({ body }) }));
  });

  it.each(["staff", "customer"] as const)("keeps a %s subscription read failure retryable", async (audience) => {
    await subscribe(audience, "reader-failure");
    queryFault = (query) => {
      if (query.includes('from "push_subscriptions"')) throw new Error("temporary database failure");
    };
    const result = await dispatch(audience);
    expect(result.hasRetryableFailure).toBe(true);
    expect(result.outcomes).toContainEqual(expect.objectContaining({ provider: "webpush", status: "failed", retryable: true, error: "web_push_dispatch_failed" }));
    expect(sent).toEqual([]);
  });

  it.each(["staff", "customer"] as const)("preserves accepted %s receipts when a later device claim fails", async (audience) => {
    await subscribe(audience, "first");
    await subscribe(audience, "second");
    const payload = vi.spyOn(webPush, "webPushPayload");
    const delivery = vi.spyOn(webPush, "deliverWebPush");
    let claims = 0;
    queryFault = (query) => {
      if (query.startsWith('insert into "notification_delivery_receipts"') && ++claims === 2) throw new Error("temporary receipt failure");
    };
    const first = await dispatch(audience);
    expect(first.hasRetryableFailure).toBe(true);
    expect(first.outcomes.filter((outcome) => outcome.status === "accepted")).toHaveLength(1);
    expect(sent).toHaveLength(1);
    const acceptedEndpoint = sent[0];
    expect(sqlite.prepare("SELECT count(*) AS n FROM notification_delivery_receipts WHERE provider = 'webpush' AND status = 'accepted'").get()).toEqual({ n: 1 });

    queryFault = undefined;
    const retry = await dispatch(audience);
    expect(retry.hasRetryableFailure).toBe(false);
    expect(sent).toHaveLength(2);
    expect(sent.filter((endpoint) => endpoint === acceptedEndpoint)).toHaveLength(1);
    expect(sqlite.prepare("SELECT count(*) AS n FROM notification_delivery_receipts WHERE provider = 'webpush' AND status = 'accepted'").get()).toEqual({ n: 2 });
    expect(payload).toHaveBeenCalledWith(expect.objectContaining({ tag: audience === "staff" ? "evt:outbox_push" : "order:order_push" }));
    if (audience === "staff") expect(delivery).toHaveBeenCalledWith(db, expect.anything(), expect.anything(), expect.any(String), { staffRequirement: "orders.view" });
  });

  it("keeps the accepted FCM outcome when the independent Web Push branch fails", async () => {
    sqlite.exec("INSERT INTO admin_fcm_tokens (id, user_id, token, is_active) VALUES ('token', 'staff', 'fcm-test-token', 1)");
    queryFault = (query) => {
      if (query.includes('from "push_subscriptions"')) throw new Error("temporary database failure");
    };
    const result = await dispatch("staff");
    expect(result.hasRetryableFailure).toBe(true);
    expect(result.outcomes).toContainEqual(expect.objectContaining({ provider: "fcm", status: "accepted", retryable: false }));
    expect(result.outcomes).toContainEqual(expect.objectContaining({ provider: "webpush", status: "failed", retryable: true }));
    expect(fcm.sendEachForMulticast).toHaveBeenCalledTimes(1);
  });
});

describe("staff push resource authorization", () => {
  beforeEach(async () => {
    await subscribe("staff", "permission-test");
    sqlite.exec("INSERT INTO admin_fcm_tokens (id,user_id,token,is_active) VALUES ('token','staff','fcm-test-token',1)");
  });

  it.each([
    "UPDATE user_permissions SET granted=0",
    "DELETE FROM user_permissions",
    "UPDATE user SET banned=1,ban_expires=NULL",
    "UPDATE user SET banned=1,ban_expires=unixepoch()+3600",
  ])("excludes unauthorized devices before either transport claims a receipt: %s", async (mutation) => {
    sqlite.exec(mutation);
    const result = await dispatch("staff");
    expect(result.outcomes).toEqual([]);
    expect(sent).toEqual([]);
    expect(fcm.sendEachForMulticast).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT count(*) AS n FROM notification_delivery_receipts").get()).toEqual({ n: 0 });
  });

  it("rechecks role removal on each dispatch and allows an unbanned super-admin", async () => {
    sqlite.exec(`DELETE FROM user_permissions;
      INSERT INTO roles (id,name,display_name) VALUES ('role','orders-test','Orders');
      INSERT INTO role_permissions (id,role_id,permission_id) VALUES ('role-perm','role','orders-view');
      INSERT INTO user_roles (id,user_id,role_id) VALUES ('assigned','staff','role');
      DELETE FROM user_roles;`);
    await dispatch("staff");
    expect(sent).toEqual([]);
    expect(fcm.sendEachForMulticast).not.toHaveBeenCalled();
    sqlite.exec("UPDATE user SET is_super_admin=1; INSERT INTO user_permissions (id,user_id,permission_id,granted) VALUES ('deny','staff','orders-view',0)");
    await dispatch("staff");
    expect(sent).toHaveLength(1);
    expect(fcm.sendEachForMulticast).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT count(*) AS n FROM notification_delivery_receipts WHERE status='accepted'").get()).toEqual({ n: 2 });
  });

  it("does not disclose conversations to order-only staff or buyer-only events to any staff", async () => {
    const delivery = vi.spyOn(webPush, "deliverWebPush");
    const spec = {
      receipt: { subjectType: "conversation" as const, subjectId: "thread", notificationType: "conversation_message" as const },
      setupRecipient: "test", logLabel: "test", title: "Message", body: "Open inbox", link: null, data: {},
    };
    await sendAdminPush(db, ENV, spec);
    expect(sent).toEqual([]);
    expect(fcm.sendEachForMulticast).not.toHaveBeenCalled();
    sqlite.exec("UPDATE permissions SET name='conversations.view' WHERE id='orders-view'");
    await sendAdminPush(db, ENV, spec);
    expect(sent).toHaveLength(1);
    expect(fcm.sendEachForMulticast).toHaveBeenCalledTimes(1);
    expect(delivery).toHaveBeenCalledWith(db, expect.anything(), expect.anything(), expect.any(String), { staffRequirement: "conversations.view" });
    await sendAdminPush(db, ENV, { ...spec, receipt: { ...spec.receipt, notificationType: "conversation_reply" } });
    expect(sent).toHaveLength(1);
    expect(fcm.sendEachForMulticast).toHaveBeenCalledTimes(1);
  });

  it("restricts resource notices and arbitrary app payloads through the same two-transport policy", async () => {
    const delivery = vi.spyOn(webPush, "sendWebPushNotification");
    const notice = { title: "Notice", body: "Private fact", link: null, data: { notificationType: "webhook_disabled" } };
    await sendAdminPushNotice(db, ENV, notice);
    expect(sent).toEqual([]);
    expect(fcm.sendEachForMulticast).not.toHaveBeenCalled();
    sqlite.exec("UPDATE permissions SET name='webhooks.view' WHERE id='orders-view'");
    await sendAdminPushNotice(db, ENV, notice);
    expect(sent).toHaveLength(1);
    expect(fcm.sendEachForMulticast).toHaveBeenCalledTimes(1);
    await sendAdminPushNotice(db, ENV, { ...notice, data: { notificationType: "plugin_notice" } });
    expect(sent).toHaveLength(1);
    sqlite.exec("UPDATE user SET is_super_admin=1");
    await sendAdminPushNotice(db, ENV, { ...notice, data: { notificationType: "plugin_notice" } });
    expect(sent).toHaveLength(2);
    expect(fcm.sendEachForMulticast).toHaveBeenCalledTimes(2);
    expect(delivery).toHaveBeenLastCalledWith(db, expect.anything(), { audience: "staff", requiredPermission: "super_admin" }, expect.anything());
    await sendAdminPushNotice(db, ENV, { ...notice, data: { notificationType: "unknown" } });
    expect(sent).toHaveLength(2);
  });
});
