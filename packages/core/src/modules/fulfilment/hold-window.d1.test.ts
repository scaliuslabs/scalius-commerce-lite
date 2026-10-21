// An app's hold and automatic fulfilment serialise (audit I2): an order paid
// at commit waits for the apps that may hold it to see `order.created`, and a
// hold that commits while a run is handing over stops that run's batch.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { placeAppOrderHolds, releaseOrderHold } from "../orders/holds";
import { autoFulfilOrder } from "./auto-fulfil";
import { AUTO_FULFIL_HOLD_WINDOW_SECONDS } from "./hold-window";
import { FULFILLER_REGISTRY, type FulfillerRegistry } from "./registry";

let sqlite: DatabaseSync;
let db: Database;
let handedOver: number;

const registry = (prepare?: () => Promise<void>): FulfillerRegistry => ({
  ...FULFILLER_REGISTRY,
  digital: { mode: "auto", fulfiller: { prepare: async () => { handedOver += 1; await prepare?.(); return []; } } },
});
const fulfilments = (orderId: string) =>
  (sqlite.prepare("SELECT count(*) AS n FROM order_fulfillments WHERE order_id = ?").get(orderId) as { n: number }).n;
const now = () => Math.floor(Date.now() / 1000);

function paidDigitalOrder(id: string, placedAt = now()) {
  sqlite.exec(`
    INSERT OR IGNORE INTO products (id, name, slug, price_minor, is_active) VALUES ('p_dig', 'Gift code', 'gift-code', 50000, 1);
    INSERT OR IGNORE INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory, fulfillment_kind)
    VALUES ('v_dig', 'p_dig', 'CODE', 50000, 0, 1, 0, 'digital');
    INSERT INTO orders (id, customer_name, customer_phone, requires_shipping, currency_code, currency_decimal_places,
      subtotal_amount_minor, total_amount_minor, status, payment_method, payment_status, paid_amount_minor, balance_due_minor,
      fulfillment_status, inventory_pool, inventory_action, version, created_at)
    VALUES ('${id}', 'Buyer', '+8801700000000', 0, 'BDT', 2, 50000, 50000, 'pending', 'gift_card', 'paid', 50000, 0,
      'pending', 'regular', 'none', 1, ${placedAt});
    INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, product_name, inventory_tracked,
      unit_price_minor, line_subtotal_minor, discount_amount_minor, taxable_amount_minor, tax_amount_minor, fulfillment_type)
    VALUES ('i_${id}', '${id}', 'p_dig', 'v_dig', 1, 'Gift code', 0, 50000, 50000, 0, 0, 0, 'digital');
    INSERT INTO event_outbox (id, topic, resource_type, resource_id, data, occurred_at)
    VALUES ('evt_${id}', 'order.created', 'order', '${id}', '{}', ${placedAt});
  `);
}

function app(pluginId: string, scopes: string[], activatedAt = now() - 3600) {
  const grant = JSON.stringify({ scopes, events: ["order.*"] });
  sqlite.prepare(`INSERT INTO plugin_installations (plugin_id, version, source, bundle_sha256, manifest_json, grant_json, grant_key, status, activated_at)
    VALUES (?, '1.0.0', 'upload', ?, '{}', ?, 'k', 'active', ?)`).run(pluginId, "a".repeat(64), grant, activatedAt);
}

function delivery(pluginId: string, orderId: string, status: string) {
  const id = `pld_${String(Date.now()).padStart(13, "0")}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  sqlite.prepare(`INSERT INTO plugin_event_deliveries (id, plugin_id, event_id, topic, resource_type, resource_id, status)
    VALUES (?, ?, ?, 'order.created', 'order', ?, ?)`).run(id, pluginId, `evt_${orderId}`, orderId, status);
  return id;
}

beforeEach(() => {
  ({ sqlite, db } = createSqliteD1Database());
  handedOver = 0;
});
afterEach(() => sqlite.close());

describe("an app's hold and automatic fulfilment", () => {
  it("waits for a risk app's order.created before handing over, and its hold then wins", async () => {
    app("acme.risk", ["read_orders", "write_orders"]);
    paidDigitalOrder("o_fraud");
    // The checkout's own run: the app has not been sent the order yet.
    expect(await autoFulfilOrder(db, "o_fraud", registry())).toMatchObject({ skipped: "hold_window", fulfilledTypes: [] });
    const pending = delivery("acme.risk", "o_fraud", "pending");
    expect(await autoFulfilOrder(db, "o_fraud", registry())).toMatchObject({ skipped: "hold_window" });

    // The app's handler holds the order, then its delivery succeeds.
    await placeAppOrderHolds(db, "o_fraud", [{ pluginId: "acme.risk", appName: "Acme Risk", reasons: ["Card country mismatch"] }]);
    sqlite.prepare("UPDATE plugin_event_deliveries SET status = 'succeeded' WHERE id = ?").run(pending);
    expect(await autoFulfilOrder(db, "o_fraud", registry())).toMatchObject({ skipped: "on_hold", fulfilledTypes: [] });
    expect({ handedOver, fulfilments: fulfilments("o_fraud") }).toEqual({ handedOver: 0, fulfilments: 0 });

    // Staff release it: the code goes out.
    const hold = sqlite.prepare("SELECT id FROM order_holds WHERE order_id = 'o_fraud'").get() as { id: string };
    await releaseOrderHold(db, "o_fraud", hold.id, null);
    expect(await autoFulfilOrder(db, "o_fraud", registry())).toMatchObject({ fulfilledTypes: ["digital"], delivered: true });
  });

  it("hands over once every app that may hold has had its delivery, and never waits past the window", async () => {
    app("acme.risk", ["write_orders"]);
    app("acme.analytics", ["read_orders"]);
    paidDigitalOrder("o_clean");
    delivery("acme.risk", "o_clean", "succeeded");
    // An app without write_orders cannot hold: it is not waited for.
    expect(await autoFulfilOrder(db, "o_clean", registry())).toMatchObject({ fulfilledTypes: ["digital"] });

    // A failing app delays the order at most the window after it was placed.
    paidDigitalOrder("o_late", now() - AUTO_FULFIL_HOLD_WINDOW_SECONDS - 1);
    delivery("acme.risk", "o_late", "failed");
    expect(await autoFulfilOrder(db, "o_late", registry())).toMatchObject({ fulfilledTypes: ["digital"] });

    // An app activated after the order was placed never sees it.
    sqlite.exec("DELETE FROM plugin_installations");
    app("acme.new", ["write_orders"], now() + 60);
    paidDigitalOrder("o_before");
    expect(await autoFulfilOrder(db, "o_before", registry())).toMatchObject({ fulfilledTypes: ["digital"] });
  });

  it("lets a hold that commits during the run stop its handover (the batch guard)", async () => {
    paidDigitalOrder("o_race");
    // The app's hold lands after the run checked for holds and before its batch commits.
    const racing = registry(() => placeAppOrderHolds(db, "o_race", [{ pluginId: "acme.risk", appName: "Acme Risk", reasons: ["Velocity"] }]));
    expect(await autoFulfilOrder(db, "o_race", racing)).toMatchObject({ skipped: "on_hold", fulfilledTypes: [], delivered: false });
    expect(fulfilments("o_race")).toBe(0);
    expect(sqlite.prepare("SELECT fulfilled_quantity AS q, (SELECT status FROM orders WHERE id = 'o_race') AS status FROM order_items WHERE id = 'i_o_race'").get())
      .toEqual({ q: 0, status: "pending" });
  });
});
