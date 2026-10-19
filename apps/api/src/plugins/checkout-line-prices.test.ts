import { putObjectRecord } from "@scalius/core/modules/objects";
import { objectTypeDeclarationSchema } from "@scalius/shared/plugins/objects";
// `cart.line_prices` end to end on the real migrated schema: an app's unit
// price takes the app place in resolvePrice() (below every list, above FX and
// base), the buyer's submitted price is checked against the final price,
// the quote and the order agree, the first app by priority wins a line, a
// gift card is never app-priced, a contract read from the buyer's record
// (a declared read of the buyer's contract) prices a signed-in buyer, failures are fail-open unless the app
// blocks, and a store without such an app prices with one pass and no read.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
  activatePlugin,
  installPlugin,
  listActiveFunctionRegistrations,
  listPluginLogs,
} from "@scalius/core/modules/plugins";
import {
  buildCheckoutAttemptIdentity,
  commitStorefrontOrderPayload,
  createAppLinePricer,
  createAtomicCheckoutAttempt,
  createStorefrontOrder,
  createTrustedStorefrontCheckoutPolicySnapshot,
  loadStorefrontCheckoutAuthority,
  priceStorefrontCheckout,
  resolveAppLinePrices,
  validateStorefrontCartItems,
  type CheckoutAppFunctions,
} from "@scalius/core/modules/checkout";
import type { CreateStorefrontOrderInput } from "@scalius/core/modules/orders";
import { PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/shared/plugins";
import type { PluginInvocationResult } from "@scalius/plugin-sdk/runtime";
import type { PluginLoader } from "./loaders/types";
import { createCheckoutAppFunctions } from "./checkout-functions";
import { pluginTestCtx, pluginTestEnv } from "./testing/fixtures";

const contracts = objectTypeDeclarationSchema.parse({ name: "Contracts", fields: [{ key: "skus", name: "SKU prices", type: "json" }] });
const ok = (value: unknown): PluginInvocationResult => ({ ok: true, value, error: null, logs: [], droppedLogs: 0 });
const failed = (message: string): PluginInvocationResult => ({ ok: false, value: null, error: { code: null, message }, logs: [], droppedLogs: 0 });

describe("cart.line_prices (real schema, test apps)", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let env: Env;
  let queries: string[];
  let answers: Record<string, (input: Record<string, unknown>) => PluginInvocationResult>;
  let seen: Array<{ pluginId: string; input: Record<string, unknown> }>;

  beforeEach(() => {
    queries = [];
    ({ sqlite, db } = createSqliteD1Database({ onQuery: (query) => queries.push(query) }));
    env = pluginTestEnv(undefined as unknown as D1Database);
    answers = {};
    seen = [];
    sqlite.exec(`
      INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1);
      INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active)
      VALUES ('city_1', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1), ('zone_1', 'Gulshan', 'BD', 2, 'city_1', '{}', '{}', 1);
      INSERT INTO delivery_zones (id, name) VALUES ('dz_bd', 'Bangladesh'); INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('BD', 'dz_bd');
      INSERT INTO shipping_methods (id, name, fee_minor, kind, sort_order, zone_id) VALUES ('m_std', 'Standard', 6000, 'delivery', 0, 'dz_bd');
      INSERT INTO products (id, name, slug, price_minor, is_active, is_gift_card) VALUES
        ('p_tea', 'Assam tea', 'assam-tea', 50000, 1, 0),
        ('p_mug', 'Mug', 'mug', 30000, 1, 0),
        ('p_card', 'Gift card', 'gift-card', 100000, 1, 1);
      INSERT INTO product_variants
        (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
      VALUES
        ('v_tea', 'p_tea', 'TEA-250', 50000, 500, 0, 0, 1, 1, 'physical'),
        ('v_mug', 'p_mug', 'MUG-1', 30000, 500, 0, 0, 1, 1, 'physical'),
        ('v_card', 'p_card', 'CARD', 100000, 0, 0, 0, 1, 0, 'digital');
      INSERT INTO customers (id, name, phone) VALUES ('cus_b2b', 'Acme Ltd', '+8801712345679');
    `);
  });
  afterEach(() => sqlite.close());

  function loaderFor() {
    const fake: PluginLoader = {
      kind: "sandbox",
      async invoke({ installation, invocation }) {
        if (invocation.kind !== "function") return ok(null);
        seen.push({ pluginId: installation.pluginId, input: invocation.input as Record<string, unknown> });
        const answer = answers[installation.pluginId];
        return answer ? answer(invocation.input as Record<string, unknown>) : ok({ prices: [] });
      },
    };
    return () => fake;
  }

  async function apps(): Promise<CheckoutAppFunctions> {
    return createCheckoutAppFunctions({ env, ctx: pluginTestCtx(), db, registrations: await listActiveFunctionRegistrations(db), loaderFor: loaderFor() });
  }

  async function installPricer(id: string, options: { priority?: number; onError?: "skip" | "block"; contracts?: string } = {}) {
    const manifest: PluginManifestInput = {
      id, name: `${id} app`, version: "1.0.0", apiVersion: PLUGIN_API_VERSION, description: "A pricing test app.",
      author: { name: "Test" },
      functions: [{
        point: "cart.line_prices",
        priority: options.priority ?? 100,
        onError: options.onError ?? "skip",
        ...(options.contracts ? { reads: [{ as: "contract", object: options.contracts, key: "customer" as const }] } : {}),
      }],
      ...(options.contracts ? { objects: { [options.contracts]: contracts } } : {}),
      limits: { cpuMs: 50, wallMs: 100 },
    };
    await installPlugin(db, { manifest, source: "upload", bundleSha256: "4".repeat(64), actorUserId: "owner" });
    await activatePlugin(db, id, { actorUserId: "owner", expectedRevision: 1 });
  }

  type Line = CreateStorefrontOrderInput["items"][number];
  const line = (productId: string, variantId: string, quantity: number, price: number): Line => ({ productId, variantId, quantity, price });

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

  async function authority(data: CreateStorefrontOrderInput, runner?: CheckoutAppFunctions, customerId: string | null = null) {
    return loadStorefrontCheckoutAuthority(db, {
      items: data.items, inventoryPool: data.inventoryPool, city: data.city, zone: data.zone, area: data.area,
      shippingMethodId: data.shippingMethodId, customerPhone: data.customerPhone,
      linePricer: () => createAppLinePricer(db, runner, { channel: "online_store", customerId }),
    });
  }

  async function quote(data: CreateStorefrontOrderInput, runner: CheckoutAppFunctions) {
    const read = await authority(data, runner);
    return priceStorefrontCheckout(db, {
      cartValidation: read.cartValidation,
      delivery: read.deliveryPreflight,
      discountCodes: [],
      customerPhone: data.customerPhone,
      currency: { code: "BDT", decimalPlaces: 2, priceIncrementMinor: 100 },
      taxAuthority: read.taxAuthority,
      apps: runner,
      channel: "online_store",
      location: { city: data.city, zone: data.zone, area: data.area },
    });
  }

  async function place(data: CreateStorefrontOrderInput, runner: CheckoutAppFunctions) {
    const read = await authority(data, runner);
    const attempt = createAtomicCheckoutAttempt(await buildCheckoutAttemptIdentity(data));
    const result = await createStorefrontOrder(
      db, data, "https://shop.test/api/v1/orders",
      { orderId: attempt.orderId, checkoutToken: attempt.checkoutToken },
      read.cartValidation, read.deliveryPreflight, undefined, { code: "BDT", decimalPlaces: 2, priceIncrementMinor: 100 },
      createTrustedStorefrontCheckoutPolicySnapshot({
        partialPaymentEnabled: false, authorityRevision: read.authorityRevision,
        orderCreatedNotificationEnabled: false, metaPurchaseEnabled: false,
      }),
      read.taxAuthority, {}, { apps: runner, channel: "online_store" },
    );
    await commitStorefrontOrderPayload(db, result.commitPayload, { attempt, response: { orderId: result.orderId } });
    return result;
  }

  it("prices with one pass and no extra read when no app implements the point", async () => {
    const runner = await apps();
    expect(createAppLinePricer(db, runner, { channel: "online_store" })).toBeUndefined();
    const items = [line("p_tea", "v_tea", 2, 500)];
    queries = [];
    await validateStorefrontCartItems(db, items, { currencyCode: "BDT", priceIncrementMinor: 100 });
    const plain = queries.length;
    queries = [];
    const priced = await validateStorefrontCartItems(db, items, { currencyCode: "BDT", priceIncrementMinor: 100, linePricer: createAppLinePricer(db, runner, { channel: "online_store" }) });
    expect(queries.length).toBe(plain);
    expect(priced.items[0]).toMatchObject({ unitPriceMinor: 50_000, priceSource: "base" });
    expect(seen).toEqual([]);
  });

  it("replaces the base price; the quote and the order charge it; the buyer's price is checked against it", async () => {
    await installPricer("acme.tiers");
    // Tiered pricing: 10+ units of tea cost 400.49 each (rounded half-up to whole taka).
    answers["acme.tiers"] = (fn) => {
      const cart = fn.cart as { lines: Array<{ lineId: string; productId: string; quantity: number }> };
      return ok({ prices: cart.lines.filter((entry) => entry.productId === "p_tea" && entry.quantity >= 10).map((entry) => ({ lineId: entry.lineId, unitPriceMinor: 40_049 })) });
    };
    const runner = await apps();
    // The buyer saw the catalogue price: the cart asks for a refresh to the app price.
    const stale = await validateStorefrontCartItems(db, [line("p_tea", "v_tea", 10, 500)], {
      currencyCode: "BDT", priceIncrementMinor: 100, linePricer: createAppLinePricer(db, runner, { channel: "online_store" }),
    });
    expect(stale.issues).toEqual([expect.objectContaining({ code: "PRICE_CHANGED", currentPrice: 400 })]);
    expect((seen[0]!.input.lines as unknown[])[0]).toEqual({ lineId: "cart:0:v_tea", source: "base", bundle: null });

    const data = input([line("p_tea", "v_tea", 10, 400), line("p_mug", "v_mug", 1, 300)]);
    const reviewed = await quote(data, await apps());
    expect(reviewed.taxQuote.subtotalMinor).toBe(10 * 40_000 + 30_000);
    const result = await place(data, await apps());
    expect(result.taxQuote.totalMinor).toBe(reviewed.taxQuote.totalMinor);
    expect(sqlite.prepare("SELECT unit_price_minor AS unit, base_unit_price_minor AS base FROM order_items WHERE order_id = ? AND product_id = 'p_tea'").get(result.orderId))
      .toEqual({ unit: 40_000, base: 40_000 });
  });

  it("lets the first app by priority win a line, never prices a gift card and logs a line it does not know", async () => {
    await installPricer("acme.first", { priority: 1 });
    await installPricer("acme.second", { priority: 2 });
    answers["acme.first"] = () => ok({ prices: [{ lineId: "cart:0:v_tea", unitPriceMinor: 45_000 }, { lineId: "cart:9:v_none", unitPriceMinor: 1_000 }] });
    answers["acme.second"] = () => ok({ prices: [
      { lineId: "cart:0:v_tea", unitPriceMinor: 30_000 },
      { lineId: "cart:1:v_mug", unitPriceMinor: 25_000 },
      { lineId: "cart:2:v_card", unitPriceMinor: 1_000 },
    ] });
    const result = await validateStorefrontCartItems(db, [line("p_tea", "v_tea", 1, 450), line("p_mug", "v_mug", 1, 250), line("p_card", "v_card", 1, 1000)], {
      currencyCode: "BDT", priceIncrementMinor: 100, linePricer: createAppLinePricer(db, await apps(), { channel: "online_store" }),
    });
    expect(result.valid).toBe(true);
    expect(result.items.map((item) => [item.variantId, item.unitPriceMinor, item.priceSource])).toEqual([
      ["v_tea", 45_000, "app"],
      ["v_mug", 25_000, "app"],
      ["v_card", 100_000, "base"],
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await listPluginLogs(db, "acme.first")).map((entry) => entry.message)).toContain("A price names line cart:9:v_none, which is not in the cart; it was skipped.");
  });

  it("keeps a price-list price: lists stay authoritative (logged for the merchant)", () => {
    const reports: string[] = [];
    const prices = resolveAppLinePrices(
      [{ index: 0, isGiftCard: false, priceSource: "market" }, { index: 1, isGiftCard: false, priceSource: "fx" }],
      ["cart:0:v_a", "cart:1:v_b"],
      [{ pluginId: "acme.b2b", output: { prices: [{ lineId: "cart:0:v_a", unitPriceMinor: 100 }, { lineId: "cart:1:v_b", unitPriceMinor: 200 }] } }],
      { report: (_plugin, _point, message) => reports.push(message) },
    );
    expect([...prices]).toEqual([[1, { amountMinor: 200, pluginId: "acme.b2b" }]]);
    expect(reports).toEqual(["Line cart:0:v_a is priced by a market price list, which an app price never replaces; it was skipped."]);
  });

  it("prices a signed-in buyer from their contract record (a declared read)", async () => {
    await installPricer("acme.b2b", { contracts: "contracts" });
    await putObjectRecord(db, "acme.b2b", "contracts", contracts, "cus_b2b", { skus: { "MUG-1": 21_000 } });
    answers["acme.b2b"] = (fn) => {
      const contract = (fn.reads as Record<string, { data: { skus: Record<string, number> } } | null>).contract;
      const cart = fn.cart as { lines: Array<{ lineId: string; sku: string | null }> };
      if (!contract) return ok({ prices: [] });
      return ok({ prices: cart.lines.flatMap((entry) => (entry.sku && contract.data.skus[entry.sku] ? [{ lineId: entry.lineId, unitPriceMinor: contract.data.skus[entry.sku]! }] : [])) });
    };
    const runner = await apps();
    const guest = await validateStorefrontCartItems(db, [line("p_mug", "v_mug", 1, 300)], {
      currencyCode: "BDT", priceIncrementMinor: 100, linePricer: createAppLinePricer(db, runner, { channel: "online_store" }),
    });
    expect(guest.items[0]!.unitPriceMinor).toBe(30_000);
    const member = await validateStorefrontCartItems(db, [line("p_mug", "v_mug", 1, 210)], {
      currencyCode: "BDT", priceIncrementMinor: 100, linePricer: createAppLinePricer(db, runner, { channel: "online_store", customerId: Promise.resolve("cus_b2b") }),
    });
    expect(member.items[0]).toMatchObject({ unitPriceMinor: 21_000, priceSource: "app" });
  });

  it("fails open on a throw (catalogue price, logged) and closed when the app blocks", async () => {
    await installPricer("acme.flaky");
    answers["acme.flaky"] = () => failed("TypeError: boom");
    const priced = await validateStorefrontCartItems(db, [line("p_tea", "v_tea", 1, 500)], {
      currencyCode: "BDT", priceIncrementMinor: 100, linePricer: createAppLinePricer(db, await apps(), { channel: "online_store" }),
    });
    expect(priced.items[0]).toMatchObject({ unitPriceMinor: 50_000, priceSource: "base" });

    await installPricer("acme.contract", { onError: "block" });
    answers["acme.contract"] = () => failed("TypeError: down");
    await expect(validateStorefrontCartItems(db, [line("p_tea", "v_tea", 1, 500)], {
      currencyCode: "BDT", priceIncrementMinor: 100, linePricer: createAppLinePricer(db, await apps(), { channel: "online_store" }),
    })).rejects.toMatchObject({ details: { reason: "CHECKOUT_APP_UNAVAILABLE" } });
  });
});
