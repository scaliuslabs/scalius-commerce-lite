// Digital and mixed carts through the real quote route (migrated D1): a cart
// with nothing physical has no delivery method, no address and is taxed at
// its billing country; a mixed cart ships its physical lines, and nothing
// digital changes what delivery costs.
import { OpenAPIHono } from "@hono/zod-openapi";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { createDigitalAsset, importLicenceKeys } from "@scalius/core/modules/digital";
import { errorResponseFromError } from "../../utils/api-response";
import { orderRoutes } from "./index";

const CREDENTIAL_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index + 11)));
const LIMITER = { limit: async () => ({ success: true }) };
const ENV = {
  RL_STANDARD: LIMITER,
  RL_STRICT: LIMITER,
  JWT_SECRET: "digital-checkout-secret-0123456789abcdef",
  SCALIUS_SECRET: "digital-checkout-master-secret-0123456789abcdefghijklmnop",
  CREDENTIAL_ENCRYPTION_KEY: CREDENTIAL_KEY,
  PUBLIC_API_BASE_URL: "https://api.shop.test",
  STOREFRONT_URL: "https://shop.test",
};

describe("digital and mixed checkout quotes", () => {
  let sqlite: DatabaseSync;
  let binding: D1Database;

  beforeEach(async () => {
    ({ sqlite, binding } = createSqliteD1Database());
    // The licence product is marked "free delivery" (as stores mark downloads).
    sqlite.exec(`
      INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active)
      VALUES ('city_1', 'Rajshahi', 'BD', 1, NULL, '{}', '{}', 1), ('zone_1', 'Bagmara', 'BD', 2, 'city_1', '{}', '{}', 1);
      INSERT INTO delivery_zones (id, name) VALUES ('dz_bd', 'Bangladesh'); INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('BD', 'dz_bd');
      INSERT INTO shipping_methods (id, name, fee_minor, kind, zone_id) VALUES ('m_std', 'Standard', 6000, 'delivery', 'dz_bd');
      INSERT INTO products (id, name, slug, price_minor, is_active, free_delivery) VALUES
        ('p_key', 'App licence', 'app-licence', 50000, 1, 1), ('p_mug', 'Mug', 'mug', 30000, 1, 0);
      INSERT INTO product_variants
        (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
      VALUES
        ('v_key', 'p_key', 'KEY-1', 50000, 0, 0, 0, 1, 1, 'digital'),
        ('v_mug', 'p_mug', 'MUG-1', 30000, 500, 0, 0, 1, 1, 'physical');
      INSERT INTO tax_classes (id, name) VALUES ('tax_standard', 'Standard');
      INSERT OR REPLACE INTO tax_settings (id, enabled, tax_shipping, default_tax_class_id, display_label, version)
      VALUES ('default', 1, 0, 'tax_standard', 'VAT', 1);
      INSERT INTO tax_regions (id, country_code) VALUES ('txreg_bd', 'BD');
      INSERT INTO tax_rates (id, tax_class_id, tax_region_id, name, rate_bps, is_active)
      VALUES ('rate_bd', 'tax_standard', 'txreg_bd', 'VAT', 1000, 1);
    `);
    const db = getDb({ DB: binding } as unknown as Env);
    const { asset } = await createDigitalAsset(db, undefined, "p_key", { kind: "licence_keys", variantId: "v_key" });
    await importLicenceKeys(db, { assetId: asset.id, keys: ["KEY-A-0001", "KEY-B-0002"], requestKey: crypto.randomUUID(), credentialKey: CREDENTIAL_KEY });
  });
  afterEach(() => sqlite.close());

  async function quote(body: unknown) {
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
    const response = await app.request("/api/v1/orders/tax-quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, env, ctx as never);
    const json = await response.json() as { success: boolean; data: Record<string, unknown> };
    await Promise.all(waits);
    return { status: response.status, json };
  }

  it("quotes a licence-key-only cart with no address and no delivery method, taxed at the billing country", async () => {
    const result = await quote({
      items: [{ cartKey: "k1", productId: "p_key", variantId: "v_key", quantity: 1 }],
      billingCountryCode: "BD",
      discountCodes: [],
    });
    expect(result.status).toBe(200);
    expect(result.json.data).toMatchObject({
      requiresShipping: false,
      shippingMethod: null,
      shippingMinor: 0,
      subtotalMinor: 50_000,
      taxMinor: 5_000,
      totalMinor: 55_000,
      items: [expect.objectContaining({ fulfillmentType: "digital" })],
    });
  });

  it("ships a mixed cart's physical line at its fee: a digital line marked free delivery waives nothing", async () => {
    const result = await quote({
      items: [
        { cartKey: "k1", productId: "p_key", variantId: "v_key", quantity: 1 },
        { cartKey: "m1", productId: "p_mug", variantId: "v_mug", quantity: 1 },
      ],
      city: "city_1",
      zone: "zone_1",
      shippingMethodId: "m_std",
      discountCodes: [],
    });
    expect(result.status).toBe(200);
    expect(result.json.data).toMatchObject({
      requiresShipping: true,
      shippingMinor: 6_000,
      shippingMethod: expect.objectContaining({ id: "m_std", feeWaived: false }),
      items: [
        expect.objectContaining({ cartKey: "k1", fulfillmentType: "digital" }),
        expect.objectContaining({ cartKey: "m1", fulfillmentType: "ship" }),
      ],
    });
  });
});
