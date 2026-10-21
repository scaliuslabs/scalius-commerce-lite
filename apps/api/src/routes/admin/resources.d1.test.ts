// The stable app API's resources (operation-registry/README.md) on the test
// D1: reads are the sealed webhook representations, lists walk (updatedAt,
// id) by cursor, contact filters need their scope, writes take minor units,
// and a create repeated with its Idempotency-Key replays the first response.
import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { paymentMethodsDocument } from "@scalius/core/modules/settings";
import { autoFulfilOrder, FULFILLER_REGISTRY, type FulfillerRegistry } from "@scalius/core/modules/fulfilment";
import { APP_PAYMENT_REVIEW_REASON } from "@scalius/core/modules/orders";
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

  it("places an app's order for a customer, at a price set by hand, once per Idempotency-Key", async () => {
    sqlite.exec(`INSERT INTO customers (id, name, phone, email, origin) VALUES ('cust_b2b', 'Trader Ltd', '+8801744444444', 'buyer@trader.test', 'merchant')`);
    principal = { pluginId: "acme.b2b", protectedData: new Set() };
    const body = {
      customerId: "cust_b2b",
      items: [{ productId: "p_tea", variantId: "v_tea", quantity: 3, unitPriceMinor: 45_000 }],
      shippingAddress: { countryCode: "IN", line1: "12 MG Road", locality: "Bengaluru", adminArea: "KA", postalCode: "560001" },
      shippingMinor: 0,
    };
    const headers = { "Idempotency-Key": "renewal sub_42 2026-10" };
    const placed = await call("POST", "/resources/orders", { body, headers });
    expect({ status: placed.status, error: placed.body.error }).toEqual({ status: 201, error: undefined });
    const order = placed.body.data.order;
    expect(order).toMatchObject({ customerId: "cust_b2b", channel: "app", currency: "BDT", subtotalMinor: 135_000, lines: [{ quantity: 3, unitPriceMinor: 45_000 }] });
    expect(sqlite.prepare("SELECT kind FROM order_events WHERE order_id = ? AND kind = 'prices_set'").all(order.id)).toHaveLength(1);
    const again = await call("POST", "/resources/orders", { body, headers });
    expect(again.body.data.order.id).toBe(order.id);
    expect((sqlite.prepare("SELECT count(*) AS n FROM orders WHERE customer_id = 'cust_b2b'").get() as { n: number }).n).toBe(1);
    // Contact or a customer, and a price on the store's increment.
    expect((await call("POST", "/resources/orders", { body: { ...body, customerId: undefined } })).status).toBe(400);
    expect((await call("POST", "/resources/orders", { body: { ...body, items: [{ ...body.items[0], unitPriceMinor: 45_050 }] } })).status).toBe(400);
  });

  it("places an app's invoice order on net terms, records its payments once per key, and lists it while overdue", async () => {
    sqlite.exec(`INSERT INTO customers (id, name, phone, email, origin) VALUES ('cust_b2b', 'Trader Ltd', '+8801744444444', 'buyer@trader.test', 'merchant')`);
    principal = { pluginId: "acme.b2b", protectedData: new Set() };
    // An app may invoice only while the store offers invoices.
    await paymentMethodsDocument.write(db, {
      enabledMethods: ["cod", "net_terms"],
      defaultMethod: "cod",
      netTerms: { dueInDays: 30, customerTags: [], segmentIds: [], appsDecide: false },
    });
    const placed = await call("POST", "/resources/orders", {
      body: {
        customerId: "cust_b2b",
        items: [{ productId: "p_tea", variantId: "v_tea", quantity: 2 }],
        shippingAddress: { countryCode: "IN", line1: "12 MG Road", locality: "Bengaluru", adminArea: "KA", postalCode: "560001" },
        shippingMinor: 0,
        paymentMethod: "net_terms",
        paymentTerms: { kind: "net", days: 45 },
      },
      headers: { "Idempotency-Key": "po-7781 invoice" },
    });
    expect({ status: placed.status, error: placed.body.error }).toEqual({ status: 201, error: undefined });
    const order = placed.body.data.order;
    expect(order).toMatchObject({ paymentMethod: "net_terms", paymentStatus: "unpaid", balanceDueMinor: 100_000, paymentTerms: { kind: "net", days: 45 } });
    expect(Date.parse(order.paymentTerms.dueAt) - Date.parse(order.createdAt)).toBe(45 * 86_400_000);
    // Terms go with an invoice only.
    expect((await call("POST", "/resources/orders", { body: { customerId: "cust_b2b", items: [{ productId: "p_tea", variantId: "v_tea", quantity: 1 }], shippingAddress: { countryCode: "IN", line1: "1", locality: "B", adminArea: "KA", postalCode: "560001" }, shippingMinor: 0, paymentTerms: { kind: "net", days: 30 } } })).status).toBe(400);

    const overdue = async () => (await call("GET", "/resources/orders?overdue=true")).body.data.orders.map((row: { id: string }) => row.id);
    expect(await overdue()).toEqual([]);
    sqlite.prepare("UPDATE orders SET payment_due_at = unixepoch() - 60 WHERE id = ?").run(order.id);
    expect(await overdue()).toEqual([order.id]);

    // The key is required, and one key records one payment.
    expect((await call("POST", `/resources/orders/${order.id}/payments`, { body: { amountMinor: 40_000, via: "bank_transfer" } })).status).toBe(400);
    const record = (amountMinor: number, key: string) => call("POST", `/resources/orders/${order.id}/payments`, {
      body: { amountMinor, via: "bank_transfer", reference: "TRX-77" },
      headers: { "Idempotency-Key": key },
    });
    // The payment and its timeline line commit together: a line that cannot be
    // written leaves no payment, so the retry records both, once.
    sqlite.exec("CREATE TEMP TRIGGER fail_timeline BEFORE INSERT ON order_events BEGIN SELECT RAISE(ABORT, 'timeline down'); END");
    expect((await record(40_000, "payment po-7781 #1")).status).toBeGreaterThanOrEqual(500);
    sqlite.exec("DROP TRIGGER fail_timeline");
    expect(sqlite.prepare("SELECT count(*) AS n FROM order_payments WHERE order_id = ?").get(order.id)).toEqual({ n: 0 });
    const first = await record(40_000, "payment po-7781 #1");
    expect({ status: first.status, error: first.body.error }).toEqual({ status: 201, error: undefined });
    const lines = () => sqlite.prepare("SELECT data FROM order_events WHERE order_id = ? AND kind = 'payment_recorded'").all(order.id)
      .map((row) => JSON.parse(String((row as { data: string }).data)));
    expect(lines()).toEqual([expect.objectContaining({ amount: 400, via: "bank_transfer", reference: "TRX-77" })]);
    expect(first.body.data.payment).toMatchObject({ orderId: order.id, method: "manual", status: "succeeded", amountMinor: 40_000, currency: "BDT" });
    expect((await record(40_000, "payment po-7781 #1")).body.data.payment.id).toBe(first.body.data.payment.id);
    expect(lines()).toHaveLength(1);
    expect((await record(70_000, "payment po-7781 #2")).status).toBe(400);
    expect((await record(60_000, "payment po-7781 #3")).status).toBe(201);
    const paid = await call("GET", `/resources/orders/${order.id}`);
    expect(paid.body.data).toMatchObject({ paymentStatus: "paid", paidMinor: 100_000, balanceDueMinor: 0 });
    expect(await overdue()).toEqual([]);
    expect(sqlite.prepare("SELECT kind FROM order_events WHERE order_id = ? AND kind = 'payment_recorded'").all(order.id)).toHaveLength(2);
    // Tea ships: nothing automatic is owed, so the app's payment holds nothing.
    expect(sqlite.prepare("SELECT count(*) AS n FROM order_holds WHERE order_id = ?").get(order.id)).toEqual({ n: 0 });
  });

  // Security audit S3: an app's recorded payment moves no money, so the gift
  // cards and downloads it would settle wait for staff to confirm it.
  it("holds the downloads of an order an app marked paid until staff release the review", async () => {
    const invoice = (id: string) => sqlite.exec(`
      INSERT OR IGNORE INTO products (id, name, slug, price_minor, is_active) VALUES ('p_dig', 'E-book', 'ebook', 50000, 1);
      INSERT OR IGNORE INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory, fulfillment_kind)
      VALUES ('v_dig', 'p_dig', 'EBOOK', 50000, 0, 1, 0, 'digital');
      INSERT INTO orders (id, customer_name, customer_phone, requires_shipping, currency_code, currency_decimal_places,
        subtotal_amount_minor, total_amount_minor, status, payment_method, payment_status, paid_amount_minor, balance_due_minor,
        payment_terms_days, fulfillment_status, inventory_pool, inventory_action, version)
      VALUES ('${id}', 'Buyer', '+8801700000000', 0, 'BDT', 2, 50000, 50000, 'pending', 'net_terms', 'unpaid', 0, 50000,
        30, 'pending', 'regular', 'none', 1);
      INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, product_name, inventory_tracked,
        unit_price_minor, line_subtotal_minor, discount_amount_minor, taxable_amount_minor, tax_amount_minor, fulfillment_type)
      VALUES ('i_${id}', '${id}', 'p_dig', 'v_dig', 1, 'E-book', 0, 50000, 50000, 0, 0, 0, 'digital');
    `);
    const registry: FulfillerRegistry = { ...FULFILLER_REGISTRY, digital: { mode: "auto", fulfiller: { prepare: async () => [] } } };
    const payInFull = (id: string, key: string) => call("POST", `/resources/orders/${id}/payments`, {
      body: { amountMinor: 50_000, via: "bank_transfer" },
      headers: { "Idempotency-Key": key },
    });
    const openHolds = (id: string) => sqlite.prepare("SELECT id, plugin_id, app_name, reason FROM order_holds WHERE order_id = ? AND released_at IS NULL").all(id) as Array<{ id: string; plugin_id: string; app_name: string; reason: string }>;

    invoice("o_app");
    principal = { pluginId: "acme.erp", pluginName: "Acme ERP", protectedData: new Set() } as never;
    expect((await payInFull("o_app", "erp sync payment 0001")).status).toBe(201);
    expect(sqlite.prepare("SELECT payment_status FROM orders WHERE id = 'o_app'").get()).toEqual({ payment_status: "paid" });
    const [hold] = openHolds("o_app");
    expect(hold).toMatchObject({ plugin_id: "acme.erp", app_name: "Acme ERP", reason: APP_PAYMENT_REVIEW_REASON });
    // Nothing is handed over, by the route's own run or any later one.
    expect(sqlite.prepare("SELECT fulfilled_quantity FROM order_items WHERE id = 'i_o_app'").get()).toEqual({ fulfilled_quantity: 0 });
    expect(await autoFulfilOrder(db, "o_app", registry)).toMatchObject({ skipped: "on_hold", fulfilledTypes: [] });
    // The app cannot clear the review it triggered.
    expect((await call("POST", `/orders/o_app/holds/${hold!.id}/release`)).status).toBe(403);
    expect(openHolds("o_app")).toHaveLength(1);
    // Staff check the bank and release it: the download goes out.
    principal = null;
    expect((await call("POST", `/orders/o_app/holds/${hold!.id}/release`)).status).toBe(200);
    expect(openHolds("o_app")).toEqual([]);
    expect(await autoFulfilOrder(db, "o_app", registry)).not.toMatchObject({ skipped: "on_hold" });

    // Staff recording the same payment need no second look.
    invoice("o_staff");
    expect((await payInFull("o_staff", "staff payment 0001")).status).toBe(201);
    expect(openHolds("o_staff")).toEqual([]);
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
    const lookup = await call("POST", "/resources/variants/lookup", { body: { skus: ["nope-1", " tea-1 "] } });
    expect(lookup.body.data.variants).toEqual([expect.objectContaining({ id: "v_tea", sku: "TEA-1", stockVersion: expect.any(Number) })]);
    expect((await call("POST", "/resources/variants/lookup", { body: { skus: Array.from({ length: 91 }, (_, index) => `SKU-${index}`) } })).status).toBe(400);
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
    expect(prices.body.data.nextCursor).toBeNull();
    expect(prices.body.data.prices).toEqual([expect.objectContaining({
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

describe("a Worker that dies after the write commits and before its response is kept", () => {
  /** Puts every kept response back to the claim its run left: the write committed, the response did not. */
  function loseResponses(leaseUntil: number | null) {
    const rows = sqlite.prepare("SELECT key, value FROM system_kv WHERE key >= 'idem:' AND key < 'idem;'").all() as Array<{ key: string; value: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const { request } = JSON.parse(row.value) as { request: string };
      const claim = leaseUntil === null ? { state: "processing", request } : { state: "processing", request, lease: "dead-worker", leaseUntil };
      sqlite.prepare("UPDATE system_kv SET value = ? WHERE key = ?").run(JSON.stringify(claim), row.key);
    }
  }
  const lapsed = () => Math.floor(Date.now() / 1000) - 1;

  it("answers an order's repeat with the order it committed once the lease lapses, and keeps that answer", async () => {
    sqlite.exec(`INSERT INTO customers (id, name, phone, email, origin) VALUES ('cust_b2b', 'Trader Ltd', '+8801744444444', 'buyer@trader.test', 'merchant')`);
    principal = { pluginId: "acme.subscriptions", protectedData: new Set() };
    const body = {
      customerId: "cust_b2b",
      items: [{ productId: "p_tea", variantId: "v_tea", quantity: 1 }],
      shippingAddress: { countryCode: "IN", line1: "12 MG Road", locality: "Bengaluru", adminArea: "KA", postalCode: "560001" },
      shippingMinor: 0,
    };
    const headers = { "Idempotency-Key": "renewal sub_7 2026-11" };
    const placed = await call("POST", "/resources/orders", { body, headers });
    expect(placed.status).toBe(201);

    // While the first run could still be alive, a repeat waits.
    loseResponses(Math.floor(Date.now() / 1000) + 60);
    expect((await call("POST", "/resources/orders", { body, headers })).body.error.code).toBe("idempotency_in_progress");

    loseResponses(lapsed());
    const recovered = await call("POST", "/resources/orders", { body, headers });
    expect({ status: recovered.status, error: recovered.body.error }).toEqual({ status: 201, error: undefined });
    expect(recovered.body.data.order.id).toBe(placed.body.data.order.id);
    expect((sqlite.prepare("SELECT count(*) AS n FROM orders WHERE customer_id = 'cust_b2b'").get() as { n: number }).n).toBe(1);
    // The recovered answer is kept: the next repeat replays it.
    const replayed = await call("POST", "/resources/orders", { body, headers });
    expect(replayed).toMatchObject({ status: 201, replayed: "true" });
    expect(replayed.body.data.order.id).toBe(placed.body.data.order.id);
  });

  it("moves stock once when the repeat recovers an adjustment, also from a claim kept before leases", async () => {
    const headers = { "Idempotency-Key": "erp push 2026-10-21 #88" };
    const body = { delta: 5, reason: "received" };
    const first = await call("POST", "/inventory/v_tea/adjust", { body, headers });
    expect({ status: first.status, error: first.body.error }).toEqual({ status: 200, error: undefined });
    loseResponses(null);
    const recovered = await call("POST", "/inventory/v_tea/adjust", { body, headers });
    expect(recovered.status).toBe(200);
    expect(recovered.replayed).toBeNull();
    expect((await call("GET", "/resources/variants/v_tea")).body.data).toMatchObject({ onHand: 105 });
  });

  it("never creates twice: a create without a key of its own answers outcome unknown", async () => {
    const body = { name: "Nadia Islam", email: null, phone: "+8801733333333" };
    const headers = { "Idempotency-Key": "crm import nadia" };
    expect((await call("POST", "/customers", { body, headers })).status).toBe(201);
    loseResponses(lapsed());
    const repeat = await call("POST", "/customers", { body, headers });
    expect(repeat.status).toBe(409);
    expect(repeat.body.error.code).toBe("idempotency_outcome_unknown");
    expect((sqlite.prepare("SELECT count(*) AS n FROM customers WHERE phone = '+8801733333333'").get() as { n: number }).n).toBe(1);
    // A different request under the key is still refused as reuse.
    expect((await call("POST", "/customers", { body: { ...body, name: "Other" }, headers })).body.error.code).toBe("idempotency_key_reused");
  });
});
