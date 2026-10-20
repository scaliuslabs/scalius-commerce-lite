// Pay later by invoice (net terms) through the real storefront routes on the
// migrated schema: the invoice reaches only a signed-in customer the merchant
// names (a tag here), never a guest; the order commits unpaid with its terms
// and due date and its stock reserved as for cash on delivery; payments
// recorded later move it to partial and paid, each emitting payment.updated;
// once its due date passes with money due it is overdue.
import { OpenAPIHono } from "@hono/zod-openapi";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { and, sql } from "drizzle-orm";
import { getDb, type Database } from "@scalius/database/client";
import { orders } from "@scalius/database/schema";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { hashCustomerSessionToken } from "@scalius/core/modules/customers";
import { overdueOrderCondition } from "@scalius/core/modules/orders";
import { recordOrderPayment } from "@scalius/core/modules/payments";
import { paymentMethodsDocument } from "@scalius/core/modules/settings";
import { errorResponseFromError } from "../../utils/api-response";
import { orderRoutes } from "./index";

const SESSION_KEY = "net-terms-session-key-0123456789abcdef";
const LIMITER = { limit: async () => ({ success: true }) };
const ENV = {
  RL_STANDARD: LIMITER,
  RL_STRICT: LIMITER,
  JWT_SECRET: "net-terms-secret-0123456789abcdef",
  SCALIUS_SECRET: "net-terms-master-secret-0123456789abcdefghijklmnop",
  CREDENTIAL_ENCRYPTION_KEY: "net-terms-credential-key-0123456789abcdef",
  CUSTOMER_SESSION_HASH_KEY: SESSION_KEY,
  PUBLIC_API_BASE_URL: "https://api.shop.test",
  STOREFRONT_URL: "https://shop.test",
};
const TAGGED = "session-tagged-buyer";
const UNTAGGED = "session-untagged-buyer";
const ITEMS = [{ productId: "p_tea", variantId: "v_tea", quantity: 120, price: 500 }];
const QUOTE = { items: ITEMS.map(({ price: _price, ...item }) => item), city: "city_1", zone: "zone_1", shippingMethodId: "m_std", discountCodes: [] };

