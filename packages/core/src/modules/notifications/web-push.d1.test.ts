// Web Push on the migrated schema: a browser subscribes once per endpoint
// (a shared computer moves it to the new person), an owner keeps the newest
// few, a send encrypts for each browser with the VAPID key derived from the
// master secret, a push service's 404/410 deletes the subscription, repeated
// failures retain it, and the buyer delivery port follows the store's choice.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { ValidationError } from "@scalius/core/errors";
import { notificationsDocument } from "./documents";
import { removeStaffMember } from "../../auth/rbac/staff-removal";
import {
  PUSH_SUBSCRIPTIONS_PER_OWNER,
  deliverWebPush,
  deletePushSubscription,
  hasPushSubscription,
  listStaffPushDevices,
  parsePushSubscription,
  savePushSubscription,
  sendCustomerPush,
  sendStaffTestPush,
  sendWebPushNotification,
  webPushPublicKey,
  webPushPayload,
  webPushSender,
  type WebPushSender,
} from "./web-push";
import { MAX_WEB_PUSH_PLAINTEXT } from "../../integrations/web-push";

let sqlite: DatabaseSync;
let db: Database;
const ENV = { SCALIUS_SECRET: "a-master-secret-for-web-push-tests-0123456789abcdef", STOREFRONT_URL: "https://shop.example" };

beforeEach(() => {
  ({ sqlite, db } = createSqliteD1Database());
  sqlite.exec(`
    INSERT INTO user (id, name, email, email_verified, role) VALUES ('usr_1', 'Staff', 'staff@shop.test', 1, 'admin');
    INSERT INTO permissions (id,name,display_name,resource,action,category) VALUES ('orders-view','orders.view','Orders','orders','view','Orders');
    INSERT INTO user_permissions (id,user_id,permission_id,granted) VALUES ('staff-orders','usr_1','orders-view',1);
    INSERT INTO customers (id, name, phone) VALUES ('cust_1', 'Karim', '+8801711111111');
    INSERT INTO customers (id, name, phone) VALUES ('cust_2', 'Sumi', '+8801722222222');
  `);
});
afterEach(() => sqlite.close());

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** A real browser's keys: a P-256 public point and a 16-byte secret. */
async function browser(endpoint: string) {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const p256dh = base64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  return { endpoint, keys: { p256dh, auth: base64Url(crypto.getRandomValues(new Uint8Array(16))) } };
}

function recordingSender(base: WebPushSender, statuses: Record<string, number>) {
  const calls: Array<{ url: string; headers: Record<string, string>; bytes: number }> = [];
  const sender: WebPushSender = {
    ...base,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, bytes: (init.body as Uint8Array | undefined)?.byteLength ?? 0 });
      return new Response(null, { status: statuses[url] ?? 201 });
    }) as typeof fetch,
  };
  return { sender, calls };
}

