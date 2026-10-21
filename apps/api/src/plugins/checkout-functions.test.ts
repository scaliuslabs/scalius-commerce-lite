// Checkout app functions end to end on the real migrated schema: the bundled
// acme.bulk-discount (its real code through the bundled loader) prices and
// blocks a checkout; test apps (a fake loader) adjust delivery options and
// payment methods, rate risk, and misbehave. Proves the stacking rules
// against a platform promotion, the order's `app_discount` facts, refund
// reconciliation, the dashboard's discount lines and risk checks, fail-open
// on throw/timeout/invalid output, per-request memoization, and that a store
// with no app does no app work.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bundled.gen", async (importOriginal) => (await import("./testing/fixture-apps")).withFixtureApps(await importOriginal()));
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
  activatePlugin,
  installPlugin,
  listActiveFunctionRegistrations,
  listPluginLogs,
  writePluginSettings,
} from "@scalius/core/modules/plugins";
import {
  assertStorefrontAppPaymentMethod,
  buildCheckoutAttemptIdentity,
  checkoutPurchaseOptions,
  commitStorefrontOrderPayload,
  createAtomicCheckoutAttempt,
  createStorefrontOrder,
  createTrustedStorefrontCheckoutPolicySnapshot,
  loadStorefrontCheckoutAuthority,
  checkStorefrontCartRules,
  priceStorefrontCheckout,
  resolveAppPaymentMethods,
  type CheckoutAppFunctions,
} from "@scalius/core/modules/checkout";
import {
  activatePromotion,
  createPromotionDraft,
  createPromotionDraftSchema,
  listOrderDiscountLines,
  readPromotionRefundSnapshot,
} from "@scalius/core/modules/promotions";
import { getOrderDetails, listOrderTimeline } from "@scalius/core/modules/orders";
import type { CreateStorefrontOrderInput } from "@scalius/core/modules/orders";
import { PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/shared/plugins";
import type { PluginInvocationResult } from "@scalius/plugin-sdk/runtime";
import { BUNDLED_PLUGINS } from "./bundled.gen";
import { BundledLoader } from "./loaders/bundled";
import type { PluginLoader } from "./loaders/types";
import { createCheckoutAppFunctions } from "./checkout-functions";
import { PLUGIN_TEST_CREDENTIAL_KEY, pluginTestCtx, pluginTestEnv } from "./testing/fixtures";
import { manifest as bulkManifest } from "./testing/apps/bulk-discount/src/index";

const ok = (value: unknown): PluginInvocationResult => ({ ok: true, value, error: null, logs: [], droppedLogs: 0 });

describe("checkout app functions (real schema, bundled and test apps)", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let env: Env;
  let queries: string[];
  /** What each test app answers, by plugin id and point. */
  let answers: Record<string, (point: string, input: Record<string, unknown>) => Promise<PluginInvocationResult> | PluginInvocationResult>;
  let fakeCalls: Array<{ pluginId: string; point: string }>;

  beforeEach(() => {
    queries = [];
    ({ sqlite, db } = createSqliteD1Database({ onQuery: (query) => queries.push(query) }));
    env = pluginTestEnv(undefined as unknown as D1Database);
    answers = {};
    fakeCalls = [];
    sqlite.exec(`
      INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1);
      INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active)
      VALUES ('city_1', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1), ('zone_1', 'Gulshan', 'BD', 2, 'city_1', '{}', '{}', 1);
      INSERT INTO delivery_zones (id, name) VALUES ('dz_bd', 'Bangladesh'); INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('BD', 'dz_bd'); 
      INSERT INTO shipping_methods (id, name, fee_minor, kind, sort_order, zone_id) VALUES
        ('m_std', 'Standard', 6000, 'delivery', 0, 'dz_bd'), ('m_exp', 'Express', 12000, 'delivery', 1, 'dz_bd');
      INSERT INTO shipping_methods (id, name, fee_minor, kind, pickup_address, pickup_hours, sort_order)
      VALUES ('m_pick', 'Store pickup', 0, 'pickup', 'Shop 4, Gulshan 1', '10am-8pm', 2);
      INSERT INTO categories (id, name, slug, status) VALUES ('cat_tea', 'Tea', 'tea', 'published');
      INSERT INTO products (id, name, slug, price_minor, is_active, category_id) VALUES
        ('p_tea', 'Assam tea', 'assam-tea', 50000, 1, 'cat_tea'),
        ('p_mug', 'Mug', 'mug', 30000, 1, NULL);
      INSERT INTO product_variants
        (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
      VALUES
        ('v_tea', 'p_tea', 'TEA-250', 50000, 500, 0, 0, 1, 1, 'physical'),
        ('v_mug', 'p_mug', 'MUG-1', 30000, 500, 0, 0, 1, 1, 'physical');
    `);
  });
  afterEach(() => sqlite.close());

  const one = <T = Record<string, unknown>>(query: string, ...params: Array<string | number>) =>
    sqlite.prepare(query).get(...params) as T;

  /** The real bulk-discount code for the bundled install; scripted answers for test apps. */
  function loaderFor() {
    const bundled = new BundledLoader({ env, ctx: pluginTestCtx(), db: () => db, composedEnv: async () => env });
    const fake: PluginLoader = {
      kind: "sandbox",
      async invoke({ installation, invocation }) {
        if (invocation.kind !== "function") return ok(null);
        fakeCalls.push({ pluginId: installation.pluginId, point: invocation.point });
        const answer = answers[installation.pluginId];
        return answer ? answer(invocation.point, invocation.input as Record<string, unknown>) : ok(null);
      },
    };
    return (installation: { source: string }) => (installation.source === "bundled" ? bundled : fake);
  }

  async function apps(): Promise<CheckoutAppFunctions> {
    return createCheckoutAppFunctions({ env, ctx: pluginTestCtx(), db, registrations: await listActiveFunctionRegistrations(db), loaderFor: loaderFor() });
  }

  async function installBulk(settings: Record<string, unknown>) {
    const installed = await installPlugin(db, { manifest: bulkManifest, source: "bundled", bundleSha256: BUNDLED_PLUGINS["acme.bulk-discount"]!.sha256, actorUserId: "owner" });
    const configured = await writePluginSettings(db, "acme.bulk-discount", { title: "Bulk savings", ...settings }, {
      expectedRevision: installed.revision,
      credentialEncryptionKey: PLUGIN_TEST_CREDENTIAL_KEY,
    });
    await activatePlugin(db, "acme.bulk-discount", { actorUserId: "owner", expectedRevision: configured.revision });
  }

  async function installTestApp(id: string, points: Array<{ point: string; priority?: number }>, limits = { cpuMs: 50, wallMs: 100 }, extra: Partial<PluginManifestInput> = {}) {
    const manifest: PluginManifestInput = {
      id, name: `${id} app`, version: "1.0.0", apiVersion: PLUGIN_API_VERSION, description: "A checkout test app.",
      author: { name: "Test" }, functions: points as PluginManifestInput["functions"], limits, ...extra,
    };
    await installPlugin(db, { manifest, source: "upload", bundleSha256: "3".repeat(64), actorUserId: "owner" });
    await activatePlugin(db, id, { actorUserId: "owner", expectedRevision: 1 });
  }

  type Line = CreateStorefrontOrderInput["items"][number];
  const line = (productId: string, variantId: string, quantity: number, price: number): Line => ({ productId, variantId, quantity, price });

  function input(items: Line[], overrides: Partial<CreateStorefrontOrderInput> = {}): CreateStorefrontOrderInput {
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
      ...overrides,
    };
  }

  async function authority(data: CreateStorefrontOrderInput, appFunctions?: CheckoutAppFunctions) {
    return loadStorefrontCheckoutAuthority(db, {
      items: data.items, inventoryPool: data.inventoryPool, city: data.city, zone: data.zone, area: data.area,
      shippingMethodId: data.shippingMethodId, customerPhone: data.customerPhone,
      // As the checkout read binds it: the apps' purchase options.
      purchaseOptions: () => checkoutPurchaseOptions(appFunctions),
    });
  }

  /** The quote the buyer reviews (what the tax-quote route prices). */
  async function quote(data: CreateStorefrontOrderInput, appFunctions?: CheckoutAppFunctions) {
    const read = await authority(data, appFunctions);
    return priceStorefrontCheckout(db, {
      cartValidation: read.cartValidation,
      delivery: read.deliveryPreflight,
      discountCodes: data.discountCodes,
      customerPhone: data.customerPhone,
      currency: { code: "BDT", decimalPlaces: 2, priceIncrementMinor: 100 },
      taxAuthority: read.taxAuthority,
      apps: appFunctions,
      channel: "online_store",
      location: { city: data.city, zone: data.zone, area: data.area },
    });
  }

  /** The order placement path: prepare with the apps, then the one commit batch. */
  async function place(data: CreateStorefrontOrderInput, appFunctions?: CheckoutAppFunctions) {
    const read = await authority(data, appFunctions);
    const attempt = createAtomicCheckoutAttempt(await buildCheckoutAttemptIdentity(data));
    const result = await createStorefrontOrder(
      db, data, "https://shop.test/api/v1/orders",
      { orderId: attempt.orderId, checkoutToken: attempt.checkoutToken },
      read.cartValidation, read.deliveryPreflight, undefined, { code: "BDT", decimalPlaces: 2, priceIncrementMinor: 100 },
      createTrustedStorefrontCheckoutPolicySnapshot({
        partialPaymentEnabled: false, authorityRevision: read.authorityRevision,
        orderCreatedNotificationEnabled: false, metaPurchaseEnabled: false,
      }),
      read.taxAuthority, {}, { apps: appFunctions, channel: "online_store" },
    );
    const committed = await commitStorefrontOrderPayload(db, result.commitPayload, { attempt, response: { orderId: result.orderId } });
    return { result, committed };
  }

  it("a store with no app does no app work: one empty registration read, no app call, platform pricing unchanged", async () => {
    await installTestApp("idle.app", [{ point: "checkout.discounts" }]);
    sqlite.exec("UPDATE plugin_installations SET status = 'disabled' WHERE plugin_id = 'idle.app'");
    const none = await apps();
    expect([...none.points]).toEqual([]);
    const data = input([line("p_tea", "v_tea", 4, 500)]);
    queries = [];
    const withoutRunner = await quote(data);
    const platformQueries = queries.length;
    queries = [];
    const withEmptyRunner = await quote(data, none);
    expect(queries.length).toBe(platformQueries);
    expect(withEmptyRunner.taxQuote).toEqual(withoutRunner.taxQuote);
    expect(withEmptyRunner).toMatchObject({ appDiscounts: [], ruleErrors: [], shippingRates: null, appCart: null });
    expect(fakeCalls).toEqual([]);
  });

  it("bulk discount stacks after a platform promotion, is recorded on the order, reconciles for refunds and shows on the order", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const draft = await createPromotionDraft(db, createPromotionDraftSchema.parse({
      name: "Tea week", method: "automatic", effects: [{ kind: "percentage_off", target: "order", allocation: "once", config: { basisPoints: 1_000 } }],
    }));
    await activatePromotion(db, draft.id, draft.revision, now - 60);
    await installBulk({ title: "Bulk savings", tier1_quantity: 3, tier1_percent: 5, tier2_quantity: 6, tier2_percent: 10, tier3_quantity: 12, tier3_percent: 0 });
    const runner = await apps();
    expect([...runner.points].sort()).toEqual(["cart.validate", "checkout.discounts"]);

    const data = input([line("p_tea", "v_tea", 4, 500), line("p_mug", "v_mug", 1, 300)]);
    const reviewed = await quote(data, runner);
    // Platform 10% of 2,300 = 230; the tea line (4 × 500 = 2,000, 200 off) keeps 1,800; 5% of it = 90.
    expect(reviewed.appDiscounts).toEqual([expect.objectContaining({
      pluginId: "acme.bulk-discount", appName: "Bulk discount", title: "Bulk savings (5% off)", target: "lines",
      amountMinor: 9_000, shippingAmountMinor: 0, lines: [{ lineId: "cart:0:v_tea", amountMinor: 9_000 }],
    })]);
    expect(reviewed.taxQuote.discountMinor).toBe(23_000 + 9_000);
    expect(reviewed.appCart?.lines[0]).toMatchObject({ sku: "TEA-250", categoryIds: ["cat_tea"], lineTotalMinor: 180_000 });

    const { result } = await place(data, await apps());
    expect(result.taxQuote.totalMinor).toBe(reviewed.taxQuote.totalMinor);
    const order = one<{ discount: number; total: number }>("SELECT discount_amount_minor AS discount, total_amount_minor AS total FROM orders WHERE id = ?", result.orderId);
    expect(order).toEqual({ discount: 32_000, total: 230_000 + 6_000 - 32_000 });
    expect(one("SELECT discount_amount_minor AS d FROM order_items WHERE order_id = ? AND product_id = 'p_tea'", result.orderId)).toEqual({ d: 20_000 + 9_000 });
    expect(one("SELECT count(*) AS n FROM order_events WHERE order_id = ? AND kind = 'app_discount'", result.orderId)).toEqual({ n: 1 });

    expect((await listOrderDiscountLines(db, result.orderId)).map((entry) => [entry.title, entry.appId, entry.amountMinor])).toEqual([
      ["Tea week", null, 23_000],
      ["Bulk savings (5% off)", "acme.bulk-discount", 9_000],
    ]);
    await expect(readPromotionRefundSnapshot(db, { orderId: result.orderId, currencyCode: "BDT", orderDiscountAmountMinor: order.discount }))
      .resolves.toMatchObject({ totalDiscountMinor: 32_000, merchandiseDiscountMinor: 32_000 });
    const detail = await getOrderDetails(db, result.orderId);
    expect(detail?.discounts.map((entry) => [entry.source, entry.appName, entry.amount])).toEqual([["promotion", null, 230], ["app", "Bulk discount", 90]]);
    expect((await listOrderTimeline(db, result.orderId)).map((event) => event.kind)).toEqual(["placed"]);
  });

  it("bulk discount's cart rule blocks placement on the right line; the quote refuses it too", async () => {
    await installBulk({ max_quantity_per_line: 3 });
    const data = input([line("p_mug", "v_mug", 1, 300), line("p_tea", "v_tea", 5, 500)]);
    const reviewed = await quote(data, await apps());
    expect(reviewed.ruleErrors).toEqual([{ code: "max_quantity", message: "You can buy at most 3 of this item in one order.", index: 1, cartKey: null }]);
    await expect(place(data, await apps())).rejects.toMatchObject({
      details: { reason: "cart_rules", ruleErrors: [expect.objectContaining({ index: 1, code: "max_quantity" })] },
    });
    expect(one("SELECT count(*) AS n FROM orders")).toEqual({ n: 0 });
  });

  it("an app discount that does not combine with the class already applied is skipped predictably, claiming no code", async () => {
    // acme.bulk-discount (priority 100) counts the cart: an order discount, 10% at 2 units.
    await installBulk({ count_by: "cart", tier1_quantity: 2, tier1_percent: 10 });
    await installTestApp("acme.picky", [{ point: "checkout.discounts", priority: 200 }]);
    let combinesWith: Record<string, boolean> | undefined = { order: false };
    answers["acme.picky"] = () => ok({ discounts: [{
      title: "Mug deal", code: "MUG", target: { kind: "lines", lineIds: ["cart:1:v_mug"] },
      value: { type: "fixed_amount", amountMinor: 5_000 }, ...(combinesWith ? { combinesWith } : {}),
    }] });
    const data = input([line("p_tea", "v_tea", 1, 500), line("p_mug", "v_mug", 1, 300)], { discountCodes: ["mug"] });
    const skipped = await quote(data, await apps());
    expect(skipped.appDiscounts.map((entry) => [entry.pluginId, entry.target])).toEqual([["acme.bulk-discount", "order"]]);
    // The skipped discount claimed no code: MUG is still not found.
    expect(skipped.discount.rejectedCodes.map((rejection) => [rejection.code, rejection.reason])).toEqual([["MUG", "not_found"]]);
    await expect(place(data, await apps())).rejects.toThrow("This discount code is not valid.");
    // Saying nothing stacks it, as before.
    combinesWith = undefined;
    const stacked = await quote(data, await apps());
    expect(stacked.appDiscounts.map((entry) => [entry.pluginId, entry.target])).toEqual([["acme.bulk-discount", "order"], ["acme.picky", "lines"]]);
    expect(stacked.discount.rejectedCodes).toEqual([]);
  });

  it("a line's purchase option reaches the apps, is frozen as _purchase_option, and one no app offers is refused", async () => {
    await installTestApp("acme.subscribe", [{ point: "cart.validate" }], undefined, {
      checkout: { purchaseOptions: [{ key: "monthly", title: "Subscribe and save" }] },
    });
    let seen: unknown = null;
    answers["acme.subscribe"] = (_point, payload) => {
      seen = (payload.cart as { lines: Array<Record<string, unknown>> }).lines.map((entry) => [entry.variantId, entry.purchaseOption, entry.requiresShipping]);
      return ok({ errors: [] });
    };
    const runner = await apps();
    const data = input([{ ...line("p_tea", "v_tea", 1, 500), purchaseOption: "acme.subscribe.monthly" }, line("p_tea", "v_tea", 1, 500)]);
    const { result } = await place(data, runner);
    expect(seen).toEqual([["v_tea", "acme.subscribe.monthly", true], ["v_tea", null, true]]);
    const rows = sqlite.prepare("SELECT properties FROM order_items WHERE order_id = ? ORDER BY properties IS NULL, id").all(result.orderId) as Array<{ properties: string | null }>;
    expect(rows.map((row) => row.properties && JSON.parse(row.properties))).toEqual([
      [{ key: "_purchase_option", type: "text", label: "Purchase option", value: "acme.subscribe.monthly", displayValue: "Subscribe and save", priceMinor: 0 }],
      null,
    ]);
    // An option no active app declares is refused on its line, never dropped.
    await expect(authority(input([{ ...line("p_tea", "v_tea", 1, 500), purchaseOption: "acme.gone.monthly" }]), runner))
      .rejects.toMatchObject({ details: { itemIssues: [expect.objectContaining({ index: 0, code: "purchase_option_unavailable", action: "remove" })] } });
  });

  it("a code only an app answers to is accepted at placement; a typo still fails closed", async () => {
    await installBulk({ code: "BULK", count_by: "cart", tier1_quantity: 2, tier1_percent: 10 });
    const { result } = await place(input([line("p_tea", "v_tea", 2, 500)], { discountCodes: ["bulk"] }), await apps());
    expect(one("SELECT discount_amount_minor AS d FROM orders WHERE id = ?", result.orderId)).toEqual({ d: 10_000 });
    // Repricing would drop the app's discount: like a promotion order, its items are not editable.
    expect((await getOrderDetails(db, result.orderId))?.editReadiness).toMatchObject({ items: { allowed: false, reason: "discount" } });
    await expect(place(input([line("p_tea", "v_tea", 2, 500)], { discountCodes: ["BULKK"] }), await apps()))
      .rejects.toThrow("This discount code is not valid.");
  });

  it("fails open: an app that throws, times out or answers invalid output is skipped and logged; checkout goes on", async () => {
    await installTestApp("acme.throws", [{ point: "checkout.discounts", priority: 1 }]);
    await installTestApp("acme.slow", [{ point: "checkout.discounts", priority: 2 }]);
    await installTestApp("acme.invalid", [{ point: "cart.validate", priority: 3 }]);
    answers["acme.throws"] = () => ({ ok: false, value: null, error: { code: null, message: "TypeError: boom" }, logs: [], droppedLogs: 0 });
    answers["acme.slow"] = () => new Promise(() => undefined);
    answers["acme.invalid"] = () => ok({ errors: [{ code: "BAD CODE", message: "" }] });
    const data = input([line("p_tea", "v_tea", 1, 500)]);
    const reviewed = await quote(data, await apps());
    expect(reviewed).toMatchObject({ appDiscounts: [], ruleErrors: [] });
    expect(reviewed.taxQuote.totalMinor).toBe(56_000);
    const { result } = await place(data, await apps());
    expect(result.taxQuote.totalMinor).toBe(56_000);
    const incident = async (id: string) => (await listPluginLogs(db, id)).map((entry) => entry.message).join(" | ");
    expect(await incident("acme.throws")).toContain("TypeError: boom");
    expect(await incident("acme.slow")).toContain("wall-time limit");
    expect(await incident("acme.invalid")).toContain("Invalid cart.validate output");
  });

  it("runs each point once per request for the same input (memoized), and again for a new request", async () => {
    await installTestApp("acme.count", [{ point: "checkout.discounts" }]);
    answers["acme.count"] = () => ok({ discounts: [{ title: "Five off", target: { kind: "order" }, value: { type: "fixed_amount", amountMinor: 500 } }] });
    const runner = await apps();
    const data = input([line("p_tea", "v_tea", 1, 500)]);
    const first = await quote(data, runner);
    const second = await quote(data, runner);
    expect(second.taxQuote).toEqual(first.taxQuote);
    expect(fakeCalls).toHaveLength(1);
    await quote(data, await apps());
    expect(fakeCalls).toHaveLength(2);
  });

  it("delivery options: hide, rename, price and reorder the platform's rates; a hidden chosen rate is refused with the visible options", async () => {
    await installTestApp("acme.rates", [{ point: "checkout.shipping_rates" }]);
    answers["acme.rates"] = (_point, payload) => {
      expect((payload.rates as Array<{ rateId: string }>).map((rate) => rate.rateId)).toEqual(["m_std", "m_exp", "m_pick"]);
      return ok({ operations: [
        { op: "hide", rateId: "m_exp" },
        { op: "rename", rateId: "m_std", name: "Dhaka standard" },
        { op: "price", rateId: "m_std", amountMinor: 8_000 },
        { op: "reorder", rateIds: ["m_pick"] },
        { op: "hide", rateId: "m_invented" },
      ] });
    };
    const reviewed = await quote(input([line("p_tea", "v_tea", 1, 500)]), await apps());
    expect(reviewed.shippingRates?.map((rate) => [rate.rateId, rate.name, rate.amountMinor])).toEqual([
      ["m_pick", "Store pickup", 0],
      ["m_std", "Dhaka standard", 8_000],
    ]);
    expect(reviewed.shippingMethod).toMatchObject({ id: "m_std", name: "Dhaka standard", baseAmountMinor: 8_000, feeWaived: false });
    expect(reviewed.taxQuote.shippingMinor).toBe(8_000);
    const { result } = await place(input([line("p_tea", "v_tea", 1, 500)]), await apps());
    expect(one("SELECT shipping_method_name AS name, shipping_amount_minor AS fee FROM orders WHERE id = ?", result.orderId))
      .toEqual({ name: "Dhaka standard", fee: 8_000 });
    await expect(quote(input([line("p_tea", "v_tea", 1, 500)], { shippingMethodId: "m_exp" }), await apps())).rejects.toMatchObject({
      details: { reason: "delivery_rate_unavailable", shippingRates: [expect.objectContaining({ id: "m_pick" }), expect.objectContaining({ id: "m_std", amountMinor: 8_000 })] },
    });
    expect((await listPluginLogs(db, "acme.rates")).map((entry) => entry.message).join(" ")).toContain("m_invented");
  });

  it("a platform fault fails closed at a point a blocking app holds, open elsewhere", async () => {
    await installTestApp("acme.open", [{ point: "checkout.discounts" }]);
    await installTestApp("acme.gate", [{ point: "cart.validate", onError: "block" } as { point: string }]);
    const runner = await apps();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // An input the platform built wrong (a platform bug): the runner refuses it.
    const broken = { cart: { lines: "not a cart" } } as never;
    await expect(runner.run("checkout.discounts", broken)).resolves.toEqual([]);
    await expect(runner.run("cart.validate", broken)).rejects.toMatchObject({ details: { reason: "checkout_app_unavailable" } });
    errors.mockRestore();
  });

  it("apps see the order's destination country, never Bangladesh by default", async () => {
    sqlite.exec(`
      INSERT INTO delivery_zones (id, name) VALUES ('dz_us', 'United States'); INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('US', 'dz_us');
      INSERT INTO shipping_methods (id, name, fee_minor, kind, sort_order, zone_id) VALUES ('m_us', 'US post', 9000, 'delivery', 3, 'dz_us');
    `);
    await installTestApp("acme.where", [{ point: "checkout.discounts" }, { point: "cart.validate" }]);
    const seen: unknown[] = [];
    answers["acme.where"] = (point, payload) => {
      seen.push((payload.cart as { destination: unknown }).destination);
      return ok(point === "cart.validate" ? { errors: [] } : { discounts: [] });
    };
    const data = input([line("p_tea", "v_tea", 1, 500)], { shippingMethodId: "m_us", city: null, zone: null });
    const read = await loadStorefrontCheckoutAuthority(db, {
      items: data.items, inventoryPool: data.inventoryPool, shippingCountryCode: "US", shippingAdminArea: "CA", shippingPostalCode: "94103",
      shippingMethodId: "m_us", customerPhone: data.customerPhone,
    });
    const runner = await apps();
    await priceStorefrontCheckout(db, {
      cartValidation: read.cartValidation, delivery: read.deliveryPreflight, discountCodes: [], customerPhone: data.customerPhone,
      currency: { code: "BDT", decimalPlaces: 2, priceIncrementMinor: 100 }, taxAuthority: read.taxAuthority, apps: runner, channel: "online_store",
    });
    await checkStorefrontCartRules(db, {
      cartValidation: read.cartValidation, delivery: read.deliveryPreflight, apps: runner,
      currency: { code: "BDT", decimalPlaces: 2 }, channel: "online_store",
    });
    // Both points of the quote; the cart page's rule check is the same input (memoized).
    expect(seen).toEqual([{ country: "US", city: null, zone: null }, { country: "US", city: null, zone: null }]);
  });

  it("payment methods: an app narrows and presents the allowed methods, and placement refuses a hidden one", async () => {
    await installTestApp("acme.pay", [{ point: "checkout.payment_methods" }]);
    answers["acme.pay"] = () => ok({ operations: [{ op: "hide", methodId: "cod" }, { op: "rename", methodId: "stripe", name: "Card" }] });
    const reviewed = await quote(input([line("p_tea", "v_tea", 1, 500)]), await apps());
    const runner = await apps();
    expect(await resolveAppPaymentMethods(runner, reviewed.appCart, ["cod", "stripe"])).toEqual({ changed: true, methods: [{ methodId: "stripe", name: "Card" }] });
    await expect(assertStorefrontAppPaymentMethod(runner, reviewed.appCart, "cod", ["cod", "stripe"]))
      .rejects.toMatchObject({ details: { reason: "payment_method_unavailable" } });
    await expect(assertStorefrontAppPaymentMethod(runner, reviewed.appCart, "stripe", ["cod", "stripe"])).resolves.toBeUndefined();
    // Gift cards are tender: never hidden.
    await expect(assertStorefrontAppPaymentMethod(runner, reviewed.appCart, "gift_card", ["cod", "stripe"])).resolves.toBeUndefined();
  });

  it("an app whose approved grant lacks the point never runs there", async () => {
    await installTestApp("acme.grant", [{ point: "checkout.discounts" }]);
    sqlite.exec(`UPDATE plugin_installations SET grant_json = json_set(grant_json, '$.functions', json('[]')) WHERE plugin_id = 'acme.grant'`);
    const runner = await apps();
    expect(runner.points.has("checkout.discounts")).toBe(false);
  });
});

