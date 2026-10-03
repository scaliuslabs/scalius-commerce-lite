// D1 budget of the checkout routes with installed apps' checkout functions
// (core checkout/pricing.ts). `roundTrips` counts D1 calls (a batch is one)
// and `waves` the dependent rounds, metered the way the storefront render
// budget meters pages. The guarantees:
//
// - No app implements a point: the registration read (checkout functions and
//   payment providers, one statement) rides the route's first wave (one more
//   round trip, zero more waves), and the order's read batch carries it as one
//   more statement (zero more round trips). No app call.
// - An app implements a point: one more wave for the app cart's facts (one
//   batch); the app calls themselves read nothing.
import { OpenAPIHono } from "@hono/zod-openapi";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { activatePlugin, installPlugin, writePluginSettings } from "@scalius/core/modules/plugins";
import { errorResponseFromError } from "./utils/api-response";
import { BUNDLED_PLUGINS } from "./plugins/bundled.gen";
import { PLUGIN_TEST_CREDENTIAL_KEY } from "./plugins/testing/fixtures";
import { manifest as bulkManifest } from "../../../plugins/bulk-discount/src/index";

const mocks = vi.hoisted(() => ({ skipRegistrationRead: false }));

// The baseline: the same route with the registration read answered from memory.
vi.mock("@scalius/core/modules/plugins", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scalius/core/modules/plugins")>();
  return {
    ...actual,
    listActiveFunctionRegistrations: (db: Parameters<typeof actual.listActiveFunctionRegistrations>[0]) =>
      mocks.skipRegistrationRead ? Promise.resolve([]) : actual.listActiveFunctionRegistrations(db),
    listActiveCheckoutRegistrations: (db: Parameters<typeof actual.listActiveCheckoutRegistrations>[0]) =>
      mocks.skipRegistrationRead ? Promise.resolve([]) : actual.listActiveCheckoutRegistrations(db),
  };
});

import { orderRoutes } from "./routes/storefront-orders";
import { discountRoutes } from "./routes/discounts";

interface Meter {
  binding: D1Database;
  roundTrips: number;
  waves: number;
  batchSizes: number[];
}

