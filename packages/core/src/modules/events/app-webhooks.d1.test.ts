// App-owned webhook subscriptions (`write_webhooks`) on the real migrated
// schema: an app reaches only its own, stays inside its grant's hosts, topics
// and customer data, and delivers only while active and within its live grant.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { buildEventRepresentation } from "@scalius/shared/events";
import { allProtectedData } from "@scalius/shared/plugins/protected-data";
import {
  EVENT_FAN_OUT_TARGETS,
  MAX_APP_WEBHOOK_SUBSCRIPTIONS,
  createWebhookSubscription,
  deleteWebhookSubscription,
  getWebhookSubscription,
  listWebhookSubscriptions,
  processEventDispatch,
  processWebhookDelivery,
  updateWebhookSubscription,
  type AppWebhookAccess,
  type WebhookFetch,
  type WebhookOwner,
} from "./index";

const ENCRYPTION_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString("base64");
const ACCESS: AppWebhookAccess = { allowedHosts: ["*.acme.example"], topics: ["order.*"], customerData: ["email"] };
const OWNER: WebhookOwner = { pluginId: "acme.erp", access: ACCESS };
const OTHER: WebhookOwner = { pluginId: "acme.other", access: ACCESS };

const ORDER = buildEventRepresentation("order", {
  id: "ord_1", orderNumber: 1, status: "pending", paymentStatus: "unpaid", fulfillmentStatus: "unfulfilled", channel: "online_store",
  salesChannelId: "sc_online_store", marketId: null, currency: "BDT", subtotalMinor: 1000, shippingMinor: 0, discountMinor: 0, taxMinor: 0,
  totalMinor: 1000, paidMinor: 0, balanceDueMinor: 1000, pricesIncludeTax: false, paymentMethod: "cod", paymentTerms: null, customerId: null, accountCustomerId: null,
  contact: { name: "Rahim", email: "rahim@buyer.test", phone: "+8801711111111" },
  requiresShipping: false, shippingMethodId: null, shippingAddress: null, billingAddress: null, fulfillmentLocationId: null, version: 1, lines: [],
  createdAt: "2026-10-19T00:00:00.000Z", updatedAt: "2026-10-19T00:00:00.000Z", deletedAt: null,
}, allProtectedData());

function installApp(sqlite: DatabaseSync, pluginId: string, status = "active"): void {
  sqlite.prepare(`INSERT INTO plugin_installations (plugin_id, version, source, bundle_sha256, manifest_json, grant_json, grant_key, status)
    VALUES (?, '1.0.0', 'upload', ?, '{}', '{}', 'grant-key', ?)`).run(pluginId, "a".repeat(64), status);
}

