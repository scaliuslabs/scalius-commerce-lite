// Checkout app functions on the buyer-agent ("agent") and dashboard
// ("admin") channels, end to end through the real routes on the migrated
// schema with test apps (a fake loader): the same cart gets the same app
// discount as the online store, in the quote and in the order's
// `app_discount` facts; an app rule refuses the quote and the order; a
// hidden cash on delivery refuses the order; staff delivery-charge overrides
// beat an app's price; an app registered to block that cannot answer stops
// checkout on every channel with the store's words; an app's hold
// (`ctx.orders.hold`, from an event handler) keeps the order from moving on
// until staff release it; and a store without apps prices exactly as before.
import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { activatePlugin, installPlugin, listActiveFunctionRegistrations } from "@scalius/core/modules/plugins";
import {
  buildCheckoutAttemptIdentity,
  commitStorefrontOrderPayload,
  createAtomicCheckoutAttempt,
  createManualOrderAppFunctions,
  createStorefrontOrder,
  createTrustedStorefrontCheckoutPolicySnapshot,
  loadStorefrontCheckoutAuthority,
  NO_CHECKOUT_APP_FUNCTIONS,
  priceStorefrontCheckout,
  type CheckoutAppFunctions,
} from "@scalius/core/modules/checkout";
import { getOrderDetails, quoteManualOrder, updateOrderStatus, type CreateStorefrontOrderInput } from "@scalius/core/modules/orders";
import { bulkFulfillOrders } from "@scalius/core/modules/fulfilment";
import { quoteAgentStorefrontCheckout } from "@scalius/core/modules/agent-storefront";
import { PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/shared/plugins";
import type { PluginInvocationResult } from "@scalius/plugin-sdk/runtime";
import type { PluginLoader } from "./loaders/types";
import { pluginTestCtx, pluginTestEnv } from "./testing/fixtures";
import { PluginBridgeHost } from "./bridge";
import { pluginBridgeAuthority } from "./host";
import { requirePluginInstallation } from "@scalius/core/modules/plugins";
import { errorResponseFromError } from "../utils/api-response";

// The routes build their runner themselves: give it the test apps' loader.
const testLoader = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("./checkout-functions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./checkout-functions")>();
  return {
    ...actual,
    createCheckoutAppFunctions: (options: Parameters<typeof actual.createCheckoutAppFunctions>[0]) =>
      actual.createCheckoutAppFunctions({ ...options, ...(testLoader.current ? { loaderFor: testLoader.current as never } : {}) }),
  };
});

import { createCheckoutAppFunctions } from "./checkout-functions";
import { storefrontAgentContextRoutes } from "../routes/storefront-agent-contexts";
import { adminOrdersRoutes } from "../routes/admin/orders";

const ok = (value: unknown): PluginInvocationResult => ({ ok: true, value, error: null, logs: [], droppedLogs: 0 });
const thrown = (message: string): PluginInvocationResult => ({ ok: false, value: null, error: { code: null, message }, logs: [], droppedLogs: 0 });
const GRANT = "agr_storefront0123456789";
const CONTEXT = "asc_context0123456789abc";
const PHONE = "+8801712345678";

