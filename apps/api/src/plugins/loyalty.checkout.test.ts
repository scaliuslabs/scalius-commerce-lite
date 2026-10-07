// scalius.loyalty end to end through the real storefront checkout routes on
// the migrated schema (bundled loader): the buyer's balance is the
// function's snapshot, the redemption is committed with the order in the
// same batch at the revision the function saw, and two orders racing for the
// same points never both get them.
import { OpenAPIHono } from "@hono/zod-openapi";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, type Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
  activatePlugin,
  getPluginRecordVersion,
  installPlugin,
  putPluginRecord,
  writePluginSettings,
} from "@scalius/core/modules/plugins";
import { hashCustomerSessionToken } from "@scalius/core/modules/customers";
import { errorResponseFromError } from "../utils/api-response";
import { orderRoutes } from "../routes/storefront-orders";
import { BUNDLED_PLUGINS } from "./bundled.gen";
import { PLUGIN_TEST_CREDENTIAL_KEY } from "./testing/fixtures";
import { manifest as loyaltyManifest } from "../../../../plugins/loyalty/src/index";

const SESSION_KEY = "loyalty-checkout-session-key-0123456789";
const SESSION = "loyalty-buyer-session";
const LIMITER = { limit: async () => ({ success: true }) };
const ENV = {
  CACHE: { get: async () => null, put: async () => undefined, delete: async () => undefined },
  RL_STANDARD: LIMITER,
  RL_STRICT: LIMITER,
  JOBS_QUEUE: { send: async () => undefined, sendBatch: async () => undefined },
  JWT_SECRET: "loyalty-checkout-secret-0123456789abcdef",
  SCALIUS_SECRET: "loyalty-checkout-master-secret-0123456789abcdefghijklmnop",
  CREDENTIAL_ENCRYPTION_KEY: PLUGIN_TEST_CREDENTIAL_KEY,
  CUSTOMER_SESSION_HASH_KEY: SESSION_KEY,
  PUBLIC_API_BASE_URL: "https://api.shop.test",
  STOREFRONT_URL: "https://shop.test",
};
const BALANCES = { indexes: [], unique: [] };

const QUOTE = {
  items: [{ productId: "p_tea", variantId: "v_tea", quantity: 2 }],
  city: "city_1",
  zone: "zone_1",
  shippingMethodId: "m_std",
  discountCodes: ["POINTS"],
};