describe("app-owned webhook subscriptions", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  const options = (owner?: WebhookOwner) => ({ actorId: null, encryptionKey: ENCRYPTION_KEY, owner });

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    installApp(sqlite, "acme.erp");
    installApp(sqlite, "acme.other");
  });
  afterEach(() => sqlite.close());

  it("reaches only the app's own subscriptions; staff see every one with its owner", async () => {
    const { subscription: mine } = await createWebhookSubscription(db, { url: "https://hooks.acme.example/a", topics: ["order.created"] }, options(OWNER));
    const { subscription: theirs } = await createWebhookSubscription(db, { url: "https://hooks.acme.example/b", topics: ["order.created"] }, options(OTHER));
    const { subscription: store } = await createWebhookSubscription(db, { url: "https://store.example.com/hook", topics: ["*"] }, options());
    expect(mine.appId).toBe("acme.erp");
    expect(store.appId).toBeNull();
    expect((await listWebhookSubscriptions(db, OWNER)).map((row) => row.id)).toEqual([mine.id]);
    expect((await listWebhookSubscriptions(db)).map((row) => row.id).sort()).toEqual([mine.id, theirs.id, store.id].sort());
    await expect(getWebhookSubscription(db, theirs.id, OWNER)).rejects.toThrow("Webhook not found");
    await expect(updateWebhookSubscription(db, store.id, { expectedVersion: 1, status: "disabled" }, OWNER)).rejects.toThrow("Webhook not found");
    await expect(deleteWebhookSubscription(db, theirs.id, OWNER, 1)).rejects.toThrow("Webhook not found");
    await expect(deleteWebhookSubscription(db, mine.id, OWNER, 2)).rejects.toMatchObject({ status: 409 });
    await deleteWebhookSubscription(db, mine.id, OWNER, 1);
    expect(await listWebhookSubscriptions(db, OWNER)).toEqual([]);
  });

  it("refuses endpoints outside the app's grant: hosts, topics and customer data", async () => {
    const create = (input: { url: string; topics: string[]; customerData?: string[] }) => createWebhookSubscription(db, input, options(OWNER));
    await expect(create({ url: "https://evil.example.com/x", topics: ["order.created"] })).rejects.toThrow(/approved hosts/);
    await expect(create({ url: "https://hooks.acme.example/x", topics: ["customer.created"] })).rejects.toThrow(/does not cover customer.created/);
    await expect(create({ url: "https://hooks.acme.example/x", topics: ["*"] })).rejects.toThrow(/does not cover/);
    await expect(create({ url: "https://hooks.acme.example/x", topics: ["order.*"], customerData: ["phone"] })).rejects.toThrow(/phone/);
    const { subscription } = await create({ url: "https://hooks.acme.example/x", topics: ["order.*"], customerData: ["email"] });
    await expect(updateWebhookSubscription(db, subscription.id, { expectedVersion: 1, url: "https://evil.example.com/y" }, OWNER))
      .rejects.toThrow(/approved hosts/);
  });

  it(`keeps an app to ${MAX_APP_WEBHOOK_SUBSCRIPTIONS} subscriptions`, async () => {
    for (let index = 0; index < MAX_APP_WEBHOOK_SUBSCRIPTIONS; index += 1) {
      await createWebhookSubscription(db, { url: `https://hooks.acme.example/${index}`, topics: ["order.created"] }, options(OWNER));
    }
    await expect(createWebhookSubscription(db, { url: "https://hooks.acme.example/extra", topics: ["order.created"] }, options(OWNER)))
      .rejects.toThrow(/at most 5/);
    await createWebhookSubscription(db, { url: "https://hooks.acme.example/other", topics: ["order.created"] }, options(OTHER));
  });

  async function appDelivery() {
    await createWebhookSubscription(db, { url: "https://hooks.acme.example/orders", topics: ["order.created"], customerData: ["email"] }, options(OWNER));
    sqlite.prepare(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status)
      VALUES ('ord_1', 'Rahim', '+8801711111111', 'House 1', 'city_1', 'zone_1', 'pending')`).run();
    const event = sqlite.prepare("SELECT id FROM event_outbox WHERE topic = 'order.created'").get() as { id: string };
    await processEventDispatch({ db, eventId: event.id, targets: EVENT_FAN_OUT_TARGETS });
    return (sqlite.prepare("SELECT id FROM webhook_event_deliveries").all() as Array<{ id: string }>).map((row) => row.id);
  }

  it("delivers within the live grant: its customer data, and nothing once the grant drops the topic", async () => {
    const [deliveryId] = await appDelivery();
    let body = "";
    const fetchMock: WebhookFetch = async (_url, init) => {
      body = init.body as string;
      return new Response("ok", { status: 200 });
    };
    const resolveRepresentation = vi.fn(async () => ORDER);
    const outcome = await processWebhookDelivery({
      db, deliveryId: deliveryId!, encryptionKey: ENCRYPTION_KEY, resolveRepresentation, fetch: fetchMock,
      appAccess: async () => ({ ...ACCESS, customerData: [] }),
    });
    expect(outcome.status).toBe("succeeded");
    // The subscription asked for email, but the app's grant no longer reveals it.
    expect(JSON.parse(body).data.contact).toMatchObject({ email: null, phone: null });

    sqlite.exec("UPDATE webhook_event_deliveries SET status = 'pending', next_attempt_at = 0");
    const refused = await processWebhookDelivery({
      db, deliveryId: deliveryId!, encryptionKey: ENCRYPTION_KEY, resolveRepresentation, fetch: fetchMock,
      appAccess: async () => ({ ...ACCESS, topics: ["product.*"] }),
    });
    expect(refused.status).toBe("cancelled");
    expect(sqlite.prepare("SELECT last_error FROM webhook_event_deliveries").get()).toEqual({ last_error: "app_topic_not_granted" });
  });

  it("cancels an app's delivery when nobody checked its grant or the app is inactive, and fans out only to active apps", async () => {
    const [deliveryId] = await appDelivery();
    const fetchMock = vi.fn<WebhookFetch>(async () => new Response("ok", { status: 200 }));
    const outcome = await processWebhookDelivery({
      db, deliveryId: deliveryId!, encryptionKey: ENCRYPTION_KEY, resolveRepresentation: async () => ORDER, fetch: fetchMock,
    });
    expect(outcome.status).toBe("cancelled");
    expect(fetchMock).not.toHaveBeenCalled();

    sqlite.exec("DELETE FROM webhook_event_deliveries; DELETE FROM event_outbox; UPDATE plugin_installations SET status = 'disabled' WHERE plugin_id = 'acme.erp'");
    sqlite.prepare(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status)
      VALUES ('ord_2', 'Karim', '+8801711111112', 'House 2', 'city_1', 'zone_1', 'pending')`).run();
    const event = sqlite.prepare("SELECT id FROM event_outbox WHERE topic = 'order.created'").get() as { id: string };
    await processEventDispatch({ db, eventId: event.id, targets: EVENT_FAN_OUT_TARGETS });
    expect(sqlite.prepare("SELECT count(*) AS n FROM webhook_event_deliveries").get()).toEqual({ n: 0 });
  });
});
