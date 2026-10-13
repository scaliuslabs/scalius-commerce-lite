// scalius.bkash end to end through the platform (bundled loader, migrated
// schema, a simulated bKash API): the merchant enables the app's method, the
// buyer sees it in checkout config, places an order with it, gets a bKash
// session, returns from bKash, and the queue credits the order exactly once,
// through the same payment port, routes and kernel as the built-in gateways.
import { OpenAPIHono } from "@hono/zod-openapi";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, type Database } from "@scalius/database/client";
import { OrderStatus, PaymentStatus } from "@scalius/database/schema";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { activatePlugin, installPlugin, writePluginSettings } from "@scalius/core/modules/plugins";
import { checkoutDocument, currencyDocument, paymentMethodsDocument } from "@scalius/core/modules/settings";
import { errorResponseFromError } from "../utils/api-response";
import { orderRoutes } from "../routes/storefront-orders";
import { checkoutRoutes } from "../routes/checkout";
import { paymentRoutes } from "../routes/payment/payment-routes";
import { paymentWebhookRoutes } from "../routes/webhooks/payments";
import { BUNDLED_PLUGINS } from "./bundled.gen";
import { PLUGIN_TEST_CREDENTIAL_KEY } from "./testing/fixtures";
import { manifest as bkashManifest } from "../../../../plugins/bkash/src/index";

const METHOD = "scalius.bkash:bkash";
const SANDBOX = "https://tokenized.sandbox.bka.sh/v1.2.0-beta/tokenized/checkout/";
const LIMITER = { limit: async () => ({ success: true }) };

/** bKash's Tokenized Checkout as the app calls it: Initiated until Execute after the buyer authorised. */
function fakeBkash() {
  const payments = new Map<string, { amount: string; invoice: string; status: string; trxID: string | null; authorized: boolean }>();
  const calls: string[] = [];
  let sequence = 0;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  const record = (paymentID: string) => {
    const payment = payments.get(paymentID)!;
    return {
      statusCode: "0000", statusMessage: "Successful", paymentID, transactionStatus: payment.status, amount: payment.amount,
      currency: "BDT", intent: "sale", merchantInvoiceNumber: payment.invoice, ...(payment.trxID ? { trxID: payment.trxID } : {}),
    };
  };
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(SANDBOX)) return new Response("unexpected host", { status: 599 });
    const path = url.slice(SANDBOX.length);
    calls.push(path);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    switch (path) {
      case "token/grant":
        return json({ statusCode: "0000", statusMessage: "Successful", id_token: "id-token-e2e", token_type: "Bearer", expires_in: 3600, refresh_token: "r" });
      case "create": {
        const id = `TR0011E2E${(sequence += 1)}`;
        payments.set(id, { amount: String(body.amount), invoice: String(body.merchantInvoiceNumber), status: "Initiated", trxID: null, authorized: false });
        return json({ ...record(id), bkashURL: `https://sandbox.payment.bkash.com/?paymentId=${id}`, callbackURL: body.callbackURL });
      }
      case "execute": {
        const payment = payments.get(String(body.paymentID));
        if (!payment || !payment.authorized) return json({ statusCode: "2056", statusMessage: "Invalid Payment State" });
        if (payment.status === "Completed") return json({ statusCode: "2062", statusMessage: "The payment has already been completed" });
        payment.status = "Completed";
        payment.trxID = `TRXE2E${(sequence += 1)}`;
        return json(record(String(body.paymentID)));
      }
      case "payment/status":
        return payments.has(String(body.paymentID)) ? json(record(String(body.paymentID))) : json({ statusCode: "2002", statusMessage: "Invalid Payment ID" });
      default:
        return new Response("not found", { status: 404 });
    }
  });
  return { fetch, calls, payments };
}

