/**
 * The release store: a seeded store as v2.0.0-beta.8 left it (schema through
 * 0226), built through the service functions the API runs, frozen as a data
 * dump (`release-stores/<release>.sql`) and upgraded by every later migration
 * in release-upgrade.test.ts. Test-only.
 *
 * What it holds: a catalogue with an optioned product, SKUs with stock and a
 * category; a registered customer and a guest; an installed, active app
 * (`acme.protection`) that charges a protection-plan add-on through
 * `cart.line_prices` and keeps object records; a paid order carrying that
 * add-on, shipped and delivered, with a refund of one line; a guest's open
 * cash-on-delivery order holding reserved stock; a published theme
 * at document version 16 with private-page tokens and its compiled look.
 *
 * The catalogue, the payment row and the shipment rows are inserted as the
 * existing checkout tests insert them (their services call couriers and
 * gateways); the theme, the app, its records, the order and the refund go
 * through the services themselves.
 */
import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import {
  buildCheckoutAttemptIdentity,
  commitStorefrontOrderPayload,
  createAppLinePricer,
  createAtomicCheckoutAttempt,
  createStorefrontOrder,
  createTrustedStorefrontCheckoutPolicySnapshot,
  loadStorefrontCheckoutAuthority,
  type CheckoutAppFunctions,
} from "@scalius/core/modules/checkout";
import { putObjectRecord } from "@scalius/core/modules/objects";
import type { CreateStorefrontOrderInput } from "@scalius/core/modules/orders";
import { activatePlugin, installPlugin, listActiveFunctionRegistrations } from "@scalius/core/modules/plugins";
import { processRefund } from "@scalius/core/modules/payments";
import { publishThemeDraft, saveThemeDraft } from "@scalius/core/modules/settings";
import { createFakeGateway, FAKE_GATEWAY_ID } from "@scalius/core/testing";
import { objectTypeDeclarationSchema } from "@scalius/shared/plugins/objects";
import { PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/shared/plugins";
import { DEFAULT_STOREFRONT_THEME } from "@scalius/shared/storefront-theme";
import type { PluginInvocationResult } from "@scalius/plugin-sdk/runtime";

import { createCheckoutAppFunctions } from "../plugins/checkout-functions";
import type { PluginLoader } from "../plugins/loaders/types";
import { pluginTestCtx, pluginTestEnv } from "../plugins/testing/fixtures";

export const RELEASE_STORE = {
  release: "v2.0.0-beta.8",
  lastMigration: "0226_order_line_messages",
  /** The dump beside this file, relative to apps/api/src/testing. */
  dump: "release-stores/v2.0.0-beta.8.sql",
  app: "acme.protection",
  owner: "user_owner",
  paidOrderRequest: "release-store-order-1",
} as const;

export const PROTECTION_PLANS = objectTypeDeclarationSchema.parse({
  name: "Protection plans",
  fields: [
    { key: "title", name: "Title", type: "single_line_text" },
    { key: "months", name: "Months", type: "integer" },
    { key: "amount_minor", name: "Amount", type: "integer" },
  ],
});

const PROTECTION_MANIFEST: PluginManifestInput = {
  id: RELEASE_STORE.app,
  name: "Protection plans",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Adds a protection plan to garments.",
  author: { name: "Acme" },
  functions: [{ point: "cart.line_prices", priority: 100, onError: "skip" }],
  objects: { plans: PROTECTION_PLANS },
  limits: { cpuMs: 50, wallMs: 100 },
};

export const STORE_CURRENCY = { code: "BDT", decimalPlaces: 2, priceIncrementMinor: 100 } as const;

const ok = (value: unknown): PluginInvocationResult => ({ ok: true, value, error: null, logs: [], droppedLogs: 0 });

/** The app's answer: a ৳150 protection plan on every Linen Panjabi line. */
function protectionLoader(): () => PluginLoader {
  const loader: PluginLoader = {
    kind: "sandbox",
    async invoke({ invocation }) {
      if (invocation.kind !== "function") return ok(null);
      const cart = (invocation.input as { cart: { lines: Array<{ lineId: string; productId: string }> } }).cart;
      return ok({
        prices: [],
        addOns: cart.lines.filter((line) => line.productId === "p_linen").map((line) => ({ lineId: line.lineId, amountMinor: 15_000, title: "Protection plan, 12 months" })),
      });
    },
  };
  return () => loader;
}

/** The store's app functions as a checkout request builds them, with the protection app's answers. */
export async function storeAppFunctions(db: Database, binding: D1Database): Promise<CheckoutAppFunctions> {
  return createCheckoutAppFunctions({
    buyerRequest: null,
    env: pluginTestEnv(binding),
    ctx: pluginTestCtx(),
    db,
    registrations: await listActiveFunctionRegistrations(db),
    loaderFor: protectionLoader(),
  });
}

export type StoreLine = CreateStorefrontOrderInput["items"][number];

export function orderInput(checkoutRequestId: string, items: StoreLine[], buyer: { name: string; phone: string; email: string | null }): CreateStorefrontOrderInput {
  return {
    checkoutRequestId,
    expectedQuoteFingerprint: "taxq_unused_in_core_tests0",
    customerName: buyer.name,
    customerPhone: buyer.phone,
    customerEmail: buyer.email,
    shippingAddress: "House 1, Road 2, Gulshan",
    city: "city_1",
    zone: "zone_1",
    area: null,
    notes: null,
    discountCodes: [],
    shippingCharge: 60,
    shippingMethodId: "m_std",
    paymentMethod: "cod",
    inventoryPool: "regular",
    items,
  };
}

/** A buyer's checkout as the storefront order route runs it: authority read, order, commit. */
export async function placeStoreOrder(db: Database, binding: D1Database, data: CreateStorefrontOrderInput) {
  const apps = await storeAppFunctions(db, binding);
  const read = await loadStorefrontCheckoutAuthority(db, {
    items: data.items, inventoryPool: data.inventoryPool, city: data.city, zone: data.zone, area: data.area,
    shippingMethodId: data.shippingMethodId, customerPhone: data.customerPhone,
    linePricer: () => createAppLinePricer(db, apps, { channel: "online_store", customerId: null }),
  });
  const attempt = createAtomicCheckoutAttempt(await buildCheckoutAttemptIdentity(data));
  const result = await createStorefrontOrder(
    db, data, "https://shop.test/api/v1/orders",
    { orderId: attempt.orderId, checkoutToken: attempt.checkoutToken },
    read.cartValidation, read.deliveryPreflight, undefined, STORE_CURRENCY,
    createTrustedStorefrontCheckoutPolicySnapshot({
      partialPaymentEnabled: false, authorityFence: read.authorityFence,
      orderCreatedNotificationEnabled: false, metaPurchaseEnabled: false,
    }),
    read.taxAuthority, {}, { apps, channel: "online_store" },
  );
  await commitStorefrontOrderPayload(db, result.commitPayload, { attempt, response: { orderId: result.orderId } });
  return result;
}

function seedCatalogue(sqlite: DatabaseSync): void {
  sqlite.exec(`
    INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('${RELEASE_STORE.owner}', 'Owner', 'owner@shop.test', 1, 'admin', 1);
    INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active)
      VALUES ('city_1', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1), ('zone_1', 'Gulshan', 'BD', 2, 'city_1', '{}', '{}', 1);
    INSERT INTO delivery_zones (id, name) VALUES ('dz_bd', 'Bangladesh');
    INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('BD', 'dz_bd');
    INSERT INTO shipping_methods (id, name, fee_minor, kind, sort_order, zone_id) VALUES ('m_std', 'Standard', 6000, 'delivery', 0, 'dz_bd');
    INSERT INTO categories (id, name, slug, status) VALUES ('cat_panjabi', 'Panjabi', 'panjabi', 'published');
    INSERT INTO products (id, name, price_minor, slug, category_id, is_active) VALUES
      ('p_linen', 'Linen Panjabi', 250000, 'linen-panjabi', 'cat_panjabi', 1),
      ('p_cotton', 'Cotton Panjabi', 180000, 'cotton-panjabi', 'cat_panjabi', 1);
    INSERT INTO product_option_definitions (id, product_id, name, normalized_name, position) VALUES ('opt_size', 'p_linen', 'Size', 'size', 0);
    INSERT INTO product_option_values (id, option_definition_id, value, normalized_value, position) VALUES
      ('ov_m', 'opt_size', 'M', 'm', 0), ('ov_l', 'opt_size', 'L', 'l', 1);
    INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, option_combination_key, fulfillment_kind) VALUES
      ('v_linen_m', 'p_linen', 'LIN-M', 250000, 40, 0, 0, 0, 1, 'M', 'physical'),
      ('v_linen_l', 'p_linen', 'LIN-L', 250000, 25, 0, 0, 0, 1, 'L', 'physical'),
      ('v_cotton', 'p_cotton', 'COT-1', 180000, 60, 0, 0, 1, 1, NULL, 'physical');
    INSERT INTO product_variant_option_values (variant_id, option_definition_id, option_value_id) VALUES
      ('v_linen_m', 'opt_size', 'ov_m'), ('v_linen_l', 'opt_size', 'ov_l');
    INSERT INTO media (id, filename, kind, object_key, size, mime_type, status, width, height, variant_width) VALUES
      ('media_linen', 'linen.jpg', 'image', 'media/linen.jpg', 1, 'image/jpeg', 'ready', 1600, 1600, 1600);
    INSERT INTO product_media (id, product_id, media_id, is_primary, sort_order) VALUES ('pmed_linen', 'p_linen', 'media_linen', 1, 0);
    INSERT INTO customers (id, name, phone, email) VALUES ('cus_rahim', 'Rahim Uddin', '+8801712345601', 'rahim@shop.test');
  `);
}

/**
 * Builds the store on `sqlite` (a fresh `createReleaseSchema` at
 * RELEASE_STORE.lastMigration) through `db`. The caller makes the run
 * deterministic (seeded randomness, a fixed clock) before calling.
 * `advance(seconds)` moves that clock between merchant and buyer steps.
 */
export async function buildReleaseStore(sqlite: DatabaseSync, db: Database, binding: D1Database, advance: (seconds: number) => void): Promise<{ paidOrderId: string }> {
  seedCatalogue(sqlite);
  advance(3_600);

  // The merchant's theme: private-page tokens on the cart, compiled on save, then published.
  const theme = structuredClone(DEFAULT_STOREFRONT_THEME);
  theme.privatePages = { ...theme.privatePages, tokens: { cart: { summary: { radius: 0 } } } };
  const draft = await saveThemeDraft(db, theme, 0, 0, RELEASE_STORE.owner);
  await publishThemeDraft(db, 0, draft.revision, RELEASE_STORE.owner, "Launch look");
  advance(3_600);

  // The app: installed, active, with its records.
  await installPlugin(db, { manifest: PROTECTION_MANIFEST, source: "upload", bundleSha256: "7".repeat(64), actorUserId: RELEASE_STORE.owner });
  await activatePlugin(db, RELEASE_STORE.app, { actorUserId: RELEASE_STORE.owner, expectedRevision: 1 });
  await putObjectRecord(db, RELEASE_STORE.app, "plans", PROTECTION_PLANS, "plan_12m", { title: "Protection plan, 12 months", months: 12, amount_minor: 15_000 });
  await putObjectRecord(db, RELEASE_STORE.app, "plans", PROTECTION_PLANS, "plan_24m", { title: "Protection plan, 24 months", months: 24, amount_minor: 25_000 });
  advance(86_400);

  // The registered customer's order: two Linen Panjabis (each with the app's plan) and a Cotton one.
  const placed = await placeStoreOrder(db, binding, orderInput(RELEASE_STORE.paidOrderRequest, [
    { productId: "p_linen", variantId: "v_linen_m", quantity: 2, price: 2650 },
    { productId: "p_cotton", variantId: "v_cotton", quantity: 1, price: 1800 },
  ], { name: "Rahim Uddin", phone: "+8801712345601", email: "rahim@shop.test" }));
  const orderId = placed.orderId;
  advance(3_600);

  // Paid at a gateway, then shipped by a courier and delivered (as the checkout tests record them).
  sqlite.prepare(`UPDATE orders SET status = 'delivered', payment_method = ?, payment_status = 'paid',
    paid_amount_minor = total_amount_minor, balance_due_minor = 0 WHERE id = ?`).run(FAKE_GATEWAY_ID, orderId);
  sqlite.prepare(`INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status, provider_ref, provider_secondary_ref, created_at, updated_at)
    SELECT 'pay_release_1', id, total_amount_minor, currency_code, ?, 'full', 'succeeded', 'gw_release_1', 'txn_release_1', unixepoch(), unixepoch() FROM orders WHERE id = ?`).run(FAKE_GATEWAY_ID, orderId);
  advance(86_400);
  sqlite.prepare("INSERT INTO order_fulfillments (id, order_id, kind, request_key, actor_type) VALUES ('ful_release_1', ?, 'ship', 'shipped-release-1', 'admin')").run(orderId);
  const lines = sqlite.prepare("SELECT id, quantity FROM order_items WHERE order_id = ? ORDER BY id").all(orderId) as Array<{ id: string; quantity: number }>;
  for (const [index, line] of lines.entries()) {
    sqlite.prepare("INSERT INTO order_fulfillment_lines (id, fulfillment_id, order_id, order_item_id, quantity) VALUES (?, 'ful_release_1', ?, ?, ?)").run(`fln_release_${index}`, orderId, line.id, line.quantity);
  }
  sqlite.prepare(`INSERT INTO delivery_shipments (id, order_id, provider_type, tracking_id, courier_name, status, is_final_shipment, created_at, updated_at)
    VALUES ('shp_release_1', ?, 'manual', 'TRK-1001', 'Acme Courier', 'delivered', 1, unixepoch(), unixepoch())`).run(orderId);
  sqlite.exec("UPDATE product_variants SET stock = stock - reserved_stock, reserved_stock = 0 WHERE id IN ('v_linen_m', 'v_cotton')");
  advance(86_400);

  // The buyer returns the Cotton Panjabi's money: one line refunded through the gateway.
  const cotton = sqlite.prepare("SELECT id, unit_price_minor FROM order_items WHERE order_id = ? AND variant_id = 'v_cotton'").get(orderId) as { id: string; unit_price_minor: number };
  await processRefund(db, {
    orderId, amountMinor: cotton.unit_price_minor, reason: "requested_by_customer", requestKey: "release-store-refund-1",
    lines: [{ orderItemId: cotton.id, quantity: 1 }],
  }, undefined, createFakeGateway().providers);
  advance(3_600);

  // A guest's cash-on-delivery order, still open: its stock stays reserved across the upgrade.
  await placeStoreOrder(db, binding, orderInput("release-store-order-2", [
    { productId: "p_linen", variantId: "v_linen_l", quantity: 1, price: 2650 },
  ], { name: "Salma Khatun", phone: "+8801712345602", email: null }));
  advance(3_600);
  return { paidOrderId: orderId };
}
