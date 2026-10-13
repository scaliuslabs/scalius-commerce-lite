// The Bangladesh pack's couriers end to end through the platform (bundled
// loader, migrated schema, the Worker's own routes): a store with Pathao and
// Steadfast set up from the pack.
//
// - Until the pack is active, its courier rows read as blocked with the pack's
//   reason, nothing books and the courier webhook route finds no courier.
// - Then the couriers' URLs (/webhooks/couriers/{provider}) reach the pack's
//   `verifyWebhook`: Pathao's integration check gets its secret header, a
//   status is applied once, Steadfast binds a booking recovered by invoice
//   and keeps its notes.
// - Bulk booking books once (a second run posts nothing), with Pathao's
//   place ids read from the store's places, and an address without them is
//   refused before a shipment row is written.
import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import * as schema from "@scalius/database/schema";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { getDeliveryProviderReadiness } from "@scalius/core/modules/delivery";
import { bulkShipOrders } from "@scalius/core/modules/fulfilment";
import { requirePluginInstallation, writePluginSettings } from "@scalius/core/modules/plugins";
import { BUNDLED_PLUGINS } from "./bundled.gen";
import { activatePluginWithHooks } from "./lifecycle";
import { loadCourierProviders } from "./providers/courier";
import { createAppProviderRuntime } from "./providers/runtime";
import { pluginTestCtx, pluginTestEnv } from "./testing/fixtures";
import { errorResponseFromError } from "../utils/api-response";
import { courierWebhookRoutes } from "../routes/webhooks/couriers";
import { installPlugin } from "@scalius/core/modules/plugins";
import { manifest as packManifest } from "../../../../plugins/bangladesh/src/index";

const PACK = "scalius.bangladesh";
const KEY = Buffer.alloc(32, 7).toString("base64");
const PATHAO_SECRET = "pathao-client-secret-5521";
const PATHAO_HOOK = "pathao-webhook-secret-7713";
const STEADFAST_SECRET = "steadfast-secret-key-8812";

