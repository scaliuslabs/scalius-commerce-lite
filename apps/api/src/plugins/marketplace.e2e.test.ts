// The marketplace splitter (`acme.marketplace`) end to end on the migrated
// schema: an order of two sellers' products is placed through the stable app
// API, staff hand over one seller's line and refund the other's, and the
// events the platform's triggers wrote are delivered to the app as they are.
// The split moves per line, from the facts alone: seller A is fulfilled and
// owed, seller B refunded, and nothing one seller's line did touches the
// other's payout (audit insight F3).
import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bundled.gen", async (importOriginal) => (await import("./testing/fixture-apps")).withFixtureApps(await importOriginal()));
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { activatePlugin, installPlugin, requirePluginInstallation } from "@scalius/core/modules/plugins";
import { getObjectRecord, putObjectRecord } from "@scalius/core/modules/objects";
import { parseEventFacts, type EventTopic } from "@scalius/shared/events";
import { errorResponseFromError } from "../utils/api-response";
import { idempotentReplay } from "../routes/admin/idempotency";
import { adminResourceRoutes } from "../routes/admin/resources";
import { adminResourceRefundRoutes } from "../routes/admin/resources-refunds";
import { BUNDLED_PLUGINS } from "./bundled.gen";
import { pluginEventEnvelope } from "./event-delivery";
import { PluginHost } from "./host";
import { pluginTestCtx, pluginTestEnv } from "./testing/fixtures";
import { manifest, payableMinor, type Split } from "./testing/apps/marketplace/src/index";

