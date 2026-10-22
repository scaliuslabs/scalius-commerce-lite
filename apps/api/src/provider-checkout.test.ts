// A brand-new store takes its first order on every supported database: a
// fresh install (D1 through the migrated SQLite test binding, the local Turso
// engine through the production Turso adapter, and, opt-in with
// SCALIUS_TEST_POSTGRES_URL, PostgreSQL through the production adapter), one
// product and one delivery zone, then the real checkout routes: a quote, a
// cash-on-delivery order, its replay, and the stock it reserved.
import { afterAll, describe, expect, it, vi } from "vitest";

import type { Database } from "@scalius/database/types";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { createTursoEngineDatabase, freshTursoEngineStore } from "@scalius/database/testing/turso-engine";
import { closeNativePostgres, createNativePostgres, NATIVE_POSTGRES_TEST_TIMEOUT, nativePostgresUrl } from "@scalius/database/testing/postgres-native";

vi.mock("@scalius/database/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scalius/database/client")>();
  return {
    ...actual,
    getDb: (env?: Record<string, unknown>) => (env?.__STORE_DB ?? actual.getDb(env as never)) as ReturnType<typeof actual.getDb>,
  };
});

const { fetchRuntimeApiApp } = await import("./runtime/fetch-runtime-app");
const { composeApiRuntimeEnv } = await import("./runtime/runtime-env");

/** The first product, zone and rate a merchant sets up (portable SQL, every provider). */
const STORE_SETUP = [
  `INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active)
   VALUES ('city_1', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1), ('zone_1', 'Gulshan', 'BD', 2, 'city_1', '{}', '{}', 1)`,
  `INSERT INTO delivery_zones (id, name) VALUES ('dz_bd', 'Bangladesh')`,
  `INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('BD', 'dz_bd')`,
  `INSERT INTO shipping_methods (id, name, fee_minor, kind, zone_id) VALUES ('m_std', 'Standard', 6000, 'delivery', 'dz_bd')`,
  `INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('p_tee', 'First tee', 'first-tee', 75000, 1)`,
  `INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
   VALUES ('v_tee', 'p_tee', 'TEE-1', 75000, 20, 0, 0, 1, 1, 'physical')`,
];

interface Store {
  db: Database;
  exec(sql: string): Promise<void>;
  one(sql: string): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

const stores: Record<string, () => Promise<Store>> = {
  d1: async () => {
    const { sqlite, binding } = createSqliteD1Database();
    const { getDb } = await vi.importActual<typeof import("@scalius/database/client")>("@scalius/database/client");
    return {
      db: getDb({ DB: binding } as never),
      exec: async (sql) => { sqlite.exec(sql); },
      one: async (sql) => sqlite.prepare(sql).get() as Record<string, unknown>,
      close: async () => sqlite.close(),
    };
  },
  turso: async () => {
    const engine = await freshTursoEngineStore();
    return {
      db: createTursoEngineDatabase(engine),
      exec: async (sql) => { await engine.exec(sql); },
      one: async (sql) => (await (await engine.prepare(sql)).get()) as Record<string, unknown>,
      close: () => engine.close(),
    };
  },
  ...(nativePostgresUrl() ? {
    postgres: async () => {
      const store = await createNativePostgres({ label: "first_order" });
      return {
        db: store.db,
        exec: async (sql) => { await store.client.query(sql); },
        one: async (sql) => (await store.client.query(sql)).rows[0] as Record<string, unknown>,
        close: async () => undefined,
      };
    },
  } : {}),
};

afterAll(() => closeNativePostgres());

describe.each(Object.keys(stores))("a new store's first order on %s", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, (provider) => {
  it("quotes, places a cash-on-delivery order once, and reserves its stock", async () => {
    const store = await stores[provider]!();
    try {
      for (const statement of STORE_SETUP) await store.exec(statement);
      const limiter = { limit: async () => ({ success: true }) };
      const baseEnv = {
        __STORE_DB: store.db,
        SCALIUS_SECRET: "provider-checkout-master-secret-with-more-than-32-chars",
        CREDENTIAL_ENCRYPTION_KEY: btoa("0123456789abcdef0123456789abcdef"),
        CF_VERSION_METADATA: { id: "provider-checkout", tag: "", timestamp: "" },
        RL_STRICT: limiter,
        RL_STANDARD: limiter,
        BUCKET: {},
      };
      const call = async (path: string, body: unknown) => {
        const pending: Promise<unknown>[] = [];
        const ctx = { waitUntil: (promise: Promise<unknown>) => void pending.push(Promise.resolve(promise).catch(() => undefined)), passThroughOnException: () => undefined } as unknown as ExecutionContext;
        const env = await composeApiRuntimeEnv(baseEnv as unknown as Env, { requestUrl: "http://localhost:8787/" });
        const response = await fetchRuntimeApiApp(new Request(`http://localhost:8787/api/v1${path}`, {
          method: "POST",
          headers: { origin: "http://localhost:4322", "content-type": "application/json" },
          body: JSON.stringify(body),
        }), env, ctx);
        const json = await response.json() as { data?: Record<string, unknown>; error?: unknown };
        for (let index = 0; index < pending.length; index += 1) await pending[index];
        return { status: response.status, json };
      };

      const items = [{ productId: "p_tee", variantId: "v_tee", quantity: 2 }];
      const quote = await call("/orders/tax-quote", { items, city: "city_1", zone: "zone_1", shippingMethodId: "m_std", discountCodes: [] });
      expect(quote.status, JSON.stringify(quote.json)).toBe(200);
      const order = {
        checkoutRequestId: `first_${provider}_${crypto.randomUUID()}`,
        expectedQuoteFingerprint: String(quote.json.data!.quoteFingerprint),
        customerName: "First Buyer", customerPhone: "+8801712345678", customerEmail: null,
        shippingAddress: "House 1, Road 2, Gulshan", city: "city_1", zone: "zone_1", notes: null,
        items: items.map((item) => ({ ...item, price: 750 })), discountCodes: [], shippingCharge: 60, shippingMethodId: "m_std", paymentMethod: "cod",
      };
      const placed = await call("/orders", order);
      expect(placed.status, JSON.stringify(placed.json)).toBe(201);
      expect(placed.json.data).toMatchObject({ totalAmountMinor: 2 * 75_000 + 6_000 });
      const replay = await call("/orders", order);
      expect([200, 201], JSON.stringify(replay.json)).toContain(replay.status);
      expect(replay.json.data?.orderId).toBe(placed.json.data!.orderId);

      expect(Number((await store.one("SELECT count(*) AS n FROM orders")).n)).toBe(1);
      expect(Number((await store.one("SELECT reserved_stock AS r FROM product_variants WHERE id = 'v_tee'")).r)).toBe(2);
    } finally {
      await store.close();
    }
  });
});
