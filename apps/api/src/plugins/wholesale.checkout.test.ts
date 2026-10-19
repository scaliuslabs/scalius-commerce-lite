// acme.wholesale through the real storefront checkout routes (bundled
// loader, migrated schema): declared reads replace per-buyer copies. The
// buyer's membership names a company; the company's one price list prices
// the cart (a hop), per-SKU records and the product's custom field set the
// minimums, an approved quote on the company is spent with the order at the
// revision read, and every read rides the checkout's own facts batch: the
// same waves as the same app without reads.
import { OpenAPIHono } from "@hono/zod-openapi";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bundled.gen", async (importOriginal) => (await import("./testing/fixture-apps")).withFixtureApps(await importOriginal()));
import { getDb, type Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { activatePlugin, installPlugin } from "@scalius/core/modules/plugins";
import { getObjectRecordVersion, putObjectRecord } from "@scalius/core/modules/objects";
import { hashCustomerSessionToken } from "@scalius/core/modules/customers";
import { parsePluginManifest, type PluginManifestInput } from "@scalius/shared/plugins";
import { errorResponseFromError } from "../utils/api-response";
import { orderRoutes } from "../routes/storefront-orders";
import { BUNDLED_PLUGINS } from "./bundled.gen";
import { setPluginCustomFieldValues } from "./custom-fields";
import { manifest as wholesaleManifest } from "./testing/apps/wholesale/src/index";

const SESSION_KEY = "wholesale-checkout-session-key-0123456789";
const SESSION = "wholesale-buyer-session";
const LIMITER = { limit: async () => ({ success: true }) };
const ENV = {
  RL_STANDARD: LIMITER,
  RL_STRICT: LIMITER,
  JWT_SECRET: "wholesale-checkout-secret-0123456789abcdef",
  SCALIUS_SECRET: "wholesale-checkout-master-secret-0123456789abcdefghijklmnop",
  CREDENTIAL_ENCRYPTION_KEY: "wholesale-credential-key-0123456789abcdef",
  CUSTOMER_SESSION_HASH_KEY: SESSION_KEY,
  PUBLIC_API_BASE_URL: "https://api.shop.test",
  STOREFRONT_URL: "https://shop.test",
};
const parsed = parsePluginManifest(wholesaleManifest);
if (!parsed.ok) throw new Error("Invalid wholesale test manifest");
const OBJECTS = parsed.manifest.objects;

/** Counts D1 round trips (a batch is one) and dependent waves, as the checkout budget test does. */
function meteredBinding(inner: D1Database) {
  const meter = { binding: inner, roundTrips: 0, waves: 0, batchSizes: [] as number[] };
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
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "bind") return (...args: unknown[]) => wrap((value as (...a: unknown[]) => D1PreparedStatement).apply(target, args));
      if (["all", "first", "run", "raw"].includes(String(property))) return (...args: unknown[]) => roundTrip(() => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args));
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  meter.binding = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "prepare") return (query: string) => wrap(target.prepare(query));
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

const line = (variantId: string, productId: string, quantity: number, price: number) => ({ productId, variantId, quantity, price });

