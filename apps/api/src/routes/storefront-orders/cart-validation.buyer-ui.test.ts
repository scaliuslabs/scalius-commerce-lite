// The cart check and the checkout quote answer the UI slots of the pages that
// read them, derived from the protocol (`storefrontUiSlotsOn`): the cart
// check the cart page's and the cart drawer's, the quote checkout's. Real
// route, real app runtime; only the sandbox is replaced.
import { OpenAPIHono } from "@hono/zod-openapi";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredPlugin } from "@scalius/core/modules/plugins";

const mocks = vi.hoisted(() => ({
  registrations: [] as unknown[],
  invokeFunction: (() => undefined) as (...args: unknown[]) => unknown,
}));

vi.mock("@scalius/core/modules/plugins", async (importOriginal) => ({
  ...await importOriginal<typeof import("@scalius/core/modules/plugins")>(),
  listActiveCheckoutRegistrations: async () => mocks.registrations,
}));
vi.mock("../../plugins/host", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../plugins/host")>(),
  PluginHost: class {
    invokeFunction(...args: unknown[]) { return mocks.invokeFunction(...args); }
    async incident() { return undefined; }
  },
}));

import { getDb } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { STOREFRONT_UI_SLOTS, storefrontUiSlotsOn, type StorefrontUiSlot } from "@scalius/shared/plugins/storefront-protocol";
import { errorResponseFromError } from "../../utils/api-response";
import { PLUGIN_TEST_CREDENTIAL_KEY } from "../../plugins/testing/fixtures";
import { orderRoutes } from "./index";

const ENV = {
  JWT_SECRET: "buyer-ui-slots-secret-0123456789abcdef",
  SCALIUS_SECRET: "buyer-ui-slots-master-secret-0123456789abcdefghijklmnop",
  CREDENTIAL_ENCRYPTION_KEY: PLUGIN_TEST_CREDENTIAL_KEY,
  PUBLIC_API_BASE_URL: "https://api.shop.test",
  STOREFRONT_URL: "https://shop.test",
  CUSTOMER_SESSION_HASH_KEY: "buyer-ui-slots-session-key-0123456789abcdef",
};

/** An app with an extension at every UI slot, approved for all of them. */
function everySlotApp(): RegisteredPlugin {
  const extensions = STOREFRONT_UI_SLOTS.map((target) => ({ target, reads: [] }));
  return {
    name: "buyer.ui", priority: 100, kind: "function",
    installation: {
      pluginId: "test.slots", status: "active", bundleSha256: "a".repeat(64),
      grant: { functions: [], blockingFunctions: [], extensions: [...STOREFRONT_UI_SLOTS] },
      manifest: {
        id: "test.slots", name: "Slots", objects: {}, functions: [],
        storefront: { proxy: false, extensions }, routes: { public: [] },
      },
    },
  } as unknown as RegisteredPlugin;
}

describe("buyer UI slots on the cart check and the checkout quote", () => {
  let sqlite: DatabaseSync;
  let binding: D1Database;
  let asked: StorefrontUiSlot[];

  beforeEach(() => {
    ({ sqlite, binding } = createSqliteD1Database());
    sqlite.exec(`
      INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active)
      VALUES ('city_1', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1), ('zone_1', 'Gulshan', 'BD', 2, 'city_1', '{}', '{}', 1);
      INSERT INTO delivery_zones (id, name) VALUES ('dz_bd', 'Bangladesh'); INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('BD', 'dz_bd');
      INSERT INTO shipping_methods (id, name, fee_minor, kind, zone_id) VALUES ('m_std', 'Standard', 6000, 'delivery', 'dz_bd');
      INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('p_tea', 'Assam tea', 'assam-tea', 50000, 1);
      INSERT INTO product_variants
        (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
      VALUES ('v_tea', 'p_tea', 'TEA-250', 50000, 500, 0, 0, 1, 1, 'physical');
    `);
    asked = [];
    mocks.registrations = [everySlotApp()];
    mocks.invokeFunction = async (_installation: unknown, _point: unknown, input: unknown) => {
      const { target } = input as { target: StorefrontUiSlot };
      asked.push(target);
      return { ok: true, value: { ui: { version: 1, root: { type: "text", text: `At ${target}` } } } };
    };
  });
  afterEach(() => sqlite.close());

  async function post(path: string, body: unknown) {
    const env = { ...ENV, DB: binding } as unknown as Env;
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
    app.onError((error, c) => {
      const { body: errorBody, status } = errorResponseFromError(error);
      return c.json(errorBody, status);
    });
    app.use("*", async (c, next) => { c.set("db", getDb(env)); await next(); });
    app.route("/orders", orderRoutes);
    const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined };
    const response = await app.request(`/api/v1${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-storefront-language": "en", "x-storefront-locale": "en-BD" },
      body: JSON.stringify(body),
    }, env, ctx as never);
    const json = await response.json() as { success: boolean; data: { buyerUi: Array<{ target: string; appId: string; ui: { text?: string } }> } };
    return { status: response.status, json };
  }

  it("the cart check answers the cart page's slots and the cart drawer's footer", async () => {
    const { status, json } = await post("/orders/cart-validation", { items: [{ productId: "p_tea", variantId: "v_tea", quantity: 1, price: 500 }] });
    expect(status).toBe(200);
    const targets = json.data.buyerUi.map((block) => block.target);
    expect(targets).toEqual([...storefrontUiSlotsOn("checkout"), ...storefrontUiSlotsOn("cart_drawer")]);
    expect(targets).toEqual(expect.arrayContaining(["cart.page.below", "cart_drawer.footer"]));
    expect(json.data.buyerUi.find((block) => block.target === "cart_drawer.footer")).toMatchObject({ appId: "test.slots", ui: { type: "text", text: "At cart_drawer.footer" } });
    // Order and account slots are not this page's: the app is never asked for them.
    expect(asked).not.toContain("order.confirmation");
    expect(asked).not.toContain("account.overview");
  });

  it("an app without a drawer extension is not run there, and the answer has no drawer block", async () => {
    const app = everySlotApp();
    const manifest = app.installation.manifest as unknown as { storefront: { extensions: Array<{ target: string }> } };
    manifest.storefront.extensions = manifest.storefront.extensions.filter((extension) => extension.target !== "cart_drawer.footer");
    mocks.registrations = [app];
    const { json } = await post("/orders/cart-validation", { items: [{ productId: "p_tea", variantId: "v_tea", quantity: 1, price: 500 }] });
    expect(asked).not.toContain("cart_drawer.footer");
    expect(json.data.buyerUi.map((block) => block.target)).not.toContain("cart_drawer.footer");
  });

  it("the checkout quote answers checkout's slots (the payment step's summary included), never the drawer's", async () => {
    const { status, json } = await post("/orders/tax-quote", {
      items: [{ productId: "p_tea", variantId: "v_tea", quantity: 1 }],
      city: "city_1", zone: "zone_1", shippingMethodId: "m_std", discountCodes: [],
    });
    expect(status).toBe(200);
    const targets = json.data.buyerUi.map((block) => block.target);
    expect(targets).toEqual(storefrontUiSlotsOn("checkout"));
    expect(targets).toEqual(expect.arrayContaining(["checkout.summary.after", "cart.page.below"]));
    expect(asked).not.toContain("cart_drawer.footer");
  });
});
