// The Bangladesh pack's SSLCommerz end to end through the platform (bundled
// loader, migrated schema, the Worker's own payment routes and queue
// consumer, a simulated SSLCommerz): a store that took SSLCommerz payments in
// core before the move.
//
// - Until the pack is active, SSLCommerz is never offered, a session is
//   refused, the old IPN URL answers 503 (SSLCommerz retries) and a refund
//   stops before any provider call, all with the pack's reason.
// - Activation moves the saved keys into the pack's sealed settings (only
//   empty ones; the old sandbox flag becomes the environment), replaces the
//   checkout choice in place, clears the old document, and repoints the
//   payments still under way. Settled orders keep `sslcommerz`. A second
//   handoff changes nothing.
// - Then the URLs SSLCommerz already holds keep working: an IPN at
//   /webhooks/sslcommerz is validated by the pack and credits the order once
//   (a repeat is a duplicate, a tampered one changes nothing), a cancel at
//   /payment/sslcommerz/cancel releases its attempt, and the old settled
//   payment refunds through the pack.
import { OpenAPIHono } from "@hono/zod-openapi";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, type Database } from "@scalius/database/client";
import * as schema from "@scalius/database/schema";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { getActivePaymentMethods, processRefund } from "@scalius/core/modules/payments";
import { installPlugin, readPluginRuntimeSettings, requirePluginInstallation } from "@scalius/core/modules/plugins";
import { checkoutDocument, currencyDocument, paymentMethodsDocument, sslcommerzDocument } from "@scalius/core/modules/settings";
import { errorResponseFromError } from "../utils/api-response";
import { paymentRoutes } from "../routes/payment/payment-routes";
import { paymentWebhookRoutes } from "../routes/webhooks/payments";
import type { PaymentEventQueueMessage } from "../routes/payment/payment-events";
import { handleQueueBatch } from "../queue-consumer";
import { BUNDLED_PLUGINS } from "./bundled.gen";
import { activatePluginWithHooks } from "./lifecycle";
import { handOffRetiredProviders } from "./provider-handoff";
import { appPaymentProvidersLoader } from "./providers/payment";
import { pluginTestCtx } from "./testing/fixtures";
import { manifest as packManifest } from "../../../../plugins/bangladesh/src/index";

const PACK = "scalius.bangladesh";
const METHOD = "scalius.bangladesh:sslcommerz";
const KEY = Buffer.alloc(32, 7).toString("base64");
const LIVE = "https://securepay.sslcommerz.com";
const LIMITER = { limit: async () => ({ success: true }) };

/** SSLCommerz's validation, transaction and refund APIs as the pack calls them. */
function fakeSslcommerz() {
  const validations = new Map<string, Record<string, string>>();
  const calls: URL[] = [];
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push(url);
    if (url.origin !== LIVE) return new Response("unexpected host", { status: 599 });
    if (url.pathname === "/validator/api/validationserverAPI.php") {
      const answer = validations.get(url.searchParams.get("val_id") ?? "");
      return Response.json(answer ?? { status: "INVALID_TRANSACTION" });
    }
    if (url.pathname === "/validator/api/merchantTransIDvalidationAPI.php" && url.searchParams.has("refund_amount")) {
      return Response.json({ APIConnect: "DONE", status: "success", refund_ref_id: "REFE2E1", bank_tran_id: url.searchParams.get("bank_tran_id") });
    }
    return new Response("not found", { status: 404 });
  });
  return { fetch, calls, validations };
}