describe("wholesale accounts through storefront checkout (declared reads)", () => {
  let sqlite: DatabaseSync;
  let binding: D1Database;
  let db: Database;

  async function install(manifest: PluginManifestInput = wholesaleManifest) {
    const installed = await installPlugin(db, { manifest, source: "bundled", bundleSha256: BUNDLED_PLUGINS["acme.wholesale"]!.sha256, actorUserId: "owner" });
    await activatePlugin(db, "acme.wholesale", { actorUserId: "owner", expectedRevision: installed.revision });
  }

  async function fresh() {
    ({ sqlite, binding } = createSqliteD1Database());
    db = getDb({ ...ENV, DB: binding } as unknown as Env);
    sqlite.exec(`
      INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1);
      INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active)
      VALUES ('city_1', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1), ('zone_1', 'Gulshan', 'BD', 2, 'city_1', '{}', '{}', 1);
      INSERT INTO delivery_zones (id, name) VALUES ('dz_bd', 'Bangladesh'); INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('BD', 'dz_bd'); INSERT INTO shipping_methods (id, name, fee_minor, kind, zone_id) VALUES ('m_std', 'Standard', 6000, 'delivery', 'dz_bd');
      INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('p_tea', 'Assam tea', 'assam-tea', 50000, 1), ('p_mug', 'Mug', 'mug', 30000, 1);
      INSERT INTO product_variants
        (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
      VALUES ('v_tea', 'p_tea', 'TEA-250', 50000, 500, 0, 0, 1, 1, 'physical'), ('v_mug', 'p_mug', 'MUG-1', 30000, 500, 0, 0, 1, 1, 'physical');
      INSERT INTO customers (id, name, email, phone, account_claimed_at, email_verified_at)
      VALUES ('cust_1', 'Rahima', 'rahima@example.test', '+8801712345678', unixepoch(), unixepoch());
    `);
    sqlite.prepare("INSERT INTO customer_sessions (token_hash, customer_id, expires_at) VALUES (?, ?, ?)")
      .run(await hashCustomerSessionToken(SESSION, SESSION_KEY), "cust_1", Math.floor(Date.now() / 1000) + 3_600);
  }
  beforeEach(fresh);
  afterEach(() => sqlite.close());

  async function seed() {
    await putObjectRecord(db, "acme.wholesale", "companies", OBJECTS.companies!, "co_1", {
      name: "Acme Ltd", terms: "prepaid", prices: { v_tea: 40_000 }, approved_quotes: { "Q-7": 5_000 },
    });
    await putObjectRecord(db, "acme.wholesale", "members", OBJECTS.members!, "cust_1", { company_id: "co_1" });
    await putObjectRecord(db, "acme.wholesale", "moq", OBJECTS.moq!, "v_mug", { min_qty: 3 });
    await setPluginCustomFieldValues(db, "acme.wholesale", parsed.ok ? parsed.manifest.customFields : [], "product", "p_tea", { min_qty: 6 });
  }

  async function call(path: string, body: unknown, options: { signedIn?: boolean } = {}) {
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
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => void waits.push(promise), passThroughOnException: () => undefined };
    const response = await app.request(`/api/v1${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(options.signedIn === false ? {} : { "X-Customer-Session": SESSION }) },
      body: JSON.stringify(body),
    }, env, ctx as never);
    const json = await response.json() as { success: boolean; data: Record<string, unknown>; error?: { message: string } };
    await Promise.all(waits);
    return { status: response.status, json, roundTrips: metered.roundTrips, waves: metered.waves, batchSizes: metered.batchSizes };
  }

  const quote = (items: unknown[], discountCodes: string[] = []) => ({ items, city: "city_1", zone: "zone_1", shippingMethodId: "m_std", discountCodes });

  /**
   * A route's dependent waves, as a structural lower bound: after a warm-up
   * (a first module load can split a wave) the fewest of three runs, since a
   * loaded machine can only split a wave, never merge two.
   */
  async function measured(run: () => ReturnType<typeof call>) {
    await run();
    const runs = [await run(), await run(), await run()];
    return { ...runs[0]!, waves: Math.min(...runs.map((entry) => entry.waves)) };
  }

  it("prices from the company, blocks under the minimums, and spends a quote once with the order", async () => {
    await install();
    await seed();
    const validated = await call("/orders/cart-validation", { items: [line("v_tea", "p_tea", 2, 400), line("v_mug", "p_mug", 1, 300)] });
    expect(validated.status, JSON.stringify(validated.json)).toBe(200);
    expect(validated.json.data.items).toMatchObject([{ unitPrice: 400 }, { unitPrice: 300 }]);
    expect((validated.json.data.ruleErrors as Array<{ message: string }>).map((error) => error.message).sort()).toEqual([
      "Order at least 3 of Mug.",
      "Order at least 6 of Assam tea.",
    ]);

    // A guest sees catalogue prices and only the per-SKU minimum (no membership, no hop).
    const guest = await call("/orders/cart-validation", { items: [line("v_tea", "p_tea", 6, 500), line("v_mug", "p_mug", 3, 300)] }, { signedIn: false });
    expect(guest.json.data).toMatchObject({ valid: true, ruleErrors: [] });

    const items = [line("v_tea", "p_tea", 6, 400), line("v_mug", "p_mug", 3, 300)];
    const quoted = await call("/orders/tax-quote", quote(items.map(({ price: _price, ...item }) => item), ["Q-7"]));
    expect(quoted.status, JSON.stringify(quoted.json)).toBe(200);
    expect(quoted.json.data).toMatchObject({ discountMinor: 5_000 });

    const placed = await call("/orders", {
      checkoutRequestId: `wholesale_${crypto.randomUUID()}`,
      expectedQuoteFingerprint: String(quoted.json.data.quoteFingerprint),
      customerName: "Rahima",
      customerPhone: "+8801712345678",
      customerEmail: null,
      shippingAddress: "House 1, Road 2, Gulshan",
      city: "city_1",
      zone: "zone_1",
      notes: null,
      items,
      discountCodes: ["Q-7"],
      shippingCharge: 60,
      shippingMethodId: "m_std",
      paymentMethod: "cod",
    });
    expect(placed.status, JSON.stringify(placed.json)).toBe(201);
    expect(placed.json.data).toMatchObject({ totalAmountMinor: 6 * 40_000 + 3 * 30_000 + 6_000 - 5_000 });
    // The company record, not a per-buyer copy, carried the quote: spent at the revision read.
    expect(await getObjectRecordVersion(db, "acme.wholesale", "companies", "co_1")).toMatchObject({ revision: 2, data: { approved_quotes: {} } });
    expect((await call("/orders/tax-quote", quote(items.map(({ price: _price, ...item }) => item), ["Q-7"]))).json.data).toMatchObject({ discountMinor: 0 });
  });

  it("reads in the checkout's own batch: the same round trips and waves as the app without reads", async () => {
    const items = [{ productId: "p_tea", variantId: "v_tea", quantity: 6 }, { productId: "p_mug", variantId: "v_mug", quantity: 3 }];
    await install({ ...wholesaleManifest, functions: wholesaleManifest.functions.map((fn) => ({ ...fn, reads: [] })) });
    await seed();
    const without = await measured(() => call("/orders/tax-quote", quote(items, ["Q-7"])));
    expect(without.status, JSON.stringify(without.json)).toBe(200);
    sqlite.close();
    await fresh();
    await install();
    await seed();
    const withReads = await measured(() => call("/orders/tax-quote", quote(items, ["Q-7"])));
    expect(withReads.json.data).toMatchObject({ discountMinor: 5_000 });
    expect({ roundTrips: withReads.roundTrips, waves: withReads.waves }).toEqual({ roundTrips: without.roundTrips, waves: without.waves });
    // Only more statements in batches already sent: the line-price facts (member, company hop) and the
    // checkout facts (member, company hop, moq, the product field).
    expect(withReads.batchSizes.length).toBe(without.batchSizes.length);
    const added = withReads.batchSizes.map((size, index) => size - without.batchSizes[index]!);
    expect(added.filter((count) => count !== 0)).toEqual([2, 4]);
  });
});