describe("checkout app functions on the agent and admin channels", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let env: Env;
  let queries: string[];
  let answers: Record<string, (point: string, input: Record<string, unknown>) => PluginInvocationResult>;
  let calls: Array<{ pluginId: string; point: string; channel: unknown }>;

  beforeEach(() => {
    queries = [];
    ({ sqlite, db } = createSqliteD1Database({ onQuery: (query) => queries.push(query) }));
    env = pluginTestEnv(undefined as unknown as D1Database);
    answers = {};
    calls = [];
    const fake: PluginLoader = {
      kind: "sandbox",
      async invoke({ installation, invocation }) {
        if (invocation.kind !== "function") return ok(null);
        const input = invocation.input as Record<string, unknown>;
        calls.push({ pluginId: installation.pluginId, point: invocation.point, channel: (input.cart as { channel?: unknown } | undefined)?.channel });
        const answer = answers[installation.pluginId];
        return answer ? answer(invocation.point, input) : ok(null);
      },
    };
    testLoader.current = () => fake;
    const now = Math.floor(Date.now() / 1000);
    sqlite.exec(`
      INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1);
      INSERT INTO settings (id, key, value, type, category) VALUES
        ('s_currency', 'document', '{"currencyCode":"BDT","currencySymbol":"৳","usdExchangeRate":"1"}', 'json', 'currency'),
        ('s_countries', 'document', '{"allowedCountries":["BD"],"allowedCountriesMode":"include"}', 'json', 'customer_countries'),
        ('s_methods', 'document', '{"enabledMethods":["cod"],"defaultMethod":"cod"}', 'json', 'payment_methods'),
        ('s_checkout', 'document', '{"guestCheckoutEnabled":true,"checkoutMode":"all","partialPaymentEnabled":false,"partialPaymentAmount":0}', 'json', 'checkout');
      INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active)
      VALUES ('city_1', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1), ('zone_1', 'Gulshan', 'BD', 2, 'city_1', '{}', '{}', 1);
      INSERT INTO delivery_zones (id, name) VALUES ('dz_bd', 'Bangladesh'); INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('BD', 'dz_bd'); 
      INSERT INTO shipping_methods (id, name, fee_minor, kind, sort_order, zone_id) VALUES
        ('m_std', 'Standard', 6000, 'delivery', 0, 'dz_bd'), ('m_exp', 'Express', 12000, 'delivery', 1, 'dz_bd');
      INSERT INTO shipping_methods (id, name, fee_minor, kind, pickup_address, sort_order)
      VALUES ('m_pick', 'Store pickup', 0, 'pickup', 'Shop 4, Gulshan 1', 2);
      INSERT INTO products (id, name, slug, price_minor, is_active) VALUES
        ('p_tea', 'Assam tea', 'assam-tea', 50000, 1), ('p_mug', 'Mug', 'mug', 30000, 1);
      INSERT INTO product_variants
        (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
      VALUES
        ('v_tea', 'p_tea', 'TEA-250', 50000, 500, 0, 0, 1, 1, 'physical'),
        ('v_mug', 'p_mug', 'MUG-1', 30000, 500, 0, 0, 1, 1, 'physical');
      INSERT INTO agent_grants (id, kind, owner_user_id, resource, label, preset, permissions_json, risk_ceiling, status, expires_at)
      VALUES ('${GRANT}', 'pat', 'owner', 'storefront', 'Buyer agent', 'full', '[]', 'read', 'active', ${now + 172_800});
      INSERT INTO agent_storefront_contexts (id, grant_id, revision, cart_json, city_id, zone_id, shipping_method_id, expires_at)
      VALUES ('${CONTEXT}', '${GRANT}', 2, '[{"variantId":"v_tea","quantity":4},{"variantId":"v_mug","quantity":1}]',
        'city_1', 'zone_1', 'm_std', ${now + 3_600});
    `);
  });
  afterEach(() => {
    testLoader.current = undefined;
    sqlite.close();
  });

  const one = <T = Record<string, unknown>>(query: string, ...params: Array<string | number>) =>
    sqlite.prepare(query).get(...params) as T;
  const count = (query: string, ...params: Array<string | number>) => one<{ n: number }>(query, ...params).n;
  const pointCalls = (point: string) => calls.filter((call) => call.point === point);

  async function installTestApp(id: string, points: Array<string | { point: string; onError?: "skip" | "block" }>, extra: Partial<PluginManifestInput> = {}) {
    const manifest: PluginManifestInput = {
      id, name: `${id} app`, version: "1.0.0", apiVersion: PLUGIN_API_VERSION, description: "A checkout test app.",
      author: { name: "Test" },
      ...extra,
      functions: points.map((point) => (typeof point === "string" ? { point } : point)) as PluginManifestInput["functions"],
      limits: { cpuMs: 50, wallMs: 100 },
    };
    await installPlugin(db, { manifest, source: "upload", bundleSha256: "3".repeat(64), actorUserId: "owner" });
    await activatePlugin(db, id, { actorUserId: "owner", expectedRevision: 1 });
  }

  async function apps(): Promise<CheckoutAppFunctions> {
    return createCheckoutAppFunctions({ env, ctx: pluginTestCtx(), db, registrations: await listActiveFunctionRegistrations(db) });
  }

  // ── The real routes, with the request's waitUntil work awaited ──────────

  function api() {
    const app = new OpenAPIHono<{ Bindings: Env }>();
    app.onError((error, c) => {
      const { body, status } = errorResponseFromError(error);
      return c.json(body, status);
    });
    app.use("*", async (c, next) => {
      c.set("db", db);
      c.set("user", { id: "owner" } as never);
      c.set("agentPrincipal", {
        kind: "agent", credentialId: "acr_test", grantId: GRANT, grantKind: "pat", ownerUserId: "owner",
        isSuperAdmin: true, resource: "storefront", preset: "full", permissions: new Set(), riskCeiling: "financial",
        authorityRevision: 1, expiresAt: new Date(Date.now() + 86_400_000),
      } as never);
      await next();
    });
    app.route("/storefront/agent-contexts", storefrontAgentContextRoutes);
    app.route("/admin/orders", adminOrdersRoutes);
    return app;
  }

  async function call(method: string, path: string, body: unknown, headers: Record<string, string> = {}) {
    const pending: Array<Promise<unknown>> = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise), passThroughOnException: () => undefined, props: {} };
    const response = await api().request(`https://api.shop.test${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }, env, ctx as unknown as ExecutionContext);
    await Promise.all(pending);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- route JSON, read loosely by the assertions
    return { status: response.status, body: await response.json() as { success: boolean; data?: Record<string, any>; error?: Record<string, any> } };
  }

  // ── Online store (the reference), agent and admin requests for one cart ─

  function storefrontInput(overrides: Partial<CreateStorefrontOrderInput> = {}): CreateStorefrontOrderInput {
    return {
      checkoutRequestId: `request_${crypto.randomUUID()}`,
      expectedQuoteFingerprint: "taxq_unused_in_core_tests0",
      customerName: "App Buyer", customerPhone: PHONE, customerEmail: null,
      shippingAddress: "House 1, Road 2, Gulshan", city: "city_1", zone: "zone_1", area: null, notes: null,
      discountCodes: [], shippingCharge: 0, shippingMethodId: "m_std", paymentMethod: "cod", inventoryPool: "regular",
      items: [
        { productId: "p_tea", variantId: "v_tea", quantity: 4, price: 500 },
        { productId: "p_mug", variantId: "v_mug", quantity: 1, price: 300 },
      ],
      ...overrides,
    };
  }

  async function onlineStore(runner: CheckoutAppFunctions) {
    const data = storefrontInput();
    const read = await loadStorefrontCheckoutAuthority(db, {
      items: data.items, inventoryPool: data.inventoryPool, city: data.city, zone: data.zone, area: data.area,
      shippingMethodId: data.shippingMethodId, customerPhone: data.customerPhone,
    });
    const quote = await priceStorefrontCheckout(db, {
      cartValidation: read.cartValidation, delivery: read.deliveryPreflight, discountCodes: [], customerPhone: PHONE,
      currency: { code: "BDT", decimalPlaces: 2, priceIncrementMinor: 100 }, taxAuthority: read.taxAuthority, apps: runner, channel: "online_store",
      location: { city: data.city, zone: data.zone, area: data.area },
    });
    const attempt = createAtomicCheckoutAttempt(await buildCheckoutAttemptIdentity(data));
    const result = await createStorefrontOrder(
      db, data, "https://shop.test/api/v1/orders", { orderId: attempt.orderId, checkoutToken: attempt.checkoutToken },
      read.cartValidation, read.deliveryPreflight, undefined, { code: "BDT", decimalPlaces: 2, priceIncrementMinor: 100 },
      createTrustedStorefrontCheckoutPolicySnapshot({
        partialPaymentEnabled: false, authorityRevision: read.authorityRevision,
        orderCreatedNotificationEnabled: false, metaPurchaseEnabled: false,
      }),
      read.taxAuthority, {}, { apps: runner, channel: "online_store" },
    );
    await commitStorefrontOrderPayload(db, result.commitPayload, { attempt, response: { orderId: result.orderId } });
    return { quote, orderId: result.orderId };
  }

  const agentQuote = () => call("POST", `/storefront/agent-contexts/${CONTEXT}/checkout/quote`, {});
  const agentSubmit = (fingerprint: string, overrides: Record<string, unknown> = {}) =>
    call("POST", `/storefront/agent-contexts/${CONTEXT}/checkout/submit`, {
      expectedRevision: 2, expectedQuoteFingerprint: fingerprint, idempotencyKey: "agent-checkout-key-0001",
      customerName: "Agent Buyer", customerPhone: PHONE, customerEmail: null,
      shippingAddress: "House 1, Road 2, Gulshan", notes: null, paymentMethod: "cod", ...overrides,
    });

  function manualOrder(overrides: Record<string, unknown> = {}) {
    return {
      city: "city_1", zone: "zone_1", area: null,
      items: [
        { productId: "p_tea", variantId: "v_tea", quantity: 4 },
        { productId: "p_mug", variantId: "v_mug", quantity: 1 },
      ],
      discountAmount: null, shippingCharge: 60, shippingMethodId: "m_std",
      ...overrides,
    };
  }
  const adminQuote = (overrides: Record<string, unknown> = {}) => call("POST", "/admin/orders/quote", manualOrder(overrides));
  const adminCreate = (requestKey: string, overrides: Record<string, unknown> = {}) => call("POST", "/admin/orders", {
    ...manualOrder(overrides),
    customerName: "Walk-in Buyer", customerPhone: PHONE, customerEmail: null,
    shippingAddress: "House 1, Road 2, Gulshan", notes: null,
  }, { "Idempotency-Key": requestKey });

  const appFacts = (orderId: string) => (sqlite.prepare("SELECT data FROM order_events WHERE order_id = ? AND kind = 'app_discount'").all(orderId) as Array<{ data: string }>)
    .map((row) => JSON.parse(row.data) as { pluginId: string; amountMinor: number; shippingAmountMinor: number; lines: unknown[] });
  const orderMoney = (orderId: string) => one<{ discount: number; total: number; shipping: number; channel: string }>(
    "SELECT discount_amount_minor AS discount, total_amount_minor AS total, shipping_amount_minor AS shipping, channel FROM orders WHERE id = ?",
    orderId,
  );

  it("an app discount prices the agent quote, the agent order and the staff order exactly as the online store", async () => {
    await installTestApp("acme.discounts", ["checkout.discounts"]);
    answers["acme.discounts"] = () => ok({ discounts: [{ title: "Tea club 5%", target: { kind: "order" }, value: { type: "percentage", percent: 5 } }] });

    const reference = await onlineStore(await apps());
    // 5% of 2,300 = 115 off, spread by value (whole taka): tea 100, mug 15.
    expect(reference.quote.taxQuote).toMatchObject({ discountMinor: 11_500, totalMinor: 230_000 + 6_000 - 11_500 });
    const referenceOrder = orderMoney(reference.orderId);

    const quoted = await agentQuote();
    expect(quoted.status).toBe(200);
    expect(quoted.body.data).toMatchObject({
      discountMinor: 11_500, totalMinor: reference.quote.taxQuote.totalMinor,
      appDiscounts: [{ appId: "acme.discounts", title: "Tea club 5%", code: null, amountMinor: 11_500, shippingAmountMinor: 0 }],
      shippingRates: null, paymentMethods: null,
    });
    const submitted = await agentSubmit(quoted.body.data!.quoteFingerprint);
    expect(submitted.status).toBe(201);
    const agentOrderId = submitted.body.data!.orderId as string;
    expect(orderMoney(agentOrderId)).toEqual({ ...referenceOrder, channel: "agent" });
    expect(appFacts(agentOrderId).map((fact) => fact.amountMinor)).toEqual(appFacts(reference.orderId).map((fact) => fact.amountMinor));

    const staffQuote = await adminQuote();
    expect(staffQuote.status).toBe(200);
    expect(staffQuote.body.data).toMatchObject({
      discountAmount: 115, totalAmount: 2_245,
      appDiscounts: [{ appId: "acme.discounts", appName: "acme.discounts app", title: "Tea club 5%", amount: 115, shippingAmount: 0 }],
    });
    const created = await adminCreate("11111111-1111-4111-8111-111111111111");
    expect(created.status).toBe(201);
    const staffOrderId = created.body.data!.id as string;
    expect(orderMoney(staffOrderId)).toEqual({ ...referenceOrder, channel: "admin" });
    expect(appFacts(staffOrderId)).toEqual([expect.objectContaining({ pluginId: "acme.discounts", amountMinor: 11_500, shippingAmountMinor: 0 })]);
    expect(one("SELECT discount_amount_minor AS d FROM order_items WHERE order_id = ? AND product_id = 'p_tea'", staffOrderId)).toEqual({ d: 10_000 });
    // The order page shows the app's discount, and its items are not repriced by an amendment.
    const detail = await getOrderDetails(db, staffOrderId);
    expect(detail?.discounts.map((entry) => [entry.source, entry.appName, entry.amount])).toEqual([["app", "acme.discounts app", 115]]);
    expect(detail?.editReadiness).toMatchObject({ items: { allowed: false, reason: "discount" } });
    // Every channel told the app which one it was.
    expect(pointCalls("checkout.discounts").map((entry) => entry.channel)).toEqual(expect.arrayContaining(["online_store", "agent", "admin"]));
  });

  it("staff discount takes the place of promotions: the app takes its share from what is left, and tax sees both", async () => {
    await installTestApp("acme.discounts", ["checkout.discounts"]);
    answers["acme.discounts"] = (_point, input) => {
      // Apps see each line after the staff discount (100 taka spread by value).
      expect((input.cart as { lines: Array<{ lineTotalMinor: number }> }).lines.map((line) => line.lineTotalMinor)).toEqual([191_304, 28_696]);
      return ok({ discounts: [{ title: "Five percent", target: { kind: "order" }, value: { type: "percentage", percent: 5 } }] });
    };
    const quoted = await adminQuote({ discountAmount: 100 });
    // 5% of the 2,200 left = 110; 100 + 110 off.
    expect(quoted.body.data).toMatchObject({ discountAmount: 210, totalAmount: 2_300 + 60 - 210, appDiscounts: [expect.objectContaining({ amount: 110 })] });
    const created = await adminCreate("22222222-2222-4222-8222-222222222222", { discountAmount: 100 });
    const orderId = created.body.data!.id as string;
    expect(orderMoney(orderId)).toMatchObject({ discount: 21_000, total: 215_000 });
    const lines = sqlite.prepare("SELECT discount_amount_minor AS d FROM order_items WHERE order_id = ? ORDER BY product_id DESC").all(orderId);
    // Line discount = staff part (8,696 / 1,304) + the app's part of 11,000 by what was left.
    expect(lines).toEqual([{ d: 8_696 + 9_565 }, { d: 1_304 + 1_435 }]);
    expect(appFacts(orderId)[0]?.lines).toEqual([
      { orderItemId: expect.any(String), amountMinor: 9_565 },
      { orderItemId: expect.any(String), amountMinor: 1_435 },
    ]);
    // The order page: the app's discount by name, the staff's as the plain "other" discount.
    const detail = await getOrderDetails(db, orderId);
    expect(detail?.discounts.map((entry) => [entry.source, entry.amount])).toEqual([["app", 110]]);
    expect(detail?.discountAmount).toBe(210);
  });

  it("a staff order line takes an app's purchase option: apps see it with the order's channels, the line freezes it, an unknown one is refused", async () => {
    await installTestApp("acme.subscribe", ["cart.validate"], { checkout: { purchaseOptions: [{ key: "monthly", title: "Subscribe and save" }] } });
    const seen: unknown[] = [];
    answers["acme.subscribe"] = (_point, input) => {
      const cart = input.cart as { channel: string; salesChannelId: string; lines: Array<{ variantId: string; purchaseOption: string | null; requiresShipping: boolean }> };
      seen.push({ channel: cart.channel, salesChannelId: cart.salesChannelId, lines: cart.lines.map((line) => [line.variantId, line.purchaseOption, line.requiresShipping]) });
      return ok({ errors: [] });
    };
    const items = [
      { productId: "p_tea", variantId: "v_tea", quantity: 1, purchaseOption: "acme.subscribe.monthly" },
      { productId: "p_mug", variantId: "v_mug", quantity: 1 },
    ];
    const created = await adminCreate("33333333-3333-4333-8333-333333333333", { items });
    expect(created.status).toBe(201);
    expect(seen.at(-1)).toEqual({ channel: "admin", salesChannelId: "sc_online_store", lines: [["v_tea", "acme.subscribe.monthly", true], ["v_mug", null, true]] });
    const rows = sqlite.prepare("SELECT product_id AS productId, properties FROM order_items WHERE order_id = ? ORDER BY product_id DESC").all(created.body.data!.id as string) as Array<{ productId: string; properties: string | null }>;
    expect(rows.map((row) => [row.productId, row.properties && JSON.parse(row.properties)])).toEqual([
      ["p_tea", [{ key: "_purchase_option", type: "text", label: "Purchase option", value: "acme.subscribe.monthly", displayValue: "Subscribe and save", priceMinor: 0 }]],
      ["p_mug", null],
    ]);
    const refused = await adminQuote({ items: [{ productId: "p_tea", variantId: "v_tea", quantity: 1, purchaseOption: "acme.gone.monthly" }] });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("purchase_option_unavailable");
  });

  it("an app rule refuses the agent quote and submit and the staff quote and order, with checkout's refusal shape", async () => {
    await installTestApp("acme.rules", ["cart.validate"]);
    answers["acme.rules"] = () => ok({ errors: [{ code: "too_much_tea", message: "At most 3 teas per order.", lineId: "cart:0:v_tea" }] });
    const refusal = { reason: "cart_rules", ruleErrors: [{ code: "too_much_tea", message: "At most 3 teas per order.", index: 0, cartKey: null }] };

    const quoted = await agentQuote();
    expect(quoted).toMatchObject({ status: 400, body: { error: { details: refusal } } });
    const submitted = await agentSubmit("taxq_abcdefghijklmnopqrstuv");
    expect(submitted).toMatchObject({ status: 400, body: { error: { details: refusal } } });

    expect(await adminQuote()).toMatchObject({ status: 400, body: { error: { details: refusal } } });
    expect(await adminCreate("33333333-3333-4333-8333-333333333333")).toMatchObject({ status: 400, body: { error: { details: refusal } } });
    expect(count("SELECT count(*) AS n FROM orders")).toBe(0);
    expect(pointCalls("cart.validate").map((entry) => entry.channel)).toEqual(expect.arrayContaining(["agent", "admin"]));
  });

  it("an app registered to block that cannot answer stops checkout on every channel, with the store's words", async () => {
    await installTestApp("acme.verify", [{ point: "cart.validate", onError: "block" }]);
    await installTestApp("acme.optional", ["cart.validate"]);
    answers["acme.verify"] = () => thrown("Error: address service down");
    answers["acme.optional"] = () => thrown("Error: also down");
    const refusal = {
      status: 400,
      body: { error: { message: "We can't confirm your order right now. Please try again in a few minutes.", details: { reason: "checkout_app_unavailable" } } },
    };

    await expect(onlineStore(await apps())).rejects.toMatchObject({ details: { reason: "checkout_app_unavailable" } });
    expect(await agentQuote()).toMatchObject(refusal);
    expect(await agentSubmit("taxq_abcdefghijklmnopqrstuv")).toMatchObject(refusal);
    expect(await adminQuote()).toMatchObject(refusal);
    expect(await adminCreate("66666666-6666-4666-8666-666666666666")).toMatchObject(refusal);
    expect(count("SELECT count(*) AS n FROM orders")).toBe(0);

    // The app answers again: checkout continues; a skip app that fails is only left out.
    answers["acme.verify"] = () => ok({ errors: [] });
    expect((await agentQuote()).status).toBe(200);
  });

  it("an app that hides cash on delivery: the agent quote shows it, and agent submit and the staff order are refused", async () => {
    await installTestApp("acme.pay", ["checkout.payment_methods"]);
    answers["acme.pay"] = () => ok({ operations: [{ op: "hide", methodId: "cod" }] });

    const quoted = await agentQuote();
    expect(quoted.body.data).toMatchObject({ paymentMethods: [] });
    const submitted = await agentSubmit(quoted.body.data!.quoteFingerprint);
    expect(submitted).toMatchObject({ status: 400, body: { error: { details: { reason: "payment_method_unavailable" } } } });

    expect(await adminQuote()).toMatchObject({ status: 400, body: { error: { details: { reason: "payment_method_unavailable" } } } });
    expect(await adminCreate("44444444-4444-4444-8444-444444444444"))
      .toMatchObject({ status: 400, body: { error: { details: { reason: "payment_method_unavailable" } } } });
    expect(count("SELECT count(*) AS n FROM orders")).toBe(0);
  });

  it("an app's hold keeps a staff order from moving on until staff release it; cancelling stays possible", async () => {
    // A reaction after commit: the app's order.created handler holds the order through the host.
    await installTestApp("acme.risk", [], { scopes: ["write_orders"], events: ["order.created"] });
    const installation = await requirePluginInstallation(db, "acme.risk");
    const runtime = { env, ctx: pluginTestCtx(), db: () => db, composedEnv: async () => env };
    const bridge = new PluginBridgeHost({ pluginId: installation.pluginId, version: installation.version, authority: pluginBridgeAuthority(installation) }, runtime);

    const created = await adminCreate("77777777-7777-4777-8777-777777777777");
    expect(created.status).toBe(201);
    const orderId = created.body.data!.id as string;
    await bridge.ordersHold({ orderId, reason: "Phone seen on returned orders." });
    await bridge.ordersAssessRisk({ orderId, level: "high", reasons: ["Phone seen on returned orders."] });
    const detail = await getOrderDetails(db, orderId);
    expect(detail?.appRiskChecks).toEqual([expect.objectContaining({ appId: "acme.risk", level: "high", reasons: ["Phone seen on returned orders."] })]);
    expect(detail?.holds).toEqual([expect.objectContaining({ appId: "acme.risk", appName: "acme.risk app", reason: "Phone seen on returned orders.", releasedAt: null })]);
    // Nothing is handed over while it is held.
    expect(await bulkFulfillOrders(db, [orderId], { requestKey: "held-send" }))
      .toEqual([expect.objectContaining({ orderId, success: false, error: expect.stringContaining("on hold for review (acme.risk app: Phone seen on returned orders.)") })]);
    expect(one("SELECT status FROM orders WHERE id = ?", orderId)).toEqual({ status: "confirmed" });

    // A redelivered event places nothing new.
    await bridge.ordersHold({ orderId, reason: "Phone seen on returned orders." });
    await bridge.ordersAssessRisk({ orderId, level: "low", reasons: ["Second look."] });
    expect(count("SELECT count(*) AS n FROM order_holds WHERE order_id = ?", orderId)).toBe(1);
    expect(count("SELECT count(*) AS n FROM order_events WHERE order_id = ? AND kind = 'app_risk'", orderId)).toBe(1);

    const holdId = detail!.holds[0]!.id;
    const released = await call("POST", `/admin/orders/${orderId}/holds/${holdId}/release`, {});
    expect(released).toMatchObject({ status: 200, body: { data: { id: holdId, releasedAt: expect.any(String) } } });
    expect(one("SELECT released_by FROM order_holds WHERE id = ?", holdId)).toEqual({ released_by: "owner" });
    expect(await bulkFulfillOrders(db, [orderId], { requestKey: "released-send" })).toEqual([expect.objectContaining({ orderId, success: true })]);
    expect(one("SELECT status FROM orders WHERE id = ?", orderId)).toEqual({ status: "shipped" });

    const second = await adminCreate("88888888-8888-4888-8888-888888888888");
    await updateOrderStatus(db, second.body.data!.id as string, "cancelled");
    expect(one("SELECT status FROM orders WHERE id = ?", second.body.data!.id as string)).toEqual({ status: "cancelled" });
  });

  it("delivery options: the agent quote shows them and refuses a hidden method; staff keep their own charge over an app's price", async () => {
    await installTestApp("acme.rates", ["checkout.shipping_rates"]);
    answers["acme.rates"] = () => ok({ operations: [
      { op: "rename", rateId: "m_std", name: "Dhaka standard" },
      { op: "price", rateId: "m_std", amountMinor: 8_000 },
      { op: "hide", rateId: "m_exp" },
    ] });

    // A hidden method is refused with the storefront's reason and the options left.
    sqlite.exec(`UPDATE agent_storefront_contexts SET shipping_method_id = 'm_exp' WHERE id = '${CONTEXT}'`);
    expect(await agentQuote()).toMatchObject({
      status: 400,
      body: { error: { details: { reason: "delivery_rate_unavailable", shippingRates: [expect.objectContaining({ id: "m_std" }), expect.objectContaining({ id: "m_pick" })] } } },
    });
    sqlite.exec(`UPDATE agent_storefront_contexts SET shipping_method_id = 'm_std' WHERE id = '${CONTEXT}'`);

    const quoted = await agentQuote();
    expect(quoted.body.data).toMatchObject({
      shippingMinor: 8_000,
      shippingRates: [expect.objectContaining({ id: "m_std", name: "Dhaka standard", amountMinor: 8_000 }), expect.objectContaining({ id: "m_pick" })],
    });
    const submitted = await agentSubmit(quoted.body.data!.quoteFingerprint);
    expect(one("SELECT shipping_method_name AS name, shipping_amount_minor AS fee FROM orders WHERE id = ?", submitted.body.data!.orderId))
      .toEqual({ name: "Dhaka standard", fee: 8_000 });

    // Staff kept the method's fee: the app's price and name apply, as on the online store.
    const kept = await adminCreate("66666666-6666-4666-8666-666666666666");
    expect(one("SELECT shipping_method_name AS name, shipping_amount_minor AS fee, shipping_method_base_amount_minor AS base FROM orders WHERE id = ?", kept.body.data!.id))
      .toEqual({ name: "Dhaka standard", fee: 8_000, base: 8_000 });
    // Staff typed their own charge for the method: it stands; the name still follows the app.
    expect((await adminQuote({ shippingCharge: 50 })).body.data).toMatchObject({ shippingAmount: 50 });
    // A custom charge has no method: apps have no rate to adjust.
    const before = pointCalls("checkout.shipping_rates").length;
    expect((await adminQuote({ shippingMethodId: undefined, shippingCharge: 70 })).body.data).toMatchObject({ shippingAmount: 70 });
    expect(pointCalls("checkout.shipping_rates")).toHaveLength(before);
    // Staff picking a method an app hides are refused the same way.
    expect(await adminQuote({ shippingMethodId: "m_exp", shippingCharge: 120 })).toMatchObject({
      status: 400,
      body: { error: { details: { reason: "delivery_rate_unavailable", shippingRates: expect.arrayContaining([expect.objectContaining({ id: "m_std", name: "Dhaka standard" })]) } } },
    });
  });

  it("a code only an app answers to can be applied by an agent and prices its quote", async () => {
    await installTestApp("acme.code", ["checkout.discounts"]);
    answers["acme.code"] = () => ok({ discounts: [{ title: "Club code", code: "CLUB", target: { kind: "order" }, value: { type: "fixed_amount", amountMinor: 5_000 } }] });
    const applied = await call("PUT", `/storefront/agent-contexts/${CONTEXT}/discount`, { revision: 2, code: "club" });
    expect(applied.status).toBe(200);
    const quoted = await agentQuote();
    expect(quoted.body.data).toMatchObject({ discountMinor: 5_000, appDiscounts: [expect.objectContaining({ code: "CLUB", amountMinor: 5_000 })] });
    // A typo is still refused.
    expect(await call("PUT", `/storefront/agent-contexts/${CONTEXT}/discount`, { revision: 3, code: "CLUBB" })).toMatchObject({ status: 400 });
  });

  it("a store without an active app prices both channels exactly as before: no extra read beyond the registrations, no app call", async () => {
    await installTestApp("idle.app", ["checkout.discounts", "cart.validate", "checkout.shipping_rates"]);
    sqlite.exec("UPDATE plugin_installations SET status = 'disabled' WHERE plugin_id = 'idle.app'");
    const none = await apps();
    expect([...none.points]).toEqual([]);

    queries = [];
    const withoutRunner = await quoteAgentStorefrontCheckout(db, GRANT, CONTEXT);
    const agentQueries = queries.length;
    queries = [];
    const withEmptyRunner = await quoteAgentStorefrontCheckout(db, GRANT, CONTEXT, { apps: none });
    expect(queries.length).toBe(agentQueries);
    expect(withEmptyRunner).toEqual(withoutRunner);
    expect(withoutRunner).toMatchObject({ discountMinor: 0, totalMinor: 236_000, appDiscounts: [], shippingRates: null, paymentMethods: null });

    queries = [];
    const staffWithout = await quoteManualOrder(db, manualOrder() as never);
    const staffQueries = queries.length;
    queries = [];
    const staffWithEmpty = await quoteManualOrder(db, manualOrder() as never, { apps: createManualOrderAppFunctions(db, NO_CHECKOUT_APP_FUNCTIONS) });
    expect(queries.length).toBe(staffQueries);
    expect(staffWithEmpty).toEqual(staffWithout);
    expect(staffWithout).toMatchObject({ totalAmount: 2_360, appDiscounts: [] });

    const quoted = await agentQuote();
    await agentSubmit(quoted.body.data!.quoteFingerprint);
    await adminCreate("77777777-7777-4777-8777-777777777777");
    expect(calls).toEqual([]);
    expect(count("SELECT count(*) AS n FROM order_events WHERE kind IN ('app_discount', 'app_risk')")).toBe(0);
  });
});