describe("web push subscriptions", () => {
  it("accepts only a known push service and a well-formed key pair", async () => {
    const good = await browser("https://fcm.googleapis.com/fcm/send/abc");
    expect(parsePushSubscription({ ...good, deviceLabel: "  Chrome   on Android " })).toMatchObject({ deviceLabel: "Chrome on Android" });
    expect(() => parsePushSubscription({ ...good, endpoint: "https://evil.example/push" })).toThrow(ValidationError);
    expect(() => parsePushSubscription({ ...good, endpoint: "http://fcm.googleapis.com/fcm/send/abc" })).toThrow(ValidationError);
    expect(() => parsePushSubscription({ ...good, keys: { ...good.keys, auth: "short" } })).toThrow(ValidationError);
  });

  it("keeps one row per browser, moves it to whoever subscribes it, and the newest few per owner", async () => {
    const shared = parsePushSubscription(await browser("https://fcm.googleapis.com/fcm/send/shared"));
    await savePushSubscription(db, { audience: "customer", customerId: "cust_1" }, shared);
    await savePushSubscription(db, { audience: "customer", customerId: "cust_2" }, shared);
    expect(await hasPushSubscription(db, { audience: "customer", customerId: "cust_1" }, shared.endpoint)).toBe(false);
    expect(await hasPushSubscription(db, { audience: "customer", customerId: "cust_2" }, shared.endpoint)).toBe(true);

    for (let index = 0; index < PUSH_SUBSCRIPTIONS_PER_OWNER + 2; index += 1) {
      await savePushSubscription(db, { audience: "staff", userId: "usr_1" }, parsePushSubscription(await browser(`https://updates.push.services.mozilla.com/wpush/v2/${index}`)));
      sqlite.prepare("UPDATE push_subscriptions SET updated_at = ? WHERE endpoint = ?").run(1_000 + index, `https://updates.push.services.mozilla.com/wpush/v2/${index}`);
    }
    expect(await listStaffPushDevices(db, "usr_1")).toHaveLength(PUSH_SUBSCRIPTIONS_PER_OWNER);
    await savePushSubscription(db, { audience: "staff", userId: "usr_1" }, parsePushSubscription(await browser("https://fcm.googleapis.com/fcm/send/latest")));
    expect(await listStaffPushDevices(db, "usr_1")).toHaveLength(PUSH_SUBSCRIPTIONS_PER_OWNER);
    expect(await hasPushSubscription(db, { audience: "staff", userId: "usr_1" }, "https://fcm.googleapis.com/fcm/send/latest")).toBe(true);
    expect(await deletePushSubscription(db, { audience: "staff", userId: "usr_1" }, "https://fcm.googleapis.com/fcm/send/latest")).toBe(true);
  });
});