describe("the Bangladesh pack's couriers", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let env: Env;
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let orderPosts = 0;

  beforeEach(async () => {
    let binding: D1Database;
    ({ sqlite, db, binding } = createSqliteD1Database());
    env = pluginTestEnv(binding, { CREDENTIAL_ENCRYPTION_KEY: KEY });
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
    // Both couriers as the store set them up: the rows carry no keys.
    await db.insert(schema.deliveryProviders).values([
      { id: "dp_pathao", name: "Pathao", type: `${PACK}:pathao`, isActive: true, credentials: "{}", config: "{}" },
      { id: "dp_steadfast", name: "Steadfast", type: `${PACK}:steadfast`, isActive: true, credentials: "{}", config: "{}" },
    ]);
    await db.insert(schema.places).values([
      { id: "city_dhaka", name: "Dhaka", countryCode: "BD", level: 1, externalIds: '{"pathao":"1"}', metadata: "{}" },
      { id: "zone_gulshan", name: "Gulshan", countryCode: "BD", level: 2, parentId: "city_dhaka", externalIds: '{"pathao":"52"}', metadata: "{}" },
      { id: "zone_unmapped", name: "Nowhere", countryCode: "BD", level: 2, parentId: "city_dhaka", externalIds: "{}", metadata: "{}" },
    ]);
    const order = (id: string, status: string, zone = "zone_gulshan") => ({
      id, customerName: "Buyer", customerPhone: "+8801712345678", shippingAddress: "House 1, Road 2", city: "city_dhaka", zone,
      totalAmountMinor: 16_000, subtotalAmountMinor: 16_000, balanceDueMinor: 16_000, currencyCode: "BDT", currencyDecimalPlaces: 2,
      status, paymentMethod: "cod", paymentStatus: "unpaid",
    });
    for (const values of [order("ORD-OLD", "shipped"), order("ORD-REC", "shipped"), order("ORD-NEW", "confirmed"), order("ORD-NOZONE", "confirmed", "zone_unmapped")]) {
      await db.insert(schema.orders).values(values);
    }
    // Shipments booked earlier: one tracked by its id, one Steadfast booking recovered by lookup without its id.
    await db.insert(schema.deliveryShipments).values([
      { id: "shp_old", orderId: "ORD-OLD", providerId: "dp_pathao", providerType: `${PACK}:pathao`, externalId: "DL1001", trackingId: "DL1001", trackingUrl: "https://merchant.pathao.com/tracking?consignment_id=DL1001", status: "in_transit", rawStatus: "In Transit", metadata: "{}" },
      {
        id: "shp_rec", orderId: "ORD-REC", providerId: "dp_steadfast", providerType: `${PACK}:steadfast`, externalId: null, trackingId: null, status: "pending", rawStatus: "in_review",
        metadata: JSON.stringify({ unknownOutcomeResolution: { outcome: "confirmed_existing" } }),
      },
    ]);
    const installed = await installPlugin(db, { manifest: packManifest, source: "bundled", bundleSha256: BUNDLED_PLUGINS[PACK]!.sha256, actorUserId: "owner" });
    await writePluginSettings(db, PACK, {
      pathao_base_url: "https://api-hermes.pathao.com", pathao_client_id: "pathao-client-4821", pathao_client_secret: PATHAO_SECRET,
      pathao_username: "merchant@shop.test", pathao_password: "pathao-password-9931", pathao_webhook_secret: PATHAO_HOOK,
      pathao_store_id: "924", pathao_delivery_type: "48", pathao_item_type: "2", pathao_item_weight: 0.5,
      steadfast_base_url: "https://portal.packzy.com/api/v1", steadfast_api_key: "steadfast-api-3391", steadfast_secret_key: STEADFAST_SECRET,
    }, { expectedRevision: installed.revision, credentialEncryptionKey: KEY });
    requests.length = 0;
    orderPosts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      requests.push({ url, init: init ?? {} });
      if (url.endsWith("/aladdin/api/v1/issue-token")) return Response.json({ access_token: "token" });
      if (url.endsWith("/aladdin/api/v1/orders")) {
        orderPosts += 1;
        return Response.json({ code: 200, data: { consignment_id: "DL2002", order_status: "Pending", delivery_fee: 60 } });
      }
      return new Response("unexpected", { status: 599 });
    }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    sqlite.close();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const couriers = () => loadCourierProviders(createAppProviderRuntime({ env, db, ctx: pluginTestCtx() }));
  const activate = async () => {
    const current = await requirePluginInstallation(db, PACK);
    const { pluginGrantKey, pluginGrantRequest } = await import("@scalius/shared/plugins/manifest");
    return activatePluginWithHooks({ db, env, ctx: pluginTestCtx() }, PACK, {
      actorUserId: "owner",
      expectedRevision: current.revision,
      expectedGrantKey: pluginGrantKey(pluginGrantRequest(current.manifest)),
    });
  };
  function webhookApp() {
    const app = new OpenAPIHono<{ Bindings: Env }>();
    app.onError((error, c) => c.json(errorResponseFromError(error).body, errorResponseFromError(error).status));
    app.use("*", async (c, next) => {
      c.set("db", db);
      await next();
    });
    app.route("/webhooks/couriers", courierWebhookRoutes);
    return app;
  }
  const push = (path: string, body: unknown, headers: Record<string, string>) =>
    webhookApp().request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }, env, pluginTestCtx());
  const row = (sql: string, ...params: string[]) => sqlite.prepare(sql).get(...params) as Record<string, unknown>;
  const rows = (sql: string, ...params: string[]) => sqlite.prepare(sql).all(...params) as Array<Record<string, unknown>>;

  it("fails closed until activation, then serves the couriers' webhook URLs and books once", { timeout: 60_000 }, async () => {
    const PATHAO = `${PACK}:pathao`;
    const STEADFAST = `${PACK}:steadfast`;
    // Before activation: blocked with the pack's reason; nothing books; the webhook route finds no courier.
    const pathaoRow = (await db.select().from(schema.deliveryProviders).all()).find((provider) => provider.id === "dp_pathao")!;
    await expect(getDeliveryProviderReadiness(pathaoRow, KEY, couriers)).resolves.toMatchObject({ active: false });
    expect((await bulkShipOrders(db, ["ORD-NEW"], "dp_pathao", {}, KEY, couriers))[0]).toMatchObject({ success: false });
    const early = await push(`/webhooks/couriers/${PATHAO}`, { event: "order.delivered", consignment_id: "DL1001" }, { "x-pathao-signature": PATHAO_HOOK });
    expect(early.status).toBe(404);
    expect(requests).toEqual([]);
    expect(rows("SELECT id FROM delivery_shipments")).toHaveLength(2);

    expect((await activate()).hookError).toBeNull();
    const installation = await requirePluginInstallation(db, PACK);
    for (const key of ["pathao_client_secret", "pathao_password", "pathao_webhook_secret", "steadfast_api_key", "steadfast_secret_key"]) {
      expect(String(installation.storedSettings[key]), key).toMatch(/^ps1:/);
    }
    const stored = JSON.stringify(row("SELECT settings_json FROM plugin_installations WHERE plugin_id = ?", PACK));
    for (const secret of [PATHAO_SECRET, PATHAO_HOOK, STEADFAST_SECRET, "pathao-password-9931"]) expect(stored).not.toContain(secret);

    // Pathao's webhook URL: its integration check, a status applied once, a forged push refused.
    const check = await push(`/webhooks/couriers/${PATHAO}`, { event: "webhook_integration" }, { "x-pathao-signature": PATHAO_HOOK });
    expect(check.status).toBe(202);
    expect(check.headers.get("x-pathao-merchant-webhook-integration-secret")).toBe(PATHAO_HOOK);
    expect(await check.json()).toEqual({ success: true, message: "Webhook integration verified" });
    expect((await push(`/webhooks/couriers/${PATHAO}`, { event: "order.delivered", consignment_id: "DL1001" }, { "x-pathao-signature": "forged" })).status).toBe(401);
    const delivered = await push(`/webhooks/couriers/${PATHAO}`, { event: "order.delivered", consignment_id: "DL1001", collected_amount: 160 }, { "x-pathao-signature": PATHAO_HOOK });
    expect([delivered.status, await delivered.json()]).toEqual([202, { success: true, status: "delivered" }]);
    expect(row("SELECT status, raw_status, metadata FROM delivery_shipments WHERE id = 'shp_old'")).toMatchObject({ status: "delivered", raw_status: "order.delivered" });
    expect(JSON.parse(String(row("SELECT metadata FROM delivery_shipments WHERE id = 'shp_old'").metadata))).toMatchObject({ collectedAmount: 160 });
    expect(row("SELECT status FROM orders WHERE id = 'ORD-OLD'")).toEqual({ status: "delivered" });
    const again = await push(`/webhooks/couriers/${PATHAO}`, { event: "order.delivered", consignment_id: "DL1001" }, { "x-pathao-signature": PATHAO_HOOK });
    expect(again.status).toBe(202);
    expect(rows("SELECT provider, event_type FROM webhook_events")).toEqual([{ provider: `${PACK}:pathao`, event_type: "courier.delivered" }]);
    // Steadfast's webhook URL: the recovered booking is bound by its invoice; a note is kept; another order's consignment is refused.
    const bearer = { authorization: `Bearer ${STEADFAST_SECRET}` };
    const status = await push(`/webhooks/couriers/${STEADFAST}`, { notification_type: "delivery_status", consignment_id: 777, invoice: "ORD-REC", status: "delivered", cod_amount: 160 }, bearer);
    expect([status.status, await status.json()]).toEqual([200, { status: "success", message: "Webhook received successfully." }]);
    expect(row("SELECT external_id, status FROM delivery_shipments WHERE id = 'shp_rec'")).toEqual({ external_id: "777", status: "delivered" });
    await push(`/webhooks/couriers/${STEADFAST}`, { notification_type: "tracking_update", consignment_id: 777, invoice: "ORD-REC", tracking_message: "Handed to buyer", updated_at: "2026-10-07 10:00:00" }, bearer);
    expect(JSON.parse(String(row("SELECT metadata FROM delivery_shipments WHERE id = 'shp_rec'").metadata))).toMatchObject({ lastTrackingMessage: "Handed to buyer", codAmount: 160 });
    const conflict = await push(`/webhooks/couriers/${STEADFAST}`, { notification_type: "delivery_status", consignment_id: 777, invoice: "ORD-OLD", status: "cancelled" }, bearer);
    expect(conflict.status).toBe(200);
    expect(row("SELECT status FROM delivery_shipments WHERE id = 'shp_rec'")).toEqual({ status: "delivered" });
    expect((await push(`/webhooks/couriers/${STEADFAST}`, { notification_type: "delivery_status", consignment_id: 777, invoice: "ORD-REC", status: "delivered" }, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await push(`/webhooks/couriers/${STEADFAST}`, { notification_type: "refund" }, bearer)).status).toBe(400);

    // Booking: Pathao's place ids from the store's places; once, however often the bulk action runs.
    const [first] = await bulkShipOrders(db, ["ORD-NEW"], "dp_pathao", {}, KEY, couriers);
    expect(first).toMatchObject({ success: true });
    const [second] = await bulkShipOrders(db, ["ORD-NEW"], "dp_pathao", {}, KEY, couriers);
    expect(second).toMatchObject({ success: true });
    expect(orderPosts).toBe(1);
    const booked = JSON.parse(String(requests.find((request) => request.url.endsWith("/aladdin/api/v1/orders"))!.init.body));
    expect(booked).toMatchObject({ store_id: 924, merchant_order_id: "ORD-NEW", recipient_city: 1, recipient_zone: 52, amount_to_collect: 160, item_weight: 0.5, delivery_type: 48 });
    expect(row("SELECT provider_type, external_id, tracking_url FROM delivery_shipments WHERE order_id = 'ORD-NEW'")).toEqual({
      provider_type: `${PACK}:pathao`, external_id: "DL2002", tracking_url: "https://merchant.pathao.com/tracking?consignment_id=DL2002",
    });

    // An address without Pathao's zone id is refused before a shipment row is written.
    const [unmapped] = await bulkShipOrders(db, ["ORD-NOZONE"], "dp_pathao", {}, KEY, couriers);
    expect(unmapped).toMatchObject({ success: false, error: "Pathao requires mapped numeric location IDs before shipment creation. Missing mapping for: zone. Configure Pathao IDs in Delivery Locations settings." });
    expect(rows("SELECT id FROM delivery_shipments WHERE order_id = 'ORD-NOZONE'")).toEqual([]);
    expect(orderPosts).toBe(1);

    // Nothing the pack logged holds a key or the buyer's phone.
    const logs = JSON.stringify(rows("SELECT message, fields_json FROM plugin_log_entries WHERE plugin_id = ?", PACK));
    expect(logs).not.toMatch(/pathao-client-secret|pathao-webhook-secret|steadfast-secret-key|1712345678/);
  });
});
