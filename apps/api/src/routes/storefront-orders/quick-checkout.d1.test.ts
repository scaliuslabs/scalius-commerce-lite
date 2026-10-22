// The no-JavaScript checkout (buyer QA B2): the storefront server asks for the
// quote and places the order with the exact bodies `/checkout/quick` builds
// from its form, through the real storefront routes on the migrated schema.
import { OpenAPIHono } from "@hono/zod-openapi";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { paymentMethodsDocument } from "@scalius/core/modules/settings";
import { errorResponseFromError } from "../../utils/api-response";
import { orderRoutes } from "./index";

const LIMITER = { limit: async () => ({ success: true }) };
const ENV = {
  RL_STANDARD: LIMITER,
  RL_STRICT: LIMITER,
  JWT_SECRET: "quick-checkout-secret-0123456789abcdef",
  SCALIUS_SECRET: "quick-checkout-master-secret-0123456789abcdefghijklmnop",
  CREDENTIAL_ENCRYPTION_KEY: "quick-checkout-credential-key-0123456789abcdef",
  CUSTOMER_SESSION_HASH_KEY: "quick-checkout-session-key-0123456789abcdef",
  PUBLIC_API_BASE_URL: "https://api.shop.test",
  STOREFRONT_URL: "https://shop.test",
};

describe("the no-JavaScript checkout", () => {
  let sqlite: DatabaseSync;
  let binding: D1Database;

  beforeEach(async () => {
    ({ sqlite, binding } = createSqliteD1Database());
    sqlite.exec(`
      INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active)
      VALUES ('city_1', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1), ('zone_1', 'Gulshan', 'BD', 2, 'city_1', '{}', '{}', 1);
      INSERT INTO delivery_zones (id, name) VALUES ('dz_dhaka', 'Inside Dhaka');
      INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('BD', 'dz_dhaka');
      INSERT INTO shipping_methods (id, name, fee_minor, kind, zone_id) VALUES ('m_dhaka', 'Inside Dhaka', 6000, 'delivery', 'dz_dhaka');
      INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('p_candle', 'Terra Scented Candle Trio', 'terra-scented-candle-trio', 185000, 1);
      INSERT INTO product_option_definitions (id, product_id, name, normalized_name, position, standard_mapping)
      VALUES ('popt_scent', 'p_candle', 'Scent', 'scent', 0, 'none');
      INSERT INTO product_option_values (id, option_definition_id, value, normalized_value, position)
      VALUES ('pval_linen', 'popt_scent', 'Linen', 'linen', 0);
      INSERT INTO product_variants (id, product_id, option_combination_key, sku, price_minor, stock, is_default, track_inventory)
      VALUES ('v_linen', 'p_candle', 'pval_linen', 'TERRA-LINEN', 185000, 10, 0, 1);
      INSERT INTO product_variant_option_values (variant_id, option_definition_id, option_value_id)
      VALUES ('v_linen', 'popt_scent', 'pval_linen');
    `);
    await paymentMethodsDocument.write(getDb({ ...ENV, DB: binding } as unknown as Env), { enabledMethods: ["cod"], defaultMethod: "cod" });
  });
  afterEach(() => sqlite.close());

  async function call(path: string, body: unknown) {
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
      headers: { "Content-Type": "application/json", "x-storefront-language": "en", "x-storefront-locale": "en-BD" },
      body: JSON.stringify(body),
    }, env, ctx as never);
    const json = await response.json() as { success: boolean; data: Record<string, unknown>; error?: { message: string; code?: string; details?: Record<string, unknown> } };
    await Promise.all(waits);
    return { status: response.status, json };
  }

  // What `quickCheckoutQuoteInput` + `buildTaxQuoteRequest` send for the tester's form.
  const QUOTE = {
    items: [{ cartKey: "quick_buy:p_candle:v_linen", productId: "p_candle", variantId: "v_linen", quantity: 1, productName: "Terra Scented Candle Trio", variantLabel: "Scent: Linen" }],
    city: "city_1",
    zone: "zone_1",
    shippingMethodId: "m_dhaka",
    cod: true,
    discountCodes: [],
    customerPhone: "+8801712345678",
  };

  it("quotes the order the quick checkout asks for", async () => {
    const quoted = await call("/orders/tax-quote", QUOTE);
    expect(quoted.status, JSON.stringify(quoted.json)).toBe(200);
  });
});