describe("the Bangladesh pack takes over a store's SSLCommerz", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let env: Env;
  let sent: PaymentEventQueueMessage[];
  let gateway: ReturnType<typeof fakeSslcommerz>;

  beforeEach(async () => {
    let binding: D1Database;
    ({ sqlite, binding } = createSqliteD1Database());
    sent = [];
    env = {
      DB: binding,
      CACHE: { get: async () => null, put: async () => undefined, delete: async () => undefined },
      RL_STANDARD: LIMITER,
      RL_STRICT: LIMITER,
      JOBS_QUEUE: { send: vi.fn(async (message: PaymentEventQueueMessage) => { sent.push(message); }), sendBatch: async () => undefined },
      JWT_SECRET: "sslcommerz-e2e-secret-0123456789abcdef",
      SCALIUS_SECRET: "sslcommerz-e2e-master-secret-0123456789abcdefghijk",
      CREDENTIAL_ENCRYPTION_KEY: KEY,
      PUBLIC_API_BASE_URL: "https://api.shop.test",
      STOREFRONT_URL: "https://shop.test",
    } as unknown as Env;
    db = getDb(env);
    gateway = fakeSslcommerz();
    vi.stubGlobal("fetch", gateway.fetch);
    for (const level of ["info", "warn", "error", "log"] as const) vi.spyOn(console, level).mockImplementation(() => undefined);

    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
    // Saved in core before the move: live SSLCommerz, on, and offered first.
    await currencyDocument.write(db, { currencyCode: "BDT" });
    await checkoutDocument.write(db, { checkoutMode: "all", partialPaymentEnabled: false, partialPaymentAmount: 0 });
    await sslcommerzDocument.write(db, { storeId: "shop01live", storePassword: "store-pass-xyz", sandbox: false, enabled: true }, { encryptionKey: KEY });
    await paymentMethodsDocument.write(db, { enabledMethods: ["sslcommerz", "cod"], defaultMethod: "sslcommerz" });
    const order = (id: string, values: Partial<typeof schema.orders.$inferInsert>) => db.insert(schema.orders).values({
      id, customerName: "Buyer", customerPhone: "+8801712345678", shippingAddress: "House 1", city: "Dhaka", zone: "Gulshan",
      totalAmountMinor: 16_000, subtotalAmountMinor: 16_000, balanceDueMinor: 16_000, currencyCode: "BDT", currencyDecimalPlaces: 2,
      paymentMethod: "sslcommerz", paymentStatus: "unpaid", status: "incomplete", ...values,
    });
    // Two checkouts on SSLCommerz's page at the deploy, and one order paid long ago.
    await order("ORDFLY", {});
    await order("ORDQUIT", {});
    await order("ORDPAID", { status: "delivered", paymentStatus: "paid", paidAmountMinor: 16_000, balanceDueMinor: 0 });
    const attempt = (id: string, orderId: string) => ({
      id, attemptKey: `key_${id}`, orderId, gateway: "sslcommerz", paymentType: "full", amountMinor: 16_000, currency: "BDT",
      requestHash: "h", status: "created", providerSessionId: `SESS${id}`, providerCorrelationId: `${orderId}_full_ABC12345`,
    });
    await db.insert(schema.paymentSessionAttempts).values([attempt("psa1", "ORDFLY"), attempt("psa2", "ORDQUIT")]);
    await db.insert(schema.orderPayments).values({
      id: "pay_old", orderId: "ORDPAID", amountMinor: 16_000, currency: "BDT", settlementAmountMinor: 16_000, paymentMethod: "sslcommerz",
      paymentType: "full", status: "succeeded", providerRef: "val_old", providerSecondaryRef: "bank_old",
    });
    await installPlugin(db, { manifest: packManifest, source: "bundled", bundleSha256: BUNDLED_PLUGINS[PACK]!.sha256, actorUserId: "owner" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    sqlite.close();
  });

  const providers = () => appPaymentProvidersLoader(env, db, pluginTestCtx());
  const activate = async () => {
    const current = await requirePluginInstallation(db, PACK);
    const { pluginGrantKey, pluginGrantRequest } = await import("@scalius/shared/plugins/manifest");
    return activatePluginWithHooks({ db, env, ctx: pluginTestCtx() }, PACK, {
      actorUserId: "owner",
      expectedRevision: current.revision,
      expectedGrantKey: pluginGrantKey(pluginGrantRequest(current.manifest)),
    });
  };
  function api() {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
    app.onError((error, c) => c.json(errorResponseFromError(error).body, errorResponseFromError(error).status));
    app.use("*", async (c, next) => {
      c.set("db", getDb(env));
      await next();
    });
    app.route("/payment", paymentRoutes);
    app.route("/webhooks", paymentWebhookRoutes);
    return app;
  }
  const form = (path: string, body: Record<string, string>) => api().request(`https://api.shop.test/api/v1${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  }, env, pluginTestCtx());
  async function deliver() {
    const messages = sent.splice(0).map((body, index) => ({ id: `m${index}`, timestamp: new Date(), attempts: 1, body, ack: vi.fn(), retry: vi.fn() }));
    await handleQueueBatch({ queue: "jobs", messages, ackAll: vi.fn(), retryAll: vi.fn() } as never, env);
    return messages;
  }
  const row = (sql: string, ...params: string[]) => sqlite.prepare(sql).get(...params) as Record<string, unknown>;
  const validated = (orderId: string, valId: string, amount = "160.00") => gateway.validations.set(valId, {
    status: "VALID", tran_id: `${orderId}_full_ABC12345`, val_id: valId, amount, currency_type: "BDT",
    bank_tran_id: `bank_${valId}`, value_a: "full", value_b: orderId, card_type: "VISA-Dutch Bangla",
  });

  it("fails closed until activation, then moves the setup, repoints the open payments and keeps SSLCommerz's URLs", { timeout: 60_000 }, async () => {
    // Before activation: never offered, the IPN asks SSLCommerz to retry, a refund stops before any call.
    await expect(getActivePaymentMethods(db, KEY, providers())).resolves.toEqual({ enabledMethods: ["cod"], defaultMethod: "cod" });
    validated("ORDFLY", "val_fly");
    const early = await form("/webhooks/sslcommerz", { val_id: "val_fly", tran_id: "ORDFLY_full_ABC12345" });
    expect(early.status).toBe(503);
    await expect(processRefund(db, { orderId: "ORDPAID", amount: 50, reason: "requested_by_customer" }, KEY, providers()))
      .rejects.toThrow("Activate Bangladesh pack in Apps");
    expect(gateway.calls).toEqual([]);

    expect((await activate()).hookError).toBeNull();

    // The keys moved, sealed; the old sandbox flag (off) is the live environment.
    const installation = await requirePluginInstallation(db, PACK);
    const settings = await readPluginRuntimeSettings(installation, KEY);
    expect(settings.values).toMatchObject({
      sslcommerz_store_id: "shop01live", sslcommerz_store_password: "store-pass-xyz", sslcommerz_environment: "live",
    });
    expect(JSON.stringify(installation.storedSettings)).not.toContain("store-pass-xyz");
    // The choice is replaced in place, the old document cleared.
    expect(await paymentMethodsDocument.read(db)).toEqual({ enabledMethods: [METHOD, "cod"], defaultMethod: METHOD });
    expect(await sslcommerzDocument.read(db, { encryptionKey: KEY })).toMatchObject({ storeId: "", storePassword: "", enabled: false });
    // Open payments name the pack's gateway; a settled order keeps the old id.
    expect(row("SELECT payment_method FROM orders WHERE id = 'ORDFLY'")).toEqual({ payment_method: METHOD });
    expect(row("SELECT gateway FROM payment_session_attempts WHERE id = 'psa1'")).toEqual({ gateway: METHOD });
    expect(row("SELECT payment_method FROM orders WHERE id = 'ORDPAID'")).toEqual({ payment_method: "sslcommerz" });
    expect(row("SELECT payment_method FROM order_payments WHERE id = 'pay_old'")).toEqual({ payment_method: "sslcommerz" });
    // A second handoff finds nothing left to move.
    await expect(handOffRetiredProviders(db, PACK, KEY)).resolves.toEqual({ moved: [], skipped: [], repointed: [] });
    await expect(getActivePaymentMethods(db, KEY, providers())).resolves.toEqual({ enabledMethods: [METHOD, "cod"], defaultMethod: METHOD });

    // The IPN URL SSLCommerz holds: validated server to server, credited once.
    const ipn = await form("/webhooks/sslcommerz", { val_id: "val_fly", tran_id: "ORDFLY_full_ABC12345", amount: "1.00" });
    expect([ipn.status, await ipn.json()]).toEqual([200, { received: true }]);
    expect(gateway.calls.at(-1)?.pathname).toBe("/validator/api/validationserverAPI.php");
    const repeat = await form("/webhooks/sslcommerz", { val_id: "val_fly" });
    expect(await repeat.json()).toMatchObject({ duplicate: true });
    const delivered = await deliver();
    expect(delivered.every((message) => message.retry.mock.calls.length === 0)).toBe(true);
    expect(row("SELECT payment_status, paid_amount_minor FROM orders WHERE id = 'ORDFLY'")).toEqual({ payment_status: "paid", paid_amount_minor: 16_000 });
    expect(row("SELECT count(*) AS n FROM order_payments WHERE order_id = 'ORDFLY' AND status = 'succeeded'")).toEqual({ n: 1 });

    // A tampered IPN (the validation answers for another payment) changes nothing.
    sent.length = 0;
    gateway.validations.set("val_fake", { ...gateway.validations.get("val_fly")!, val_id: "val_other" });
    const tampered = await form("/webhooks/sslcommerz", { val_id: "val_fake" });
    expect(tampered.status).toBe(200);
    expect(sent).toEqual([]);

    // The cancel URL sent with the old session releases its attempt.
    const cancelled = await form("/payment/sslcommerz/cancel", { tran_id: "ORDQUIT_full_ABC12345", status: "CANCELLED" });
    expect(cancelled.status).toBe(302);
    expect(cancelled.headers.get("location")).toContain("orderId=ORDQUIT");
    expect(row("SELECT status FROM payment_session_attempts WHERE id = 'psa2'")).toEqual({ status: "failed" });

    // The payment taken before the move refunds through the pack.
    const refund = await processRefund(db, { orderId: "ORDPAID", amount: 50, reason: "requested_by_customer" }, KEY, providers());
    expect(refund).toMatchObject({ success: true, gateway: "sslcommerz", refundId: "REFE2E1" });
    const refundCall = gateway.calls.find((url) => url.searchParams.has("refund_amount"))!;
    expect(Object.fromEntries(refundCall.searchParams)).toMatchObject({ bank_tran_id: "bank_old", refund_amount: "50.00", store_id: "shop01live" });
  });

  it("drops a choice the merchant had turned off and never overwrites a key already set in the pack", { timeout: 30_000 }, async () => {
    await sslcommerzDocument.write(db, { enabled: false }, { encryptionKey: KEY });
    const { writePluginSettings } = await import("@scalius/core/modules/plugins");
    const current = await requirePluginInstallation(db, PACK);
    await writePluginSettings(db, PACK, { sslcommerz_store_id: "packstore" }, { expectedRevision: current.revision, credentialEncryptionKey: KEY });

    expect((await activate()).hookError).toBeNull();

    const settings = await readPluginRuntimeSettings(await requirePluginInstallation(db, PACK), KEY);
    expect(settings.values).toMatchObject({ sslcommerz_store_id: "packstore", sslcommerz_store_password: "store-pass-xyz", sslcommerz_environment: "live" });
    // It was off: checkout offered only cash, and still does.
    expect(await paymentMethodsDocument.read(db)).toEqual({ enabledMethods: ["cod"], defaultMethod: "cod" });
  });
});
