// `cart.transform` end to end on the real migrated schema: an app expands a
// bundle SKU into its component SKUs (stock is reserved on the components,
// the order lines carry the bundle, the buyer sees one bundle line priced as
// its components) and merges lines into a bundle; a component priced by
// `cart.line_prices` sells the bundle at its price; the checkout reads path
// (the order route's) rewrites the lines in a second read and checks the
// buyer's bundle price; unknown lines, gift cards, lines with buyer inputs
// and unknown SKUs are skipped and logged; a blocking app stops checkout;
// a store without such an app reads nothing more.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { activatePlugin, installPlugin, listActiveFunctionRegistrations, listPluginLogs } from "@scalius/core/modules/plugins";
import {
  applyCartTransform,
  buildCheckoutAttemptIdentity,
  commitStorefrontOrderPayload,
  createAppLinePricer,
  createAtomicCheckoutAttempt,
  createCartTransformer,
  createStorefrontOrder,
  createTrustedStorefrontCheckoutPolicySnapshot,
  loadStorefrontCheckoutReads,
  presentTransformedCartLines,
  validateStorefrontCartItems,
  type CheckoutAppFunctions,
} from "@scalius/core/modules/checkout";
import type { CreateStorefrontOrderInput } from "@scalius/core/modules/orders";
import { PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/shared/plugins";
import type { PluginInvocationResult } from "@scalius/plugin-sdk/runtime";
import type { PluginLoader } from "./loaders/types";
import { createCheckoutAppFunctions } from "./checkout-functions";
import { pluginTestCtx, pluginTestEnv } from "./testing/fixtures";

const ok = (value: unknown): PluginInvocationResult => ({ ok: true, value, error: null, logs: [], droppedLogs: 0 });
const failed = (message: string): PluginInvocationResult => ({ ok: false, value: null, error: { code: null, message }, logs: [], droppedLogs: 0 });

describe("cart.transform (real schema, test apps)", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let env: Env;
  let queries: string[];
  let answers: Record<string, (point: string, input: Record<string, unknown>) => PluginInvocationResult>;

  beforeEach(() => {
    queries = [];
    ({ sqlite, db } = createSqliteD1Database({ onQuery: (query) => queries.push(query) }));
    env = pluginTestEnv(undefined as unknown as D1Database);
    answers = {};
    sqlite.exec(`
      INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1);
      INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active)
      VALUES ('city_1', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1), ('zone_1', 'Gulshan', 'BD', 2, 'city_1', '{}', '{}', 1);
      INSERT INTO delivery_zones (id, name) VALUES ('dz_bd', 'Bangladesh'); INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('BD', 'dz_bd');
      INSERT INTO shipping_methods (id, name, fee_minor, kind, sort_order, zone_id) VALUES ('m_std', 'Standard', 6000, 'delivery', 0, 'dz_bd');
      INSERT INTO products (id, name, slug, price_minor, is_active) VALUES
        ('p_box', 'Tea gift box', 'tea-gift-box', 90000, 1),
        ('p_tea', 'Assam tea', 'assam-tea', 50000, 1),
        ('p_mug', 'Mug', 'mug', 30000, 1);
      INSERT INTO product_variants
        (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
      VALUES
        ('v_box', 'p_box', 'BOX-1', 90000, 0, 0, 0, 1, 0, 'physical'),
        ('v_tea', 'p_tea', 'TEA-250', 50000, 100, 0, 0, 1, 1, 'physical'),
        ('v_mug', 'p_mug', 'MUG-1', 30000, 100, 0, 0, 1, 1, 'physical');
    `);
  });
  afterEach(() => sqlite.close());

  function loaderFor() {
    const fake: PluginLoader = {
      kind: "sandbox",
      async invoke({ installation, invocation }) {
        if (invocation.kind !== "function") return ok(null);
        const answer = answers[installation.pluginId];
        return answer ? answer(invocation.point, invocation.input as Record<string, unknown>) : ok(null);
      },
    };
    return () => fake;
  }

  async function apps(): Promise<CheckoutAppFunctions> {
    return createCheckoutAppFunctions({ env, ctx: pluginTestCtx(), db, registrations: await listActiveFunctionRegistrations(db), loaderFor: loaderFor() });
  }

  async function installApp(id: string, functions: PluginManifestInput["functions"]) {
    const manifest: PluginManifestInput = {
      id, name: `${id} app`, version: "1.0.0", apiVersion: PLUGIN_API_VERSION, description: "A bundle test app.",
      author: { name: "Test" }, functions, limits: { cpuMs: 50, wallMs: 100 },
    };
    await installPlugin(db, { manifest, source: "upload", bundleSha256: "5".repeat(64), actorUserId: "owner" });
    await activatePlugin(db, id, { actorUserId: "owner", expectedRevision: 1 });
  }

  /** A gift box (one SKU, no stock of its own) sold as two teas and a mug, at the box's price. */
  async function installBundles() {
    await installApp("acme.bundles", [{ point: "cart.transform" }, { point: "cart.line_prices" }]);
    answers["acme.bundles"] = (point, fn) => {
      const cart = fn.cart as { lines: Array<{ lineId: string; variantId: string; unitPriceMinor: number }> };
      if (point === "cart.transform") {
        const box = cart.lines.find((entry) => entry.variantId === "v_box");
        return ok({ operations: box ? [{ op: "expand", lineId: box.lineId, title: "Tea gift box", components: [{ variantId: "v_tea", quantity: 2 }, { variantId: "v_mug", quantity: 1 }] }] : [] });
      }
      // The box costs 900: the components share it (2 × 300 + 300).
      const lines = fn.lines as Array<{ lineId: string; bundle: { title: string } | null }>;
      return ok({ prices: lines.filter((entry) => entry.bundle?.title === "Tea gift box").map((entry) => ({
        lineId: entry.lineId,
        unitPriceMinor: 30_000,
      })) });
    };
  }

  type Line = CreateStorefrontOrderInput["items"][number];
  const line = (productId: string, variantId: string, quantity: number, price: number, cartKey?: string): Line => ({ productId, variantId, quantity, price, ...(cartKey ? { cartKey } : {}) });

  function input(items: Line[]): CreateStorefrontOrderInput {
    return {
      checkoutRequestId: `request_${crypto.randomUUID()}`,
      expectedQuoteFingerprint: "taxq_unused_in_core_tests0",
      customerName: "App Buyer",
      customerPhone: "+8801712345678",
      customerEmail: null,
      shippingAddress: "House 1, Road 2, Gulshan",
      city: "city_1",
      zone: "zone_1",
      area: null,
      notes: null,
      discountCodes: [],
      shippingCharge: 0,
      shippingMethodId: "m_std",
      paymentMethod: "cod",
      inventoryPool: "regular",
      items,
    };
  }

  const context = { channel: "online_store" as const };

  /** The order route's path: reads (rewritten in a second read), prepare, commit. */
  async function place(data: CreateStorefrontOrderInput) {
    const identity = await buildCheckoutAttemptIdentity(data);
    const reads = await loadStorefrontCheckoutReads(db, identity, {
      items: data.items, inventoryPool: data.inventoryPool, city: data.city, zone: data.zone, area: data.area,
      shippingMethodId: data.shippingMethodId, customerPhone: data.customerPhone,
    }, undefined, {
      apps: (registrations) => createCheckoutAppFunctions({ env, ctx: pluginTestCtx(), db, registrations, loaderFor: loaderFor() }),
      linePricer: (runner) => createAppLinePricer(db, runner, context),
      transformer: (runner) => createCartTransformer(db, runner, context),
    });
    return { reads, identity };
  }

  it("does nothing more without an app at the point: no transformer, one read", async () => {
    const transformer = createCartTransformer(db, await apps(), context);
    expect(transformer).toBeUndefined();
    const items = [line("p_tea", "v_tea", 1, 500)];
    queries = [];
    await validateStorefrontCartItems(db, items, { currencyCode: "BDT", priceIncrementMinor: 100, transformer });
    const count = queries.length;
    queries = [];
    await validateStorefrontCartItems(db, items, { currencyCode: "BDT", priceIncrementMinor: 100 });
    expect(queries.length).toBe(count);
  });

  it("expands a bundle into its components; the buyer sees one bundle line priced as its components", async () => {
    await installBundles();
    const runner = await apps();
    const buyerLines = [line("p_box", "v_box", 2, 900, "box"), line("p_mug", "v_mug", 1, 300, "mug")];
    const result = await validateStorefrontCartItems(db, buyerLines, {
      currencyCode: "BDT", priceIncrementMinor: 100,
      linePricer: createAppLinePricer(db, runner, context),
      transformer: createCartTransformer(db, runner, context),
    });
    expect(result.items.map((item) => [item.variantId, item.quantity, item.unitPriceMinor, item.sourceIndex, item.bundle?.title ?? null])).toEqual([
      ["v_tea", 4, 30_000, 0, "Tea gift box"],
      ["v_mug", 2, 30_000, 0, "Tea gift box"],
      ["v_mug", 1, 30_000, 1, null],
    ]);
    const view = presentTransformedCartLines(result, result.transform!, buyerLines);
    expect(view.cart.valid).toBe(true);
    expect(view.cart.items.map((item) => [item.index, item.variantId, item.quantity, item.unitPriceMinor, item.productName, item.availableQuantity])).toEqual([
      [0, "v_box", 2, 90_000, "Tea gift box", 50],
      [1, "v_mug", 1, 30_000, "Mug", 100],
    ]);
    expect(view.positions).toEqual([0, 2]);
    // A buyer who saw another bundle price is asked to refresh it.
    const stale = presentTransformedCartLines(result, result.transform!, [line("p_box", "v_box", 2, 950, "box"), buyerLines[1]!]);
    expect(stale.cart.issues).toEqual([expect.objectContaining({ index: 0, code: "PRICE_CHANGED", currentPrice: 900, cartKey: "box" })]);
  });

  it("orders the components through the order route's reads: stock on the components, the bundle on each line", async () => {
    await installBundles();
    const data = input([line("p_box", "v_box", 1, 900, "box")]);
    const { reads, identity } = await place(data);
    expect(reads.transform?.items.map((item) => item.variantId)).toEqual(["v_tea", "v_mug"]);
    const authority = reads.authority();
    const attempt = createAtomicCheckoutAttempt(identity);
    const result = await createStorefrontOrder(
      db, { ...data, items: reads.transform!.items.map((item) => ({ productId: item.productId, variantId: item.variantId, quantity: item.quantity, cartKey: item.cartKey ?? undefined })) },
      "https://shop.test/api/v1/orders", { orderId: attempt.orderId, checkoutToken: attempt.checkoutToken },
      authority.cartValidation, authority.deliveryPreflight, undefined, { code: "BDT", decimalPlaces: 2, priceIncrementMinor: 100 },
      createTrustedStorefrontCheckoutPolicySnapshot({
        partialPaymentEnabled: false, authorityRevision: authority.authorityRevision,
        orderCreatedNotificationEnabled: false, metaPurchaseEnabled: false,
      }),
      authority.taxAuthority, {}, { apps: reads.apps, channel: "online_store" },
    );
    await commitStorefrontOrderPayload(db, result.commitPayload, { attempt, response: { orderId: result.orderId } });
    expect(result.taxQuote.subtotalMinor).toBe(90_000);
    const lines = sqlite.prepare("SELECT variant_id AS variant, quantity, unit_price_minor AS unit, properties FROM order_items WHERE order_id = ? ORDER BY variant_id").all(result.orderId) as Array<{ variant: string; quantity: number; unit: number; properties: string }>;
    expect(lines.map((entry) => [entry.variant, entry.quantity, entry.unit])).toEqual([["v_mug", 1, 30_000], ["v_tea", 2, 30_000]]);
    expect(JSON.parse(lines[0]!.properties)).toEqual([{ key: "_bundle", type: "text", label: "Bundle", value: "Tea gift box", displayValue: "Tea gift box", priceMinor: 0 }]);
    // Stock moved on the components; the box itself has none to move.
    expect(sqlite.prepare("SELECT id, reserved_stock AS reserved FROM product_variants ORDER BY id").all()).toEqual([
      { id: "v_box", reserved: 0 }, { id: "v_mug", reserved: 1 }, { id: "v_tea", reserved: 2 },
    ]);
  });

  it("refuses an order whose bundle price the buyer did not see, on the buyer's line", async () => {
    await installBundles();
    const { reads } = await place(input([line("p_box", "v_box", 1, 950, "box")]));
    expect(() => reads.authority()).toThrow(expect.objectContaining({
      details: { itemIssues: [expect.objectContaining({ index: 0, code: "PRICE_CHANGED", currentPrice: 900 })] },
    }));
  });

  it("merges lines into one bundle on the order, prices unchanged", async () => {
    await installApp("acme.merge", [{ point: "cart.transform" }]);
    answers["acme.merge"] = (_point, fn) => {
      const cart = fn.cart as { lines: Array<{ lineId: string }> };
      return ok({ operations: [{ op: "merge", lineIds: cart.lines.map((entry) => entry.lineId), title: "Tea set" }] });
    };
    const runner = await apps();
    const result = await validateStorefrontCartItems(db, [line("p_tea", "v_tea", 1, 500), line("p_mug", "v_mug", 1, 300)], {
      currencyCode: "BDT", priceIncrementMinor: 100, transformer: createCartTransformer(db, runner, context),
    });
    expect(result.items.map((item) => [item.unitPriceMinor, item.bundle])).toEqual([
      [50_000, { id: "cart:0:v_tea", title: "Tea set", kind: "merge" }],
      [30_000, { id: "cart:0:v_tea", title: "Tea set", kind: "merge" }],
    ]);
    expect(presentTransformedCartLines(result, result.transform!, []).cart.subtotalMinor).toBe(80_000);
  });

  it("skips what it cannot do, logged: unknown lines and SKUs, a line twice, gift cards, buyer inputs, too many lines", () => {
    const reports: string[] = [];
    const valid = [
      { index: 0, isGiftCard: false, productName: "Box", variantLabel: null, properties: [] },
      { index: 1, isGiftCard: true, productName: "Card", variantLabel: null, properties: [] },
      { index: 2, isGiftCard: false, productName: "Mug", variantLabel: null, properties: [{ key: "name", type: "text" as const, label: "Name", value: "A", displayValue: "A", priceMinor: 0 }] },
    ];
    const lineIds = ["cart:0:v_box", "cart:1:v_card", "cart:2:v_mug"];
    const items = [
      { productId: "p_box", variantId: "v_box", quantity: 1 },
      { productId: "p_card", variantId: "v_card", quantity: 1 },
      { productId: "p_mug", variantId: "v_mug", quantity: 1 },
    ];
    const result = applyCartTransform(items, valid, lineIds, [{
      pluginId: "acme.bundles",
      output: { operations: [
        { op: "expand", lineId: "cart:9:v_none", components: [{ variantId: "v_tea", quantity: 1 }] },
        { op: "expand", lineId: "cart:0:v_box", components: [{ variantId: "v_gone", quantity: 1 }] },
        { op: "expand", lineId: "cart:1:v_card", components: [{ variantId: "v_tea", quantity: 1 }] },
        { op: "expand", lineId: "cart:2:v_mug", components: [{ variantId: "v_tea", quantity: 1 }] },
        { op: "expand", lineId: "cart:0:v_box", components: [{ variantId: "v_tea", quantity: 1 }, { variantId: "v_tea", quantity: 2 }] },
        { op: "merge", lineIds: ["cart:0:v_box", "cart:2:v_mug"], title: "Again" },
      ] },
    }], new Map([["v_tea", "p_tea"]]), { report: (_plugin, _point, message) => reports.push(message) });
    // The one valid expansion: the same SKU twice becomes one line of 3.
    expect(result?.items.map((item) => [item.variantId, item.quantity, item.sourceIndex])).toEqual([["v_tea", 3, 0], ["v_card", 1, 1], ["v_mug", 1, 2]]);
    expect(reports).toEqual([
      "Operation expand names line cart:9:v_none, which is not in the cart. It was skipped.",
      "Expand names SKU v_gone, which does not exist. It was skipped.",
      "Operation expand names a gift card, which is never bundled. It was skipped.",
      "Expand names line cart:2:v_mug, which carries buyer inputs its components cannot keep. It was skipped.",
      "Operation merge names a line another operation already changed. It was skipped.",
    ]);
    const many = Array.from({ length: 99 }, (_, index) => ({ productId: "p", variantId: `v${index}`, quantity: 1 }));
    expect(applyCartTransform(many, [{ index: 0, isGiftCard: false, productName: "Box", variantLabel: null, properties: [] }], ["cart:0:v0"], [{
      pluginId: "acme.bundles",
      output: { operations: [{ op: "expand", lineId: "cart:0:v0", components: [{ variantId: "v_tea", quantity: 1 }, { variantId: "v_mug", quantity: 1 }] }] },
    }], new Map([["v_tea", "p_tea"], ["v_mug", "p_mug"]]))).toBeNull();
  });

  it("fails open on a throw and stops checkout when the app blocks", async () => {
    await installApp("acme.flaky", [{ point: "cart.transform" }]);
    answers["acme.flaky"] = () => failed("TypeError: boom");
    const lines = [line("p_tea", "v_tea", 1, 500)];
    const open = await validateStorefrontCartItems(db, lines, { currencyCode: "BDT", priceIncrementMinor: 100, transformer: createCartTransformer(db, await apps(), context) });
    expect(open.transform).toBeUndefined();
    expect(open.items.map((item) => item.variantId)).toEqual(["v_tea"]);
    expect((await listPluginLogs(db, "acme.flaky")).map((entry) => entry.message).join(" ")).toContain("TypeError: boom");

    await installApp("acme.strict", [{ point: "cart.transform", onError: "block" }]);
    answers["acme.strict"] = () => failed("TypeError: down");
    await expect(validateStorefrontCartItems(db, lines, { currencyCode: "BDT", priceIncrementMinor: 100, transformer: createCartTransformer(db, await apps(), context) }))
      .rejects.toMatchObject({ details: { reason: "CHECKOUT_APP_UNAVAILABLE" } });
  });
});
