// The stable app API's resources (operation-registry/README.md) on the test
// D1: reads are the sealed webhook representations, lists walk (updatedAt,
// id) by cursor, contact filters need their scope, writes take minor units,
// and a create repeated with its Idempotency-Key replays the first response.
import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { EVENT_REPRESENTATION_SCHEMAS } from "@scalius/shared/events";
import type { ProtectedCustomerData } from "@scalius/shared/plugins/protected-data";
import { errorResponseFromError } from "../../utils/api-response";
import { adminCustomerRoutes } from "./customers";
import { adminOrdersRoutes } from "./orders";
import { adminInventoryRoutes } from "./inventory";
import { idempotentReplay } from "./idempotency";
import { adminResourceRoutes } from "./resources";

let sqlite: DatabaseSync;
let db: Database;
let principal: { pluginId: string; protectedData: ReadonlySet<ProtectedCustomerData> } | null;

beforeEach(() => {
  ({ sqlite, db } = createSqliteD1Database());
  principal = null;
  sqlite.exec(`
    INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1);
    INSERT INTO orders (id, order_number, customer_name, customer_phone, customer_email, shipping_address, city, zone, status, updated_at)
      VALUES ('ord_a', 1001, 'Rahim', '+8801711111111', 'rahim@buyer.test', 'House 1', 'city_1', 'zone_1', 'pending', 100),
             ('ord_b', 1002, 'Karim', '+8801722222222', 'karim@buyer.test', 'House 2', 'city_1', 'zone_1', 'confirmed', 200),
             ('ord_c', 1003, 'Rahim', '+8801711111111', 'rahim@buyer.test', 'House 3', 'city_1', 'zone_1', 'pending', 200);
    INSERT INTO markets (id, handle, name, status) VALUES ('mkt_in', 'india', 'India', 'active');
    INSERT INTO market_countries (country_code, market_id) VALUES ('IN', 'mkt_in');
    INSERT INTO market_presences (id, market_id, kind, value, locale) VALUES ('mkp_in', 'mkt_in', 'subfolder', 'en-in', 'en');
    INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('p_tea', 'Tea', 'tea', 50000, 1);
    INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory, fulfillment_kind)
      VALUES ('v_tea', 'p_tea', 'TEA-1', 50000, 100, 0, 1, 1, 'physical');
  `);
});
afterEach(() => sqlite.close());

