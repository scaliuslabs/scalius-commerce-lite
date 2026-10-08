// Web Push on the migrated schema: a browser subscribes once per endpoint
// (a shared computer moves it to the new person), an owner keeps the newest
// few, a send encrypts for each browser with the VAPID key derived from the
// master secret, a push service's 404/410 deletes the subscription, repeated
// failures drop it, and the buyer delivery port follows the store's choice.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { ValidationError } from "@scalius/core/errors";
import { notificationsDocument } from "./documents";
import {
  PUSH_SUBSCRIPTIONS_PER_OWNER,
  PUSH_SUBSCRIPTION_MAX_FAILURES,
  deletePushSubscription,
  hasPushSubscription,
  listStaffPushDevices,
  parsePushSubscription,
  savePushSubscription,
  sendCustomerPush,
  sendWebPushNotification,
  webPushPublicKey,
  webPushSender,
  type WebPushSender,
} from "./web-push";

let sqlite: DatabaseSync;
let db: Database;
const ENV = { SCALIUS_SECRET: "a-master-secret-for-web-push-tests-0123456789abcdef", STOREFRONT_URL: "https://shop.example" };

beforeEach(() => {
  ({ sqlite, db } = createSqliteD1Database());
  sqlite.exec(`
    INSERT INTO user (id, name, email, email_verified, role) VALUES ('usr_1', 'Staff', 'staff@shop.test', 1, 'admin');
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
  it("signs with the derived key, encrypts per browser, deletes a gone browser and drops one that keeps failing", async () => {
    expect(await webPushSender({})).toBeNull();
    expect(await webPushSender({ SCALIUS_SECRET: ENV.SCALIUS_SECRET, STOREFRONT_URL: "http://localhost:4321" })).toBeNull();
    const base = (await webPushSender(ENV))!;
    expect(base.subject).toBe("https://shop.example");
    expect(await webPushPublicKey(ENV)).toBe(base.vapid.publicKey);

    const owner = { audience: "customer" as const, customerId: "cust_1" };
    const ok = await browser("https://fcm.googleapis.com/fcm/send/ok");
    const gone = await browser("https://fcm.googleapis.com/fcm/send/gone");
    const flaky = await browser("https://fcm.googleapis.com/fcm/send/flaky");
    for (const each of [ok, gone, flaky]) await savePushSubscription(db, owner, parsePushSubscription(each));

    const { sender, calls } = recordingSender(base, { [gone.endpoint]: 410, [flaky.endpoint]: 503 });
    const result = await sendWebPushNotification(db, sender, { audience: "customer", customerIds: ["cust_1"] }, { title: "Shipped", body: "Your order is on its way.", url: "/account/orders/ord_1" });
    expect(result).toEqual({ subscriptions: 3, sent: 1, removed: 1, failed: 1 });
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.headers.Authorization).toMatch(new RegExp(`^vapid t=[^,]+, k=${base.vapid.publicKey}$`));
      expect(call.headers["Content-Encoding"]).toBe("aes128gcm");
      expect(call.bytes).toBeGreaterThan(86);
    }
    expect(await hasPushSubscription(db, owner, gone.endpoint)).toBe(false);
    expect(sqlite.prepare("SELECT failure_count AS n FROM push_subscriptions WHERE endpoint = ?").get(flaky.endpoint)).toEqual({ n: 1 });
    expect(Number((sqlite.prepare("SELECT last_success_at AS at FROM push_subscriptions WHERE endpoint = ?").get(ok.endpoint) as { at: number }).at)).toBeGreaterThan(0);

    for (let attempt = 1; attempt < PUSH_SUBSCRIPTION_MAX_FAILURES; attempt += 1) {
      await sendWebPushNotification(db, sender, { audience: "customer", customerIds: ["cust_1"] }, { title: "Again", body: "" });
    }
    expect(await hasPushSubscription(db, owner, flaky.endpoint)).toBe(false);
    expect(await hasPushSubscription(db, owner, ok.endpoint)).toBe(true);
  });

  it("sends a buyer's push through the store's choice: Web Push by default, never another buyer's browser", async () => {
    await savePushSubscription(db, { audience: "customer", customerId: "cust_2" }, parsePushSubscription(await browser("https://fcm.googleapis.com/fcm/send/sumi")));
    expect(await sendCustomerPush(db, ENV, undefined, { customerId: "cust_1", notification: { title: "Hi", body: "" } })).toEqual({ delivered: false });
    // An app push provider the store chose, without an app lookup: fails closed.
    await notificationsDocument.write(db, { pushProvider: "acme.push:push" });
    expect(await sendCustomerPush(db, ENV, undefined, { customerId: "cust_2", notification: { title: "Hi", body: "" } })).toEqual({ delivered: false });
  });
});