describe("net terms through storefront checkout", () => {
  let sqlite: DatabaseSync;
  let binding: D1Database;
  let db: Database;

  beforeEach(async () => {
    ({ sqlite, binding } = createSqliteD1Database());
    db = getDb({ ...ENV, DB: binding } as unknown as Env);
    sqlite.exec(`
      INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active)
      VALUES ('city_1', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1), ('zone_1', 'Gulshan', 'BD', 2, 'city_1', '{}', '{}', 1);
      INSERT INTO delivery_zones (id, name) VALUES ('dz_bd', 'Bangladesh'); INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('BD', 'dz_bd');
      INSERT INTO shipping_methods (id, name, fee_minor, kind, zone_id) VALUES ('m_std', 'Standard', 6000, 'delivery', 'dz_bd');
      INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('p_tea', 'Assam tea', 'assam-tea', 50000, 1);
      INSERT INTO product_variants
        (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
      VALUES ('v_tea', 'p_tea', 'TEA-250', 50000, 500, 0, 0, 1, 1, 'physical');
      INSERT INTO customers (id, name, email, phone, account_claimed_at, phone_verified_at)
      VALUES ('cust_b2b', 'Acme Traders', 'buyer@acme.test', '+8801712345678', unixepoch(), unixepoch()),
             ('cust_retail', 'Karim', 'karim@example.test', '+8801812345678', unixepoch(), unixepoch());
      INSERT INTO customer_tag_links (customer_id, tag) VALUES ('cust_b2b', 'wholesale');
      -- An app subscribed to payments and orders: the outbox triggers write their facts.
      INSERT INTO event_demand (filter) VALUES ('payment.*'), ('order.*');
    `);
    const session = sqlite.prepare("INSERT INTO customer_sessions (token_hash, customer_id, expires_at) VALUES (?, ?, ?)");
    session.run(await hashCustomerSessionToken(TAGGED, SESSION_KEY), "cust_b2b", Math.floor(Date.now() / 1000) + 3_600);
    session.run(await hashCustomerSessionToken(UNTAGGED, SESSION_KEY), "cust_retail", Math.floor(Date.now() / 1000) + 3_600);
    await paymentMethodsDocument.write(db, {
      enabledMethods: ["cod", "net_terms"],
      defaultMethod: "cod",
      netTerms: { dueInDays: 30, customerTags: ["wholesale"], segmentIds: [], appsDecide: false },
    });
  });
  afterEach(() => sqlite.close());

  async function call(path: string, body: unknown, session?: string) {
    const env = { ...ENV, DB: binding } as unknown as Env;
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
    app.onError((error, c) => {
      const { body: errorBody, status } = errorResponseFromError(error);
      return c.json(errorBody, status);
    });
    app.use("*", async (c, next) => {
      c.set("db", getDb(env));
      await next();
    });
    app.route("/orders", orderRoutes);
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => void waits.push(promise), passThroughOnException: () => undefined };
    const response = await app.request(`/api/v1${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(session ? { "X-Customer-Session": session } : {}) },
      body: JSON.stringify(body),
    }, env, ctx as never);
    const json = await response.json() as { success: boolean; data: Record<string, unknown>; error?: { message: string; details?: Record<string, unknown> } };
    await Promise.all(waits);
    return { status: response.status, json };
  }

  async function place(session: string | undefined, paymentMethod = "net_terms") {
    const quoted = await call("/orders/tax-quote", QUOTE, session);
    expect(quoted.status, JSON.stringify(quoted.json)).toBe(200);
    return call("/orders", {
      checkoutRequestId: `net_terms_${crypto.randomUUID()}`,
      expectedQuoteFingerprint: String(quoted.json.data.quoteFingerprint),
      customerName: "Acme Traders",
      customerPhone: "+8801712345678",
      customerEmail: null,
      shippingAddress: "House 1, Road 2, Gulshan",
      city: "city_1",
      zone: "zone_1",
      notes: null,
      items: ITEMS,
      discountCodes: [],
      shippingCharge: 60,
      shippingMethodId: "m_std",
      paymentMethod,
    }, session);
  }

  const stored = (id: string) => sqlite.prepare(`
    SELECT status, payment_method, payment_status, paid_amount_minor, balance_due_minor, total_amount_minor,
           payment_terms_days, payment_due_at - created_at AS due_in, inventory_action, account_owner_customer_id
    FROM orders WHERE id = ?`).get(id) as Record<string, unknown>;

  it("offers the invoice only to a signed-in customer the merchant names", async () => {
    const guest = await call("/orders/tax-quote", QUOTE);
    const retail = await call("/orders/tax-quote", QUOTE, UNTAGGED);
    const wholesale = await call("/orders/tax-quote", QUOTE, TAGGED);
    expect(guest.json.data.allowedPaymentMethods).toEqual(["cod"]);
    expect(retail.json.data.allowedPaymentMethods).toEqual(["cod"]);
    expect(wholesale.json.data.allowedPaymentMethods).toEqual(["cod", "net_terms"]);
  });

  it("refuses the invoice to a guest and to a customer it does not name, writing nothing", async () => {
    const guest = await place(undefined);
    expect(guest.status).toBe(400);
    expect(guest.json.error?.details).toMatchObject({ reason: "payment_method_unavailable" });
    const retail = await place(UNTAGGED);
    expect(retail.status).toBe(400);
    expect(retail.json.error?.details).toMatchObject({ reason: "payment_method_unavailable" });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM orders").get()).toEqual({ n: 0 });
  });

  it("places an unpaid order with its terms, due in 30 days, its stock reserved and no cash collection", async () => {
    const placed = await place(TAGGED);
    expect(placed.status, JSON.stringify(placed.json)).toBe(201);
    const id = String(placed.json.data.orderId);
    expect(stored(id)).toMatchObject({
      status: "pending",
      payment_method: "net_terms",
      payment_status: "unpaid",
      paid_amount_minor: 0,
      balance_due_minor: 120 * 50_000 + 6_000,
      payment_terms_days: 30,
      due_in: 30 * 86_400,
      inventory_action: "reserved",
      account_owner_customer_id: "cust_b2b",
    });
    expect(sqlite.prepare("SELECT reserved_stock FROM product_variants WHERE id = 'v_tea'").get()).toEqual({ reserved_stock: 120 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM cod_tracking WHERE order_id = ?").get(id)).toEqual({ n: 0 });
  });

  it("is paid later by recorded payments, each one payment.updated, and is overdue only while money is due past its date", async () => {
    const placed = await place(TAGGED);
    const id = String(placed.json.data.orderId);
    const total = Number(stored(id).total_amount_minor);
    const overdue = async () => (await db.select({ id: orders.id }).from(orders).where(and(overdueOrderCondition(), sql`${orders.id} = ${id}`)).all()).length;
    expect(await overdue()).toBe(0);
    sqlite.prepare("UPDATE orders SET payment_due_at = unixepoch() - 86400 WHERE id = ?").run(id);
    expect(await overdue()).toBe(1);

    const first = await recordOrderPayment(db, { orderId: id, amountMinor: 1_000_000, via: "bank_transfer", reference: "TRX-1", recordedBy: "staff:owner", requestKey: "invoice-payment-1" });
    expect(first).toMatchObject({ paymentStatus: "partial", paidAmountMinor: 1_000_000, balanceDueMinor: total - 1_000_000, replayed: false });
    // The same key records nothing more.
    expect(await recordOrderPayment(db, { orderId: id, amountMinor: 1_000_000, via: "bank_transfer", recordedBy: "staff:owner", requestKey: "invoice-payment-1" }))
      .toMatchObject({ paymentId: first.paymentId, replayed: true, paidAmountMinor: 1_000_000 });
    await expect(recordOrderPayment(db, { orderId: id, amountMinor: total, via: "cash", recordedBy: "staff:owner", requestKey: "invoice-payment-2" }))
      .rejects.toThrow(/more than the balance due/);
    expect(await overdue()).toBe(1);

    const rest = await recordOrderPayment(db, { orderId: id, amountMinor: total - 1_000_000, via: "cheque", recordedBy: "app:acme.erp", requestKey: "invoice-payment-3" });
    expect(rest).toMatchObject({ paymentStatus: "paid", balanceDueMinor: 0 });
    expect(await overdue()).toBe(0);

    const events = sqlite.prepare("SELECT topic, data FROM event_outbox WHERE topic IN ('payment.updated', 'order.paid') ORDER BY rowid").all() as Array<{ topic: string; data: string }>;
    expect(events.map((event) => event.topic)).toEqual(["payment.updated", "payment.updated", "order.paid"]);
    expect(JSON.parse(events[0]!.data)).toMatchObject({ orderId: id, provider: "manual", status: "succeeded" });
  });

  it("refuses a recorded payment on an order that is not an invoice", async () => {
    const placed = await place(TAGGED, "cod");
    expect(placed.status, JSON.stringify(placed.json)).toBe(201);
    await expect(recordOrderPayment(db, { orderId: String(placed.json.data.orderId), amountMinor: 100, via: "cash", recordedBy: "staff:owner", requestKey: "cod-payment-1" }))
      .rejects.toThrow(/invoice \(net terms\) orders/);
  });
});