async function call(method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}) {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    c.set("user", { id: "owner", name: "Owner", email: "owner@shop.test" } as never);
    if (principal) c.set("pluginPrincipal", principal as never);
    await next();
  });
  app.use("*", idempotentReplay);
  app.route("/resources", adminResourceRoutes);
  app.route("/customers", adminCustomerRoutes);
  app.route("/orders", adminOrdersRoutes);
  app.route("/inventory", adminInventoryRoutes);
  app.onError((error, c) => { const { body, status } = errorResponseFromError(error); return c.json(body, status); });
  const response = await app.request(`/api/v1/admin${path}`, {
    method,
    headers: { ...(options.body === undefined ? {} : { "content-type": "application/json" }), ...options.headers },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return {
    status: response.status,
    replayed: response.headers.get("idempotent-replayed"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions inspect the wire envelope.
    body: await response.json() as { data: any; error: { code: string; message: string } },
  };
}

describe("the stable app API's resources", () => {
  it("reads an order as its webhooks carry it, money in minor units beside the currency", async () => {
    const order = await call("GET", "/resources/orders/ord_a");
    expect(order.status).toBe(200);
    expect(EVENT_REPRESENTATION_SCHEMAS.order.parse(order.body.data)).toEqual(order.body.data);
    expect(order.body.data).toMatchObject({ id: "ord_a", orderNumber: 1001, currency: "BDT", version: 1, accountCustomerId: null, contact: { email: "rahim@buyer.test" } });
    expect((await call("GET", "/resources/orders/ord_missing")).status).toBe(404);
  });

  it("walks orders by (updatedAt, id) with a cursor, from updatedSince, with exact filters", async () => {
    const first = await call("GET", "/resources/orders?limit=2");
    expect(first.body.data.orders.map((order: { id: string }) => order.id)).toEqual(["ord_a", "ord_b"]);
    const second = await call("GET", `/resources/orders?limit=2&cursor=${first.body.data.nextCursor}`);
    expect(second.body.data.orders.map((order: { id: string }) => order.id)).toEqual(["ord_c"]);
    expect(second.body.data.nextCursor).toBeNull();
    const since = await call("GET", `/resources/orders?updatedSince=${new Date(200_000).toISOString()}`);
    expect(since.body.data.orders.map((order: { id: string }) => order.id)).toEqual(["ord_b", "ord_c"]);
    expect((await call("GET", "/resources/orders?orderNumber=1002")).body.data.orders.map((order: { id: string }) => order.id)).toEqual(["ord_b"]);
    expect((await call("GET", "/resources/orders?email=RAHIM@buyer.test")).body.data.orders.map((order: { id: string }) => order.id)).toEqual(["ord_a", "ord_c"]);
    expect((await call("GET", "/resources/orders?cursor=not-a-cursor")).status).toBe(400);
  });

  it("refuses an app's contact filter without the scope that reveals it", async () => {
    principal = { pluginId: "acme.sync", protectedData: new Set(["phone"]) };
    expect((await call("GET", "/resources/orders?phone=%2B8801722222222")).body.data.orders.map((order: { id: string }) => order.id)).toEqual(["ord_b"]);
    const refused = await call("GET", "/resources/orders?email=rahim@buyer.test");
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("contact_scope_required");
    expect((await call("GET", "/resources/customers?email=rahim@buyer.test")).status).toBe(403);
  });

  it("refuses a status change made on a stale order version, changing nothing", async () => {
    const stale = await call("PUT", "/orders/ord_a/status", { body: { status: "cancelled", expectedVersion: 7 } });
    expect(stale.status).toBe(409);
    expect((sqlite.prepare("SELECT status, version FROM orders WHERE id = 'ord_a'").get() as { status: string; version: number }))
      .toEqual({ status: "pending", version: 1 });
  });

  it("sets stock under the stockVersion read and the Idempotency-Key, once", async () => {
    const { stockVersion } = (await call("GET", "/resources/variants/v_tea")).body.data as { stockVersion: number };
    const stale = await call("POST", "/inventory/stock-set", {
      body: { variantId: "v_tea", newStock: 80, expectedStockVersion: stockVersion + 5 },
      headers: { "Idempotency-Key": "stocktake 2026-10-19 aisle 4" },
    });
    expect(stale.status).toBe(409);
    const body = { variantId: "v_tea", newStock: 80, expectedStockVersion: stockVersion };
    const set = await call("POST", "/inventory/stock-set", { body, headers: { "Idempotency-Key": "stocktake 2026-10-19 aisle 5" } });
    expect(set.status).toBe(200);
    const again = await call("POST", "/inventory/stock-set", { body, headers: { "Idempotency-Key": "stocktake 2026-10-19 aisle 5" } });
    expect(again).toMatchObject({ status: 200, replayed: "true" });
    expect((await call("GET", "/resources/variants/v_tea")).body.data).toMatchObject({ onHand: 80, stockVersion: stockVersion + 1 });
    // No key, no stock move.
    expect((await call("POST", "/inventory/stock-set", { body: { variantId: "v_tea", newStock: 70 } })).status).toBe(400);
  });

  it("reads a product with its SKUs in minor units, and finds it by SKU", async () => {
    const product = await call("GET", "/resources/products/p_tea");
    expect(product.body.data).toMatchObject({ id: "p_tea", status: "active", currency: "BDT", priceMinor: 50000, imageUrl: null, variants: [{ id: "v_tea", sku: "TEA-1", priceMinor: 50000 }] });
    expect((await call("GET", "/resources/products?sku=tea-1")).body.data.products.map((entry: { id: string }) => entry.id)).toEqual(["p_tea"]);
    expect((await call("GET", "/resources/variants/v_tea")).body.data).toMatchObject({ id: "v_tea", productId: "p_tea", onHand: 100 });
  });

  it("sets price list prices in minor units of the list's currency", async () => {
    const created = await call("POST", "/resources/price-lists", { body: { name: "India", kind: "market", marketId: "mkt_in" } });
    expect(created.status).toBe(201);
    const list = created.body.data.priceList;
    expect(list).toMatchObject({ kind: "market", currency: expect.any(String), priceIncrementMinor: expect.any(Number) });
    const amountMinor = list.priceIncrementMinor * 450;
    const saved = await call("PUT", `/resources/price-lists/${list.id}/prices`, {
      body: { expectedRevision: list.revision, set: [{ variantId: "v_tea", prices: [{ amountMinor }] }] },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data.priceList.revision).toBe(list.revision + 1);
    const prices = await call("GET", `/resources/price-lists/${list.id}/prices`);
    expect(prices.body.data.items).toEqual([expect.objectContaining({
      variantId: "v_tea", baseCurrency: "BDT", basePriceMinor: 50000,
      prices: [{ currency: list.currency, amountMinor, compareAtMinor: null, minQuantity: 1 }],
    })]);
    const stale = await call("PUT", `/resources/price-lists/${list.id}/prices`, { body: { expectedRevision: list.revision, remove: ["v_tea"] } });
    expect(stale.status).toBe(409);
  });

  it("replays a create's first response for a repeated Idempotency-Key, and refuses the key for another request", async () => {
    const body = { name: "Nadia Islam", email: null, phone: "+8801733333333" };
    const first = await call("POST", "/customers", { body, headers: { "Idempotency-Key": "create-nadia-0001" } });
    expect({ status: first.status, error: first.body.error }).toEqual({ status: 201, error: undefined });
    expect(first.replayed).toBeNull();
    const again = await call("POST", "/customers", { body, headers: { "Idempotency-Key": "create-nadia-0001" } });
    expect(again).toMatchObject({ status: 201, replayed: "true" });
    expect(again.body.data.id).toBe(first.body.data.id);
    expect((sqlite.prepare("SELECT count(*) AS n FROM customers WHERE phone = '+8801733333333'").get() as { n: number }).n).toBe(1);
    const reused = await call("POST", "/customers", { body: { ...body, name: "Someone else" }, headers: { "Idempotency-Key": "create-nadia-0001" } });
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe("idempotency_key_reused");
    // Another caller's key is its own.
    principal = { pluginId: "acme.crm", protectedData: new Set() };
    expect((await call("POST", "/customers", { body, headers: { "Idempotency-Key": "create-nadia-0001" } })).replayed).toBeNull();
    expect((await call("POST", "/customers", { body, headers: { "Idempotency-Key": "short" } })).status).toBe(400);
  });
});