/** Every call waits for the current wave: calls made before it starts share it, calls made from a result start the next. */
function meteredBinding(inner: D1Database): Meter {
  const meter = { roundTrips: 0, waves: 0, batchSizes: [] } as unknown as Meter;
  let queued: Array<() => void> = [];
  const roundTrip = <T>(work: () => Promise<T>): Promise<T> => {
    meter.roundTrips += 1;
    return new Promise<T>((resolve, reject) => {
      queued.push(() => void work().then(resolve, reject));
      if (queued.length === 1) {
        setTimeout(() => {
          meter.waves += 1;
          const run = queued;
          queued = [];
          for (const start of run) start();
        }, 0);
      }
    });
  };
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "bind") {
        return (...args: unknown[]) => wrapStatement((value as (...a: unknown[]) => D1PreparedStatement).apply(target, args));
      }
      if (["all", "first", "run", "raw"].includes(String(property))) {
        return (...args: unknown[]) => roundTrip(() => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  meter.binding = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "prepare") return (query: string) => wrapStatement(target.prepare(query));
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => {
          meter.batchSizes.push(statements.length);
          return roundTrip(() => target.batch(statements));
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as D1Database;
  return meter;
}

const LIMITER = { limit: async () => ({ success: true }) };
const ENV = {
  CACHE: { get: async () => null, put: async () => undefined, delete: async () => undefined },
  RL_STANDARD: LIMITER,
  RL_STRICT: LIMITER,
  JOBS_QUEUE: { send: async () => undefined, sendBatch: async () => undefined },
  JWT_SECRET: "checkout-budget-secret-0123456789abcdef",
  SCALIUS_SECRET: "checkout-budget-master-secret-0123456789abcdefghijklmnop",
  CREDENTIAL_ENCRYPTION_KEY: PLUGIN_TEST_CREDENTIAL_KEY,
  PUBLIC_API_BASE_URL: "https://api.shop.test",
  STOREFRONT_URL: "https://shop.test",
};

const QUOTE = {
  items: [{ productId: "p_tea", variantId: "v_tea", quantity: 4 }, { productId: "p_mug", variantId: "v_mug", quantity: 1 }],
  city: "city_1",
  zone: "zone_1",
  shippingMethodId: "m_std",
  discountCodes: [],
};
const CART = {
  items: [{ productId: "p_tea", variantId: "v_tea", quantity: 4, price: 500 }, { productId: "p_mug", variantId: "v_mug", quantity: 1, price: 300 }],
};

describe("checkout route D1 budget with app checkout functions", () => {
  let sqlite: DatabaseSync;
  let binding: D1Database;

  beforeEach(() => {
    mocks.skipRegistrationRead = false;
    ({ sqlite, binding } = createSqliteD1Database());
    sqlite.exec(`
      INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1);
      INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata, is_active)
      VALUES ('city_1', 'Dhaka', 'city', NULL, '{}', '{}', 1), ('zone_1', 'Gulshan', 'zone', 'city_1', '{}', '{}', 1);
      INSERT INTO delivery_zones (id, name) VALUES ('dz_bd', 'Bangladesh'); INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('BD', 'dz_bd'); INSERT INTO shipping_methods (id, name, fee_minor, kind, zone_id) VALUES ('m_std', 'Standard', 6000, 'delivery', 'dz_bd');
      INSERT INTO products (id, name, slug, price_minor, is_active) VALUES
        ('p_tea', 'Assam tea', 'assam-tea', 50000, 1), ('p_mug', 'Mug', 'mug', 30000, 1);
      INSERT INTO product_variants
        (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
      VALUES
        ('v_tea', 'p_tea', 'TEA-250', 50000, 500, 0, 0, 1, 1, 'physical'),
        ('v_mug', 'p_mug', 'MUG-1', 30000, 500, 0, 0, 1, 1, 'physical');
    `);
  });
  afterEach(() => sqlite.close());

  async function installBulk() {
    const db = getDb({ DB: binding } as unknown as Env);
    const installed = await installPlugin(db, { manifest: bulkManifest, source: "bundled", bundleSha256: BUNDLED_PLUGINS["scalius.bulk-discount"]!.sha256, actorUserId: "owner" });
    const configured = await writePluginSettings(db, "scalius.bulk-discount", { title: "Bulk savings", tier1_quantity: 3, tier1_percent: 5 }, {
      expectedRevision: installed.revision,
      credentialEncryptionKey: PLUGIN_TEST_CREDENTIAL_KEY,
    });
    await activatePlugin(db, "scalius.bulk-discount", { actorUserId: "owner", expectedRevision: configured.revision });
  }

  async function meter(path: string, body: unknown) {
    const metered = meteredBinding(binding);
    const env = { ...ENV, DB: metered.binding } as unknown as Env;
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
    app.route("/discounts", discountRoutes);
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => void waits.push(promise), passThroughOnException: () => undefined };
    const response = await app.request(`/api/v1${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, env, ctx as never);
    const json = await response.json() as { success: boolean; data: Record<string, unknown> };
    await Promise.all(waits);
    return { status: response.status, json, roundTrips: metered.roundTrips, waves: metered.waves, batchSizes: metered.batchSizes };
  }

  async function withAndWithoutRegistrationRead(path: string, body: unknown) {
    mocks.skipRegistrationRead = true;
    const baseline = await meter(path, body);
    mocks.skipRegistrationRead = false;
    const actual = await meter(path, body);
    return { baseline, actual };
  }

  it("no app: the tax quote, cart validation and discount preview pay one round trip in an existing wave, no more", async () => {
    for (const [path, body] of [["/orders/tax-quote", QUOTE], ["/orders/cart-validation", CART], ["/discounts/validate", { items: [{ id: "p_tea", variantId: "v_tea", price: 500, quantity: 4 }] }]] as const) {
      const { baseline, actual } = await withAndWithoutRegistrationRead(path, body);
      expect(actual.status, path).toBe(200);
      expect(actual.json, path).toEqual(baseline.json);
      expect({ path, roundTrips: actual.roundTrips - baseline.roundTrips, waves: actual.waves - baseline.waves }).toEqual({ path, roundTrips: 1, waves: 0 });
    }
  });

  it("with an app: one more wave (the app cart's facts, one batch); the quote carries the app's discount", async () => {
    const before = await meter("/orders/tax-quote", QUOTE);
    await installBulk();
    const after = await meter("/orders/tax-quote", QUOTE);
    expect(after.status).toBe(200);
    expect(after.json.data).toMatchObject({
      discountMinor: 10_000,
      discounts: [expect.objectContaining({ promotionId: null, appId: "scalius.bulk-discount", title: "Bulk savings (5% off)", amount: 100 })],
      shippingRates: null,
      paymentMethods: null,
    });
    expect({ roundTrips: after.roundTrips - before.roundTrips, waves: after.waves - before.waves }).toEqual({ roundTrips: 1, waves: 1 });
  });

  it("order placement through the real route: the registrations ride the read batch, the order carries the app discount", async () => {
    const order = (fingerprint: string) => ({
      checkoutRequestId: `budget_${crypto.randomUUID()}`,
      expectedQuoteFingerprint: fingerprint,
      customerName: "Budget Buyer",
      customerPhone: "+8801712345678",
      customerEmail: null,
      shippingAddress: "House 1, Road 2, Gulshan",
      city: "city_1",
      zone: "zone_1",
      notes: null,
      items: CART.items,
      discountCodes: [],
      shippingCharge: 60,
      shippingMethodId: "m_std",
      paymentMethod: "cod",
    });
    const plain = await meter("/orders/tax-quote", QUOTE);
    const placedPlain = await meter("/orders", order(String(plain.json.data.quoteFingerprint)));
    expect(placedPlain.status, JSON.stringify(placedPlain.json)).toBe(201);
    await installBulk();
    const quoted = await meter("/orders/tax-quote", QUOTE);
    const placed = await meter("/orders", order(String(quoted.json.data.quoteFingerprint)));
    expect(placed.status, JSON.stringify(placed.json)).toBe(201);
    expect(placed.json.data).toMatchObject({ totalAmountMinor: 230_000 + 6_000 - 10_000 });
    const orderId = String(placed.json.data.orderId);
    expect(sqlite.prepare("SELECT count(*) AS n FROM order_events WHERE order_id = ? AND kind = 'app_discount'").get(orderId)).toEqual({ n: 1 });
    // The read batch is the same size with or without an app (the registration statement is always in it).
    expect(placed.batchSizes[0]).toBe(placedPlain.batchSizes[0]);
    // With an app: one more wave (the app cart's facts); the commit is still one batch.
    expect({ roundTrips: placed.roundTrips - placedPlain.roundTrips, waves: placed.waves - placedPlain.waves }).toEqual({ roundTrips: 1, waves: 1 });
  });

  it("records the measured budgets (a new query or sequential await fails here first)", async () => {
    const quote = await meter("/orders/tax-quote", QUOTE);
    const cart = await meter("/orders/cart-validation", CART);
    expect({ quote: [quote.roundTrips, quote.waves], cart: [cart.roundTrips, cart.waves] }).toMatchInlineSnapshot(`
      {
        "cart": [
          7,
          3,
        ],
        "quote": [
          10,
          6,
        ],
      }
    `);
  });
});
