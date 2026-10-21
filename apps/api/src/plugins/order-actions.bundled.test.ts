// Order risk as an event (`ctx.orders`) through the bundled loader on the
// migrated schema: the Risk guard test app's order.created handler reads the
// buyer's earlier orders, records its advice on the order (the dashboard's
// customer card reads it) and holds a risky order for staff review; a
// redelivered event adds nothing; the bridge refuses an app without the
// order scopes and an order that does not exist.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bundled.gen", async (importOriginal) => (await import("./testing/fixture-apps")).withFixtureApps(await importOriginal()));
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { activatePlugin, installPlugin } from "@scalius/core/modules/plugins";
import { assertOrderNotOnHold, getOrderDetails } from "@scalius/core/modules/orders";
import { BUNDLED_PLUGINS } from "./bundled.gen";
import { PluginBridgeHost } from "./bridge";
import { PluginHost, pluginBridgeAuthority } from "./host";
import { installHello, pluginTestCtx, pluginTestEnv } from "./testing/fixtures";
import { manifest as riskGuardManifest } from "./testing/apps/risk-guard/src/index";

describe("order risk from an event handler (ctx.orders)", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let binding: D1Database;

  beforeEach(() => {
    ({ sqlite, db, binding } = createSqliteD1Database());
    sqlite.exec(`
      INSERT INTO customers (id, name, phone) VALUES ('cust_r', 'Rahim', '+8801711111111');
      INSERT INTO orders (id, customer_id, customer_name, customer_phone, shipping_address, city, zone, status, total_amount_minor) VALUES
        ('ord_old1', 'cust_r', 'Rahim', '+8801711111111', 'House 1', 'city_1', 'zone_1', 'cancelled', 90000),
        ('ord_old2', 'cust_r', 'Rahim', '+8801711111111', 'House 1', 'city_1', 'zone_1', 'returned', 90000),
        ('ord_new', 'cust_r', 'Rahim', '+8801711111111', 'House 1', 'city_1', 'zone_1', 'confirmed', 150000);
    `);
  });
  afterEach(() => sqlite.close());

  async function installGuard() {
    sqlite.prepare("INSERT OR IGNORE INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
    const installed = await installPlugin(db, { manifest: riskGuardManifest, source: "bundled", bundleSha256: BUNDLED_PLUGINS["acme.risk-guard"]!.sha256, actorUserId: "owner" });
    return activatePlugin(db, "acme.risk-guard", { actorUserId: "owner", expectedRevision: installed.revision });
  }

  it("advises and holds a risky new order once, and the hold stops it until staff release it", async () => {
    const installation = await installGuard();
    const host = new PluginHost({ env: pluginTestEnv(binding), ctx: pluginTestCtx(), db });
    const event = {
      id: "evt_created_1",
      topic: "order.created" as const,
      apiVersion: "2026-10" as const,
      occurredAt: "2026-10-19T10:00:00.000Z",
      resource: { type: "order", id: "ord_new" },
      facts: { orderId: "ord_new", status: "confirmed", paymentStatus: "pending", channel: "online_store" },
    };
    expect(await host.invokeEvent(installation, event)).toEqual({ ok: true, value: null, error: null });
    expect(await host.invokeEvent(installation, event)).toEqual({ ok: true, value: null, error: null });
    const detail = await getOrderDetails(db, "ord_new");
    expect(detail?.appRiskChecks).toEqual([expect.objectContaining({ appId: "acme.risk-guard", appName: "Risk guard", level: "high", reasons: ["2 of 2 earlier orders were cancelled or returned."] })]);
    expect(detail?.holds).toEqual([expect.objectContaining({ appId: "acme.risk-guard", appName: "Risk guard", reason: "2 of 2 earlier orders were cancelled or returned.", releasedAt: null })]);
    await expect(assertOrderNotOnHold(db, "ord_new")).rejects.toThrow(/on hold for review/);
  });

  it("releases only the app's own hold, under the order revision, once", async () => {
    const guard = await installGuard();
    const after: Array<() => Promise<unknown>> = [];
    const runtime = { env: pluginTestEnv(binding), ctx: pluginTestCtx(), db: () => db, composedEnv: async () => pluginTestEnv(binding), afterResponse: (work: () => Promise<unknown>) => void after.push(work) };
    const bridge = new PluginBridgeHost({ pluginId: guard.pluginId, version: guard.version, authority: pluginBridgeAuthority(guard) }, runtime);
    // Nothing held yet: nothing to release.
    await expect(bridge.ordersRelease({ orderId: "ord_new", expectedRevision: 1 })).rejects.toThrow("[orders_hold_not_found]");
    await bridge.ordersHold({ orderId: "ord_new", reason: "Waiting for the buyer's manager." });
    // Another app's hold and the platform's payment review stay with staff.
    sqlite.exec(`INSERT INTO order_holds (id, order_id, plugin_id, app_name, reason) VALUES
      ('ohd_${"a".repeat(32)}', 'ord_new', 'acme.other', 'Other', 'Its own review'),
      ('ohd_${"b".repeat(32)}', 'ord_new', 'acme.risk-guard', 'Risk guard', 'Payment review')`);
    const version = () => (sqlite.prepare("SELECT version FROM orders WHERE id = 'ord_new'").get() as { version: number }).version;
    const before = version();
    await expect(bridge.ordersRelease({ orderId: "ord_new", expectedRevision: before + 5 })).rejects.toThrow("[orders_conflict]");
    await expect(bridge.ordersRelease({ orderId: "ord_new", expectedRevision: 0 })).rejects.toThrow("[orders_invalid]");
    expect(await bridge.ordersRelease({ orderId: "ord_new", expectedRevision: before })).toEqual({ revision: before + 1, replayed: false });
    expect(after).toHaveLength(1);
    // A repeat (any revision) answers the release and changes nothing.
    expect(await bridge.ordersRelease({ orderId: "ord_new", expectedRevision: before })).toEqual({ revision: before + 1, replayed: true });
    expect(version()).toBe(before + 1);
    const open = sqlite.prepare("SELECT id FROM order_holds WHERE order_id = 'ord_new' AND released_at IS NULL ORDER BY id").all() as Array<{ id: string }>;
    expect(open.map((row) => row.id)).toEqual([`ohd_${"a".repeat(32)}`, `ohd_${"b".repeat(32)}`]);
    await expect(assertOrderNotOnHold(db, "ord_new")).rejects.toThrow(/on hold for review/);
  });

  it("refuses an app without the order scopes and an order that does not exist", async () => {
    const hello = await installHello(db, sqlite);
    const runtime = { env: pluginTestEnv(binding), ctx: pluginTestCtx(), db: () => db, composedEnv: async () => pluginTestEnv(binding) };
    const helloBridge = new PluginBridgeHost({ pluginId: hello.pluginId, version: hello.version, authority: pluginBridgeAuthority(hello) }, runtime);
    await expect(helloBridge.ordersHold({ orderId: "ord_new", reason: "No." })).rejects.toThrow("[orders_not_allowed]");
    await expect(helloBridge.ordersAssessRisk({ orderId: "ord_new", level: "low", reasons: [] })).rejects.toThrow("[orders_not_allowed]");
    await expect(helloBridge.ordersRelease({ orderId: "ord_new", expectedRevision: 1 })).rejects.toThrow("[orders_not_allowed]");

    const guard = await installGuard();
    const bridge = new PluginBridgeHost({ pluginId: guard.pluginId, version: guard.version, authority: pluginBridgeAuthority(guard) }, runtime);
    await expect(bridge.ordersHold({ orderId: "ord_none", reason: "Gone" })).rejects.toThrow("[orders_not_found]");
    await expect(bridge.ordersHold({ orderId: "ord_new", reason: "" })).rejects.toThrow("[orders_invalid]");
    await expect(bridge.ordersAssessRisk({ orderId: "ord_new", level: "severe" as never, reasons: [] })).rejects.toThrow("[orders_invalid]");
    await expect(bridge.ordersAssessRisk({ orderId: "ord_new", level: "low", reasons: Array.from({ length: 6 }, () => "x") })).rejects.toThrow("[orders_invalid]");
    expect(await bridge.ordersRiskHistory("ord_new")).toEqual({ orders: 2, cancelled: 1, returnedToSender: 1 });
  });
});
