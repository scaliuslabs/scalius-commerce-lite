// Purchase options on the online store (final audit I4), on the migrated
// schema with the real `acme.subscriptions` app, which has a payment provider
// and no checkout function: checkout accepts its option (it used to read
// options from function registrations only, so this app's option was
// refused), the layout read lists the same options (so the product page's
// buy form offers exactly those), an app whose options nothing would read is
// refused at install, and a storefront line bought under the option is placed
// as its own line, frozen as `_purchase_option`, the property the payment
// session reads to keep the buyer's card.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bundled.gen", async (importOriginal) => (await import("./testing/fixture-apps")).withFixtureApps(await importOriginal()));
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { activatePlugin, installPlugin, listActiveCheckoutRegistrations, listActiveFunctionRegistrations } from "@scalius/core/modules/plugins";
import { getLayoutData } from "@scalius/core/modules/storefront";
import {
  buildCheckoutAttemptIdentity,
  checkoutPurchaseOptions,
  commitStorefrontOrderPayload,
  createAtomicCheckoutAttempt,
  createStorefrontOrder,
  createTrustedStorefrontCheckoutPolicySnapshot,
  loadStorefrontCheckoutAuthority,
  validateStorefrontCartItems,
} from "@scalius/core/modules/checkout";
import type { CreateStorefrontOrderInput } from "@scalius/core/modules/orders";
import { readLinePurchaseOption } from "@scalius/shared/line-properties";
import { PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/shared/plugins";
import { BUNDLED_PLUGINS } from "./bundled.gen";
import { createCheckoutAppFunctions } from "./checkout-functions";
import { pluginTestCtx, pluginTestEnv } from "./testing/fixtures";
import { SUBSCRIBE_OPTION, manifest as subscriptionsManifest } from "./testing/apps/subscriptions/src/index";

describe("purchase options on the online store (acme.subscriptions)", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let env: Env;

  beforeEach(async () => {
    let binding: D1Database;
    ({ sqlite, db, binding } = createSqliteD1Database());
    env = pluginTestEnv(binding);
    sqlite.exec(`
      INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1);
      INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active)
      VALUES ('city_1', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1), ('zone_1', 'Gulshan', 'BD', 2, 'city_1', '{}', '{}', 1);
      INSERT INTO delivery_zones (id, name) VALUES ('dz_bd', 'Bangladesh'); INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('BD', 'dz_bd');
      INSERT INTO shipping_methods (id, name, fee_minor, kind, sort_order, zone_id) VALUES ('m_std', 'Standard', 6000, 'delivery', 0, 'dz_bd');
      INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('p_coffee', 'Coffee beans', 'coffee-beans', 120000, 1);
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
      VALUES ('v_coffee', 'p_coffee', 'COFFEE-1', 120000, 50, 0, 0, 1, 1, 'physical');
    `);
    const installed = await installPlugin(db, {
      manifest: subscriptionsManifest, source: "bundled", bundleSha256: BUNDLED_PLUGINS["acme.subscriptions"]!.sha256, actorUserId: "owner",
    });
    await activatePlugin(db, "acme.subscriptions", { actorUserId: "owner", expectedRevision: installed.revision });
  });
  afterEach(() => sqlite.close());

  /** What the storefront checkout routes build: the checkout registrations (functions and payment providers). */
  async function checkoutApps() {
    return createCheckoutAppFunctions({ env, ctx: pluginTestCtx(), db, registrations: await listActiveCheckoutRegistrations(db), loaderFor: () => { throw new Error("no app code runs here"); } });
  }

  it("offers the options checkout accepts in the layout read, and refuses an app whose options nothing reads", async () => {
    // No function and no payment provider: checkout would never read the option.
    const idle: PluginManifestInput = {
      id: "acme.idle", name: "Idle", version: "1.0.0", apiVersion: PLUGIN_API_VERSION, description: "Declares an option and nothing that reads it.",
      author: { name: "Test" }, checkout: { purchaseOptions: [{ key: "rent", title: "Rent it" }] },
    };
    await expect(installPlugin(db, { manifest: idle, source: "upload", bundleSha256: "5".repeat(64), actorUserId: "owner" }))
      .rejects.toThrow(/Purchase options need a checkout function/);

    const layout = await getLayoutData(db);
    expect(layout.purchaseOptions).toEqual([{
      id: SUBSCRIBE_OPTION,
      title: "Subscribe and save",
      description: "Delivered again every month; cancel any time.",
    }]);
    // The buy form offers exactly what checkout takes.
    expect([...checkoutPurchaseOptions(await checkoutApps()).keys()]).toEqual(layout.purchaseOptions!.map((option) => option.id));
    expect(await listActiveFunctionRegistrations(db)).toEqual([]);
  });

  it("places a storefront line under the option as its own line, frozen for the payment session", async () => {
    const apps = await checkoutApps();
    const data: CreateStorefrontOrderInput = {
      checkoutRequestId: `request_${crypto.randomUUID()}`,
      expectedQuoteFingerprint: "taxq_unused_in_core_tests0",
      customerName: "Rahima", customerPhone: "+8801712345678", customerEmail: null,
      shippingAddress: "House 1, Road 2, Gulshan", city: "city_1", zone: "zone_1", area: null, notes: null,
      discountCodes: [], shippingCharge: 0, shippingMethodId: "m_std", paymentMethod: "cod", inventoryPool: "regular",
      items: [
        { productId: "p_coffee", variantId: "v_coffee", quantity: 1, price: 1200 },
        { productId: "p_coffee", variantId: "v_coffee", quantity: 2, price: 1200, purchaseOption: SUBSCRIBE_OPTION },
      ],
    };
    const read = await loadStorefrontCheckoutAuthority(db, {
      items: data.items, inventoryPool: data.inventoryPool, city: data.city, zone: data.zone, area: data.area,
      shippingMethodId: data.shippingMethodId, customerPhone: data.customerPhone,
      purchaseOptions: () => checkoutPurchaseOptions(apps),
    });
    // The same SKU one-time and subscribed are two lines.
    expect(read.cartValidation.items.map((item) => [item.quantity, item.purchaseOption ?? null])).toEqual([
      [1, null],
      [2, { id: SUBSCRIBE_OPTION, title: "Subscribe and save" }],
    ]);
    const attempt = createAtomicCheckoutAttempt(await buildCheckoutAttemptIdentity(data));
    const result = await createStorefrontOrder(
      db, data, "https://shop.test/api/v1/orders",
      { orderId: attempt.orderId, checkoutToken: attempt.checkoutToken },
      read.cartValidation, read.deliveryPreflight, undefined, { code: "BDT", decimalPlaces: 2, priceIncrementMinor: 100 },
      createTrustedStorefrontCheckoutPolicySnapshot({
        partialPaymentEnabled: false, authorityRevision: read.authorityRevision,
        orderCreatedNotificationEnabled: false, metaPurchaseEnabled: false,
      }),
      read.taxAuthority, {}, { apps, channel: "online_store" },
    );
    await commitStorefrontOrderPayload(db, result.commitPayload, { attempt, response: { orderId: result.orderId } });
    // What the payment session reads back to ask the provider to keep the buyer's card.
    const lines = sqlite.prepare("SELECT quantity, properties FROM order_items WHERE order_id = ? ORDER BY quantity").all(result.orderId) as Array<{ quantity: number; properties: string | null }>;
    expect(lines.map((line) => [line.quantity, readLinePurchaseOption(line.properties)])).toEqual([[1, null], [2, SUBSCRIBE_OPTION]]);

    // Once no app offers it, the line is refused, never bought one-time.
    const refused = await validateStorefrontCartItems(db, [
      { productId: "p_coffee", variantId: "v_coffee", quantity: 1, price: 1200, purchaseOption: SUBSCRIBE_OPTION },
    ], { currencyCode: "BDT", priceIncrementMinor: 100, purchaseOptions: new Map() });
    expect(refused.issues).toEqual([expect.objectContaining({ code: "purchase_option_unavailable", action: "remove" })]);
  });
});