describe("web push delivery", () => {
  it("does not deliver to a removed staff member's retained browser, for broadcast or targeted sends", async () => {
    const endpoint = "https://fcm.googleapis.com/fcm/send/removed-staff";
    await savePushSubscription(db, { audience: "staff", userId: "usr_1" }, parsePushSubscription(await browser(endpoint)));
    const { sender, calls } = recordingSender((await webPushSender(ENV))!, {});
    await removeStaffMember(db, { actorId: "owner", userId: "usr_1" });
    expect(await hasPushSubscription(db, { audience: "staff", userId: "usr_1" }, endpoint)).toBe(true);
    for (const target of [{ requiredPermission: "orders.view" as const, audience: "staff" as const }, { requiredPermission: "orders.view" as const, audience: "staff" as const, userIds: ["usr_1"] }]) {
      expect(await sendWebPushNotification(db, sender, target, { title: "Private staff alert", body: "" }))
        .toEqual({ subscriptions: 0, sent: 0, removed: 0, failed: 0 });
    }
    expect(calls).toEqual([]);
  });

  it("resumes a temporary ban only after its expiry, matching current session authority", async () => {
    await savePushSubscription(db, { audience: "staff", userId: "usr_1" }, parsePushSubscription(await browser("https://fcm.googleapis.com/fcm/send/temporary-ban")));
    const { sender, calls } = recordingSender((await webPushSender(ENV))!, {});
    sqlite.exec("UPDATE user SET banned = 1, ban_expires = unixepoch() + 3600 WHERE id = 'usr_1'");
    expect((await sendWebPushNotification(db, sender, { audience: "staff", requiredPermission: "orders.view" }, { title: "Staff alert", body: "" })).subscriptions).toBe(0);
    sqlite.exec("UPDATE user SET ban_expires = unixepoch() - 1 WHERE id = 'usr_1'");
    expect((await sendWebPushNotification(db, sender, { audience: "staff", requiredPermission: "orders.view" }, { title: "Staff alert", body: "" })).sent).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("signs and encrypts per browser, removes expired endpoints and retains repeated failures through recovery", async () => {
    expect(await webPushSender({})).toBeNull();
    expect(await webPushSender({ SCALIUS_SECRET: ENV.SCALIUS_SECRET, STOREFRONT_URL: "http://localhost:4321" })).toBeNull();
    const base = (await webPushSender(ENV))!;
    expect(base.subject).toBe("https://shop.example");
    expect(await webPushPublicKey(ENV)).toBe(base.vapid.publicKey);

    const owner = { audience: "customer" as const, customerId: "cust_1" };
    const ok = await browser("https://fcm.googleapis.com/fcm/send/ok");
    const gone = await browser("https://fcm.googleapis.com/fcm/send/gone");
    const flaky = await browser("https://fcm.googleapis.com/fcm/send/flaky");
    const rejected = await browser("https://fcm.googleapis.com/fcm/send/rejected");
    for (const each of [ok, gone, flaky, rejected]) await savePushSubscription(db, owner, parsePushSubscription(each));

    const statuses = { [gone.endpoint]: 410, [flaky.endpoint]: 503, [rejected.endpoint]: 403 };
    const { sender, calls } = recordingSender(base, statuses);
    const result = await sendWebPushNotification(db, sender, { audience: "customer", customerIds: ["cust_1"] }, { title: "Shipped", body: "Your order is on its way.", url: "/account/orders/ord_1" });
    expect(result).toEqual({ subscriptions: 4, sent: 1, removed: 1, failed: 2 });
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.headers.Authorization).toMatch(new RegExp(`^vapid t=[^,]+, k=${base.vapid.publicKey}$`));
      expect(call.headers["Content-Encoding"]).toBe("aes128gcm");
      expect(call.bytes).toBeGreaterThan(86);
    }
    expect(await hasPushSubscription(db, owner, gone.endpoint)).toBe(false);
    expect(sqlite.prepare("SELECT failure_count AS n FROM push_subscriptions WHERE endpoint = ?").get(flaky.endpoint)).toEqual({ n: 1 });
    expect(Number((sqlite.prepare("SELECT last_success_at AS at FROM push_subscriptions WHERE endpoint = ?").get(ok.endpoint) as { at: number }).at)).toBeGreaterThan(0);

    for (let attempt = 1; attempt < 8; attempt += 1) {
      statuses[flaky.endpoint] = attempt % 2 ? 429 : 503;
      await sendWebPushNotification(db, sender, { audience: "customer", customerIds: ["cust_1"] }, { title: "Again", body: "" });
    }
    expect(await hasPushSubscription(db, owner, flaky.endpoint)).toBe(true);
    expect(await hasPushSubscription(db, owner, rejected.endpoint)).toBe(true);
    expect(await hasPushSubscription(db, owner, ok.endpoint)).toBe(true);
    expect(sqlite.prepare("SELECT failure_count AS n FROM push_subscriptions WHERE endpoint = ?").get(flaky.endpoint)).toEqual({ n: 8 });
    statuses[flaky.endpoint] = 201;
    statuses[rejected.endpoint] = 201;
    expect(await sendWebPushNotification(db, sender, { audience: "customer", customerIds: ["cust_1"] }, { title: "Recovered", body: "" }))
      .toEqual({ subscriptions: 3, sent: 3, removed: 0, failed: 0 });
    expect(sqlite.prepare("SELECT failure_count AS n FROM push_subscriptions WHERE endpoint = ?").get(flaky.endpoint)).toEqual({ n: 0 });
  });

  it("retains a healthy browser after local signing, payload and network failures", async () => {
    const owner = { requiredPermission: "orders.view" as const, audience: "staff" as const, userId: "usr_1" };
    const input = await browser("https://fcm.googleapis.com/fcm/send/healthy");
    const { id } = await savePushSubscription(db, owner, parsePushSubscription(input));
    const subscription = { id, endpoint: input.endpoint, ...input.keys };
    const { sender, calls } = recordingSender((await webPushSender(ENV))!, {});
    expect(await deliverWebPush(db, { ...sender, subject: "http://localhost" }, subscription, "{}" )).toBe("retry");
    expect(await deliverWebPush(db, sender, subscription, "x".repeat(MAX_WEB_PUSH_PLAINTEXT + 1))).toBe("retry");
    expect(calls).toHaveLength(0);
    const offline = { ...sender, fetch: (async () => { throw new Error("offline"); }) as typeof fetch };
    expect(await deliverWebPush(db, offline, subscription, "{}")).toBe("retry");
    expect(await hasPushSubscription(db, owner, input.endpoint)).toBe(true);
    expect(await deliverWebPush(db, sender, subscription, "{}")).toBe("sent");
  });

  it("removes only proven invalid subscriber key material", async () => {
    const owner = { requiredPermission: "orders.view" as const, audience: "staff" as const, userId: "usr_1" };
    const input = await browser("https://fcm.googleapis.com/fcm/send/invalid");
    const { sender, calls } = recordingSender((await webPushSender(ENV))!, {});
    for (const keys of [
      { ...input.keys, auth: "AAAA" },
      { ...input.keys, p256dh: base64Url(Uint8Array.from([4, ...new Array<number>(64).fill(0)])) },
    ]) {
      const { id } = await savePushSubscription(db, owner, parsePushSubscription(input));
      expect(await deliverWebPush(db, sender, { id, endpoint: input.endpoint, ...keys }, "{}")).toBe("gone");
      expect(await hasPushSubscription(db, owner, input.endpoint)).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it("fits localized and escaped JSON by UTF-8 bytes while preserving the destination and tag", () => {
    const notification = { title: "অর্ডার পাঠানো হয়েছে", body: "বাংলা 📦\n\"".repeat(500), url: "/account/orders/order_1", tag: "order:order_1" };
    const payload = webPushPayload(notification);
    const decoded = JSON.parse(payload) as typeof notification;
    expect(new TextEncoder().encode(payload).length).toBeLessThanOrEqual(MAX_WEB_PUSH_PLAINTEXT);
    expect(decoded).toMatchObject({ title: notification.title, url: notification.url, tag: notification.tag });
    expect(notification.body.startsWith(decoded.body)).toBe(true);
    expect(decoded.body).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(new TextEncoder().encode(JSON.stringify({ ...decoded, body: decoded.body + Array.from(notification.body.slice(decoded.body.length))[0] })).length)
      .toBeGreaterThan(MAX_WEB_PUSH_PLAINTEXT);
    expect(() => webPushPayload({ title: "Test", body: "", url: `/${"x".repeat(4000)}` })).toThrow("Push metadata is too large");
  });

  it("sends a staff test push only to the staff member's own device and records its delivery status", async () => {
    sqlite.exec("INSERT INTO user (id, name, email, email_verified, role) VALUES ('usr_2', 'Other', 'other@shop.test', 1, 'admin')");
    const base = (await webPushSender(ENV))!;
    const phone = await browser("https://web.push.apple.com/phone");
    const laptop = await browser("https://fcm.googleapis.com/fcm/send/laptop");
    const { id: phoneId } = await savePushSubscription(db, { audience: "staff", userId: "usr_1" }, parsePushSubscription(phone));
    const { id: laptopId } = await savePushSubscription(db, { audience: "staff", userId: "usr_1" }, parsePushSubscription(laptop));
    const { sender, calls } = recordingSender(base, { [laptop.endpoint]: 503 });
    const note = { title: "Test notification", body: "Notifications work on this device." };

    expect(await sendStaffTestPush(db, sender, "usr_1", phoneId, note)).toBe("sent");
    expect(calls.map((call) => call.url)).toEqual([phone.endpoint]);
    expect(calls[0]!.headers.Urgency).toBe("high");
    expect(await sendStaffTestPush(db, sender, "usr_1", laptopId, note)).toBe("retry");
    // Another person's device is never theirs to test.
    expect(await sendStaffTestPush(db, sender, "usr_2", phoneId, note)).toBeNull();
    expect(calls).toHaveLength(2);

    const devices = await listStaffPushDevices(db, "usr_1");
    expect(devices.find((device) => device.id === phoneId)).toMatchObject({ failureCount: 0, lastSuccessAt: expect.any(Date) });
    expect(devices.find((device) => device.id === laptopId)).toMatchObject({ failureCount: 1, lastSuccessAt: null });
  });

  it("sends a buyer's push through the store's choice: Web Push by default, never another buyer's browser", async () => {
    await savePushSubscription(db, { audience: "customer", customerId: "cust_2" }, parsePushSubscription(await browser("https://fcm.googleapis.com/fcm/send/sumi")));
    expect(await sendCustomerPush(db, ENV, undefined, { customerId: "cust_1", notification: { title: "Hi", body: "" } })).toEqual({ delivered: false });
    // An app push provider the store chose, without an app lookup: fails closed.
    await notificationsDocument.write(db, { pushProvider: "acme.push:push" });
    expect(await sendCustomerPush(db, ENV, undefined, { customerId: "cust_2", notification: { title: "Hi", body: "" } })).toEqual({ delivered: false });
  });
});