describe("bKash app through checkout, session, return and the queue", () => {
  let sqlite: DatabaseSync;
  let binding: D1Database;
  let db: Database;
  let env: Env;
  let bank: ReturnType<typeof fakeBkash>;

  beforeEach(async () => {
    ({ sqlite, binding } = createSqliteD1Database());
    env = {
      DB: binding,
      RL_STANDARD: LIMITER,
      RL_STRICT: LIMITER,
      JWT_SECRET: "bkash-e2e-secret-0123456789abcdef",
      SCALIUS_SECRET: "bkash-e2e-master-secret-0123456789abcdefghijklmnop",
      CREDENTIAL_ENCRYPTION_KEY: PLUGIN_TEST_CREDENTIAL_KEY,
      PUBLIC_API_BASE_URL: "https://api.shop.test",
      STOREFRONT_URL: "https://shop.test",
    } as unknown as Env;
    db = getDb(env);
    bank = fakeBkash();
    vi.stubGlobal("fetch", bank.fetch);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    sqlite.exec(`
      INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1);
      INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active)
      VALUES ('city_1', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1), ('zone_1', 'Gulshan', 'BD', 2, 'city_1', '{}', '{}', 1);
      INSERT INTO delivery_zones (id, name) VALUES ('dz_bd', 'Bangladesh'); INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('BD', 'dz_bd'); INSERT INTO shipping_methods (id, name, fee_minor, kind, zone_id) VALUES ('m_std', 'Standard', 6000, 'delivery', 'dz_bd');
      INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('p_tea', 'Assam tea', 'assam-tea', 50000, 1);
      INSERT INTO product_variants
        (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
      VALUES ('v_tea', 'p_tea', 'TEA-250', 50000, 500, 0, 0, 1, 1, 'physical');
    `);
    const installed = await installPlugin(db, {
      manifest: bkashManifest,
      source: "bundled",
      bundleSha256: BUNDLED_PLUGINS["scalius.bkash"]!.sha256,
      actorUserId: "owner",
    });
    const configured = await writePluginSettings(db, "scalius.bkash", {
      environment: "sandbox", app_key: "app-key-e2e", app_secret: "app-secret-e2e-0123", username: "merchant-e2e", password: "pw-e2e-0123",
    }, { expectedRevision: installed.revision, credentialEncryptionKey: PLUGIN_TEST_CREDENTIAL_KEY });
    await activatePlugin(db, "scalius.bkash", { actorUserId: "owner", expectedRevision: configured.revision });
    await currencyDocument.write(db, { currencyCode: "BDT" });
    await checkoutDocument.write(db, { checkoutMode: "all", partialPaymentEnabled: false, partialPaymentAmount: 0 });
    await paymentMethodsDocument.write(db, { enabledMethods: ["cod", METHOD], defaultMethod: "cod" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    sqlite.close();
  });

  function api() {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
    app.onError((error, c) => {
      const { body, status } = errorResponseFromError(error);
      return c.json(body, status);
    });
    app.use("*", async (c, next) => {
      c.set("db", getDb(env));
      await next();
    });
    app.route("/checkout", checkoutRoutes);
    app.route("/orders", orderRoutes);
    app.route("/payment", paymentRoutes);
    app.route("/webhooks", paymentWebhookRoutes);
    return app;
  }

  async function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => void waits.push(promise), passThroughOnException: () => undefined, props: {} };
    const response = await api().request(`https://api.shop.test/api/v1${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, env, ctx as never);
    await Promise.all(waits);
    return response;
  }

  it("offers the app's method, takes the order, pays on bKash and credits the order once", async () => {
    const config = await (await request("GET", "/checkout/config")).json() as { data: { gateways: Array<Record<string, unknown>> } };
    expect(config.data.gateways).toEqual(expect.arrayContaining([expect.objectContaining({ id: METHOD, name: "bKash", flow: "hosted" })]));

    const quote = await (await request("POST", "/orders/tax-quote", {
      items: [{ productId: "p_tea", variantId: "v_tea", quantity: 2 }], city: "city_1", zone: "zone_1", shippingMethodId: "m_std", discountCodes: [],
    })).json() as { data: { quoteFingerprint: string; totalMinor: number } };
    const placed = await request("POST", "/orders", {
      checkoutRequestId: `bkash_${crypto.randomUUID()}`,
      expectedQuoteFingerprint: quote.data.quoteFingerprint,
      customerName: "Karim", customerPhone: "+8801712345678", customerEmail: null,
      shippingAddress: "House 1, Road 2, Gulshan", city: "city_1", zone: "zone_1", notes: null,
      items: [{ productId: "p_tea", variantId: "v_tea", quantity: 2, price: 500 }],
      discountCodes: [], shippingCharge: 60, shippingMethodId: "m_std", paymentMethod: METHOD,
    });
    const order = await placed.json() as { data: { orderId: string; receiptToken: string } };
    expect(placed.status, JSON.stringify(order)).toBe(201);
    const orderId = order.data.orderId;
    expect(sqlite.prepare("SELECT payment_method, status FROM orders WHERE id = ?").get(orderId))
      .toEqual({ payment_method: METHOD, status: OrderStatus.INCOMPLETE });

    const session = await request("POST", `/payment/${METHOD}/session`, { orderId }, { "X-Receipt-Token": order.data.receiptToken });
    const sessionBody = await session.json() as { data: { gatewayUrl: string; sessionKey: string } };
    expect(session.status, JSON.stringify(sessionBody)).toBe(200);
    expect(sessionBody.data.gatewayUrl).toMatch(/^https:\/\/sandbox\.payment\.bkash\.com\/\?paymentId=TR0011E2E/);
    const paymentID = sessionBody.data.sessionKey;
    expect(bank.payments.get(paymentID)).toMatchObject({ amount: "1060.00", status: "Initiated" });

    // The buyer authorises on bKash and is sent back; bKash appends paymentID and status.
    bank.payments.get(paymentID)!.authorized = true;
    const createCall = bank.fetch.mock.calls.find(([url]) => String(url).endsWith("/create"))!;
    const callbackURL = String((JSON.parse(String(createCall[1]?.body)) as { callbackURL: string }).callbackURL);
    expect(callbackURL).toMatch(/^https:\/\/api\.shop\.test\/api\/v1\/payment\/scalius\.bkash(?::|%3A)bkash\/success\?/);
    const back = new URL(callbackURL);
    back.searchParams.set("paymentID", paymentID);
    back.searchParams.set("status", "success");
    const returned = await request("GET", `${back.pathname.replace("/api/v1", "")}${back.search}`);
    expect(returned.status).toBe(302);
    expect(returned.headers.get("location")).toContain(`/order-success?orderId=${orderId}`);
    // A repeated return (the buyer reloads) applies nothing new.
    await request("GET", `${back.pathname.replace("/api/v1", "")}${back.search}`);

    // Applied after the return's response, once: one processed payment event.
    expect(sqlite.prepare("SELECT status FROM webhook_events WHERE order_id = ?").all(orderId)).toEqual([{ status: "processed" }]);
    expect(sqlite.prepare("SELECT payment_status, paid_amount_minor FROM orders WHERE id = ?").get(orderId))
      .toEqual({ payment_status: PaymentStatus.PAID, paid_amount_minor: 106_000 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM order_payments WHERE order_id = ? AND status = 'succeeded'").get(orderId)).toEqual({ n: 1 });
    expect(bank.calls.filter((path) => path === "execute")).toHaveLength(2);
  });

  it("does not offer or charge through the app once it is deactivated", async () => {
    sqlite.prepare("UPDATE plugin_installations SET status = 'disabled' WHERE plugin_id = 'scalius.bkash'").run();
    const config = await (await request("GET", "/checkout/config")).json() as { data: { gateways: Array<{ id: string }> } };
    expect(config.data.gateways.map((gateway) => gateway.id)).not.toContain(METHOD);
    expect(bank.calls).toEqual([]);
  });
});