describe("acme.marketplace end to end", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let env: Env;

  async function call(method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}) {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    app.use("*", async (c, next) => {
      c.set("db", db as never);
      c.set("user", { id: "owner", name: "Owner", email: "owner@shop.test" } as never);
      await next();
    });
    app.use("*", idempotentReplay);
    app.route("/resources", adminResourceRoutes);
    app.route("/resources", adminResourceRefundRoutes);
    app.onError((error, c) => { const { body, status } = errorResponseFromError(error); return c.json(body, status); });
    const response = await app.request(`/api/v1/admin${path}`, {
      method,
      headers: { ...(options.body === undefined ? {} : { "content-type": "application/json" }), ...options.headers },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }, env);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions inspect the wire envelope.
    return { status: response.status, body: await response.json() as { data: any; error: { code: string; message: string } } };
  }

  /** Delivers every event still in the outbox to the app, oldest first, as the dispatcher would; each twice (a redelivery). */
  async function deliverAll(): Promise<EventTopic[]> {
    const rows = sqlite.prepare("SELECT id, topic, resource_type, resource_id, data, occurred_at FROM event_outbox WHERE status = 'pending' ORDER BY rowid").all() as Array<{
      id: string; topic: EventTopic; resource_type: string; resource_id: string; data: string; occurred_at: number;
    }>;
    const host = new PluginHost({ env, ctx: pluginTestCtx(), db });
    const installation = await requirePluginInstallation(db, manifest.id);
    const delivered: EventTopic[] = [];
    for (const row of rows) {
      const facts = parseEventFacts(row.topic, row.data);
      expect(facts, `${row.topic} ${row.data}`).not.toBeNull();
      sqlite.prepare("UPDATE event_outbox SET status = 'dispatched' WHERE id = ?").run(row.id);
      if (!(manifest.events as readonly string[]).includes(row.topic)) continue;
      const envelope = pluginEventEnvelope({ id: row.id, topic: row.topic, resourceType: row.resource_type as never, resourceId: row.resource_id, facts: facts as never, occurredAt: row.occurred_at });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(await host.invokeEvent(installation, envelope)).toEqual({ ok: true, value: null, error: null });
      }
      delivered.push(row.topic);
    }
    return delivered;
  }

  const split = async (orderId: string, sellerId: string) =>
    await getObjectRecord(db, manifest.id, "splits", `${orderId}:${sellerId}`) as Split | null;

  beforeEach(async () => {
    let binding: D1Database;
    ({ sqlite, db, binding } = createSqliteD1Database());
    env = pluginTestEnv(binding);
    sqlite.exec(`
      INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1);
      INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active)
        VALUES ('city_1', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1), ('zone_1', 'North', 'BD', 2, 'city_1', '{}', '{}', 1);
      INSERT INTO customers (id, name, email, phone) VALUES ('cust_buyer', 'Buyer', 'buyer@example.test', '+8801711000009');
      INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('p_lamp', 'Lamp', 'lamp', 150000, 1), ('p_rug', 'Rug', 'rug', 90000, 1);
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory, fulfillment_kind)
        VALUES ('v_lamp', 'p_lamp', 'LAMP-1', 150000, 20, 0, 1, 1, 'physical'), ('v_rug', 'p_rug', 'RUG-1', 90000, 20, 0, 1, 1, 'physical');
    `);
    const installed = await installPlugin(db, { manifest, source: "bundled", bundleSha256: BUNDLED_PLUGINS[manifest.id]!.sha256, actorUserId: "owner" });
    await activatePlugin(db, manifest.id, { actorUserId: "owner", expectedRevision: installed.revision });
    const installation = await requirePluginInstallation(db, manifest.id);
    const listings = installation.manifest.objects!.listings!;
    await putObjectRecord(db, manifest.id, "listings", listings as never, "p_lamp", { seller_id: "seller_a" });
    await putObjectRecord(db, manifest.id, "listings", listings as never, "p_rug", { seller_id: "seller_b" });
  });
  afterEach(() => sqlite.close());

  it("splits an order per seller and moves each seller's units from the fulfilment and refund line facts", async () => {
    const placed = await call("POST", "/resources/orders", {
      headers: { "Idempotency-Key": "marketplace order 0001" },
      body: {
        customerId: "cust_buyer",
        items: [{ productId: "p_lamp", variantId: "v_lamp", quantity: 2 }, { productId: "p_rug", variantId: "v_rug", quantity: 1 }],
        shippingAddress: { countryCode: "BD", line1: "House 1, Road 2", placeIds: { city: "city_1", zone: "zone_1" } },
        shippingMinor: 0,
        paymentMethod: "cod",
      },
    });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const order = placed.body.data.order as { id: string; lines: Array<{ id: string; productId: string }> };
    const lamp = order.lines.find((line) => line.productId === "p_lamp")!.id;
    const rug = order.lines.find((line) => line.productId === "p_rug")!.id;
    expect(await deliverAll()).toContain("order.created");
    expect(await split(order.id, "seller_a")).toMatchObject({ seller_id: "seller_a", lines: { [lamp]: { ordered: 2, fulfilled: 0, refunded: 0 } } });
    expect(await split(order.id, "seller_b")).toMatchObject({ seller_id: "seller_b", lines: { [rug]: { ordered: 1, fulfilled: 0, refunded: 0 } } });

    // Seller A ships one lamp: only their split moves, by the fulfilment's lines.
    const shipped = await call("POST", `/resources/orders/${order.id}/fulfillments`, {
      headers: { "Idempotency-Key": "marketplace ship 0001" },
      body: { kind: "ship", lines: [{ orderItemId: lamp, quantity: 1 }] },
    });
    expect(shipped.status, JSON.stringify(shipped.body)).toBe(201);
    expect(await deliverAll()).toEqual(["fulfillment.created"]);
    expect((await split(order.id, "seller_a"))!.lines[lamp]).toMatchObject({ fulfilled: 1, refunded: 0 });
    expect((await split(order.id, "seller_b"))!.lines[rug]).toMatchObject({ fulfilled: 0, refunded: 0 });

    // The buyer paid cash on delivery; the rug is refunded with its line.
    sqlite.prepare(`INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status, cod_collected_by)
      VALUES ('pay_cod', ?, (SELECT total_amount_minor FROM orders WHERE id = ?), 'BDT', 'cod', 'full', 'succeeded', 'Rider')`).run(order.id, order.id);
    sqlite.prepare("UPDATE orders SET paid_amount_minor = total_amount_minor, balance_due_minor = 0, payment_status = 'paid' WHERE id = ?").run(order.id);
    const refund = await call("POST", `/resources/orders/${order.id}/refunds`, {
      headers: { "Idempotency-Key": "marketplace refund 0001" },
      body: { amountMinor: 90000, reason: "Rug arrived torn", manualSettlementConfirmed: true, lines: [{ orderItemId: rug, quantity: 1 }] },
    });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    expect(refund.body.data.refund).toMatchObject({ orderId: order.id, status: "refunded", amountMinor: 90000, currency: "BDT", lines: [{ orderItemId: rug, variantId: "v_rug", quantity: 1 }] });
    expect(await deliverAll()).toEqual(["refund.updated"]);
    const sellerA = (await split(order.id, "seller_a"))!;
    const sellerB = (await split(order.id, "seller_b"))!;
    expect(sellerB.lines[rug]).toMatchObject({ refunded: 1 });
    expect(sellerA.lines[lamp]).toMatchObject({ fulfilled: 1, refunded: 0 });
    expect(payableMinor(sellerA)).toBe(150000);
    expect(payableMinor(sellerB)).toBe(0);

    // The refunds read back as the event's resource.
    const listed = await call("GET", `/resources/orders/${order.id}/refunds`);
    expect(listed.body.data.refunds).toEqual([refund.body.data.refund]);
  });
});