describe("loyalty points through storefront checkout", () => {
  let sqlite: DatabaseSync;
  let binding: D1Database;
  let db: Database;
  let env: Env;

  beforeEach(async () => {
    ({ sqlite, binding } = createSqliteD1Database());
    env = { ...ENV, DB: binding } as unknown as Env;
    db = getDb(env);
    sqlite.exec(`
      INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1);
      INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active)
      VALUES ('city_1', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1), ('zone_1', 'Gulshan', 'BD', 2, 'city_1', '{}', '{}', 1);
      INSERT INTO delivery_zones (id, name) VALUES ('dz_bd', 'Bangladesh'); INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('BD', 'dz_bd'); INSERT INTO shipping_methods (id, name, fee_minor, kind, zone_id) VALUES ('m_std', 'Standard', 6000, 'delivery', 'dz_bd');
      INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('p_tea', 'Assam tea', 'assam-tea', 50000, 1);
      INSERT INTO product_variants
        (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
      VALUES ('v_tea', 'p_tea', 'TEA-250', 50000, 500, 0, 0, 1, 1, 'physical');
      INSERT INTO customers (id, name, email, phone, account_claimed_at, email_verified_at)
      VALUES ('cust_1', 'Rahima', 'rahima@example.test', '+8801712345678', unixepoch(), unixepoch());
    `);
    sqlite.prepare("INSERT INTO customer_sessions (token_hash, customer_id, expires_at) VALUES (?, ?, ?)")
      .run(await hashCustomerSessionToken(SESSION, SESSION_KEY), "cust_1", Math.floor(Date.now() / 1000) + 3_600);

    const installed = await installPlugin(db, {
      manifest: loyaltyManifest,
      source: "bundled",
      bundleSha256: BUNDLED_PLUGINS["scalius.loyalty"]!.sha256,
      actorUserId: "owner",
    });
    const configured = await writePluginSettings(db, "scalius.loyalty", { title: "Loyalty points", code: "POINTS", min_redeem: 10 }, {
      expectedRevision: installed.revision,
      credentialEncryptionKey: PLUGIN_TEST_CREDENTIAL_KEY,
    });
    await activatePlugin(db, "scalius.loyalty", { actorUserId: "owner", expectedRevision: configured.revision });
    // 300 points, worth 300 BDT.
    await putPluginRecord(db, "scalius.loyalty", "balances", BALANCES, "cust_1", { points: 300, earned: 300, spent: 0 });
  });
  afterEach(() => sqlite.close());

  async function call(path: string, body: unknown) {
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
      headers: { "Content-Type": "application/json", "X-Customer-Session": SESSION },
      body: JSON.stringify(body),
    }, env, ctx as never);
    const json = await response.json() as { success: boolean; data: Record<string, unknown>; error?: { message: string; details?: { reason?: string } } };
    await Promise.all(waits);
    return { status: response.status, json };
  }

  const order = (fingerprint: string) => ({
    checkoutRequestId: `loyalty_${crypto.randomUUID()}`,
    expectedQuoteFingerprint: fingerprint,
    customerName: "Rahima",
    customerPhone: "+8801712345678",
    customerEmail: null,
    shippingAddress: "House 1, Road 2, Gulshan",
    city: "city_1",
    zone: "zone_1",
    notes: null,
    items: [{ productId: "p_tea", variantId: "v_tea", quantity: 2, price: 500 }],
    discountCodes: ["POINTS"],
    shippingCharge: 60,
    shippingMethodId: "m_std",
    paymentMethod: "cod",
  });

  it("quotes the points, commits the debit with the order, and offers nothing once they are spent", async () => {
    const quoted = await call("/orders/tax-quote", QUOTE);
    expect(quoted.status, JSON.stringify(quoted.json)).toBe(200);
    expect(quoted.json.data).toMatchObject({ discountMinor: 30_000 });

    const placed = await call("/orders", order(String(quoted.json.data.quoteFingerprint)));
    expect(placed.status, JSON.stringify(placed.json)).toBe(201);
    expect(placed.json.data).toMatchObject({ totalAmountMinor: 100_000 + 6_000 - 30_000 });
    expect(await getPluginRecordVersion(db, "scalius.loyalty", "balances", "cust_1"))
      .toEqual({ data: { points: 0, earned: 300, spent: 300 }, revision: 2 });

    // Spent: the next quote has no points to offer, and an order on the old quote is refused.
    expect((await call("/orders/tax-quote", QUOTE)).json.data).toMatchObject({ discountMinor: 0 });
    const replay = await call("/orders", order(String(quoted.json.data.quoteFingerprint)));
    expect(replay.status).not.toBe(201);
    expect(sqlite.prepare("SELECT count(*) AS n FROM orders").get()).toEqual({ n: 1 });
  });

  it("lets only one of two racing orders spend the same points", async () => {
    const quoted = await call("/orders/tax-quote", QUOTE);
    const fingerprint = String(quoted.json.data.quoteFingerprint);
    const results = await Promise.all([call("/orders", order(fingerprint)), call("/orders", order(fingerprint))]);
    const statuses = results.map((result) => result.status).sort();
    expect(statuses[0]).toBe(201);
    expect(statuses[1]).not.toBe(201);
    const refused = results.find((result) => result.status !== 201)!;
    // Lost the race at the commit (the guard), or saw the spent balance while pricing.
    expect(refused.json.error?.details?.reason ?? refused.json.error?.message).toBeTruthy();
    expect(await getPluginRecordVersion(db, "scalius.loyalty", "balances", "cust_1"))
      .toEqual({ data: { points: 0, earned: 300, spent: 300 }, revision: 2 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM orders").get()).toEqual({ n: 1 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM order_events WHERE kind = 'app_discount'").get()).toEqual({ n: 1 });
  });

  it("refuses an order whose points changed after pricing, with the store's words, and writes nothing", async () => {
    const quoted = await call("/orders/tax-quote", QUOTE);
    // The balance changes between this order's pricing and its commit:
    // pricing read revision 1; when the commit batch is prepared, another
    // write moves it on, so the commit's guard must refuse.
    let bumped = false;
    env = {
      ...env,
      DB: new Proxy(binding, {
        get(target, property, receiver) {
          if (property !== "prepare") return Reflect.get(target, property, receiver);
          return (query: string) => {
            if (!bumped && /insert into "orders"/i.test(query)) {
              bumped = true;
              sqlite.prepare("UPDATE plugin_records SET revision = revision + 1, data_json = '{\"points\":5,\"earned\":300,\"spent\":295}' WHERE plugin_id = 'scalius.loyalty'").run();
            }
            return target.prepare(query);
          };
        },
      }),
    } as unknown as Env;
    const placed = await call("/orders", order(String(quoted.json.data.quoteFingerprint)));
    expect(bumped).toBe(true);
    expect(placed.status).toBe(400);
    expect(placed.json.error).toMatchObject({
      message: "An offer in your order changed while it was being placed. Review your order and try again.",
      details: { reason: "APP_OFFER_CHANGED" },
    });
    expect(sqlite.prepare("SELECT count(*) AS n FROM orders").get()).toEqual({ n: 0 });
    expect((await getPluginRecordVersion(db, "scalius.loyalty", "balances", "cust_1"))?.data).toEqual({ points: 5, earned: 300, spent: 295 });
  });
});
