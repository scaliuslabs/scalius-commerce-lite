// Behaviour tests for the gateway-agnostic payment routes on the migrated
// SQLite schema: session creation (SSLCommerz adapter with a stubbed provider),
// webhook and buyer-return claim-once (a test-only adapter registered with one
// registry line), and queue application that credits an order exactly once.
import { OpenAPIHono } from "@hono/zod-openapi";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { orders, OrderStatus, PaymentStatus } from "@scalius/database/schema";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
  checkoutDocument,
  currencyDocument,
  paymentMethodsDocument,
  sslcommerzDocument,
} from "@scalius/core/modules/settings/documents";
import { recordOrderReceipt } from "@scalius/core/modules/orders/order-receipts";
import type { PaymentEvent } from "@scalius/core/modules/payments/gateways/port";
import { registerFakeGateway, type FakeGatewayState } from "@scalius/core/modules/payments/gateways/testing";

import { errorResponseFromError } from "../../utils/api-response";
import { handleQueueBatch } from "../../queue-consumer";
import { paymentWebhookRoutes } from "../webhooks/payments";
import { paymentRoutes } from "./payment-routes";
import type { PaymentEventQueueMessage } from "./payment-events";

const CREDENTIAL_ENCRYPTION_KEY = btoa("p".repeat(32));
const RECEIPT = "chk_receipt_token_for_tests";

let sqlite: DatabaseSync;
let db: Database;
let binding: D1Database;
let sent: PaymentEventQueueMessage[];
let env: Env;
const fetchMock = vi.fn();

function createApp() {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/payment", paymentRoutes);
  app.route("/webhooks", paymentWebhookRoutes);
  return app;
}

async function seed(options: { paymentMethod: string; enabledMethods: string[]; sslPassword?: string }) {
  await checkoutDocument.write(db, { checkoutMode: "all", partialPaymentEnabled: false, partialPaymentAmount: 0 });
  await paymentMethodsDocument.write(db, { enabledMethods: options.enabledMethods, defaultMethod: options.enabledMethods[0]! });
  await currencyDocument.write(db, { currencyCode: "BDT" });
  await sslcommerzDocument.write(db, {
    storeId: "real_store_1",
    storePassword: options.sslPassword ?? "real-store-password",
    sandbox: true,
    enabled: true,
  }, { encryptionKey: CREDENTIAL_ENCRYPTION_KEY });
  await db.insert(orders).values({
    id: "order_1",
    customerName: "Buyer",
    customerPhone: "+8801711111111",
    shippingAddress: "House 1, Dhaka",
    city: "dhaka",
    zone: "zone_1",
    totalAmountMinor: 150_000,
    balanceDueMinor: 150_000,
    paymentMethod: options.paymentMethod,
    status: OrderStatus.INCOMPLETE,
    currencyCode: "BDT",
    currencyDecimalPlaces: 2,
  });
  await recordOrderReceipt(db, { orderId: "order_1", token: RECEIPT });
}

function post(app: ReturnType<typeof createApp>, path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(`/api/v1${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }, env);
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  ({ sqlite, db, binding } = createSqliteD1Database());
  sent = [];
  env = {
    CREDENTIAL_ENCRYPTION_KEY,
    DB: binding,
    STOREFRONT_URL: "https://shop.example.test",
    PUBLIC_API_BASE_URL: "https://api.example.test",
    JOBS_QUEUE: { send: vi.fn(async (message: PaymentEventQueueMessage) => { sent.push(message); }) },
  } as unknown as Env;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sqlite.close();
});

describe("POST /payment/{provider}/session", () => {
  it("claims the attempt locally, calls the provider once, and replays the stored session", async () => {
    await seed({ paymentMethod: "sslcommerz", enabledMethods: ["sslcommerz", "cod"] });
    fetchMock.mockImplementation(async () => Response.json({
      status: "SUCCESS",
      GatewayPageURL: "https://sandbox.sslcommerz.com/pay/abc",
      sessionkey: "sess_1",
    }));
    const app = createApp();

    const first = await post(app, "/payment/sslcommerz/session", { orderId: "order_1" }, { "X-Receipt-Token": RECEIPT });
    const second = await post(app, "/payment/sslcommerz/session", { orderId: "order_1" }, { "X-Receipt-Token": RECEIPT });

    const expected = { success: true, data: { gatewayUrl: "https://sandbox.sslcommerz.com/pay/abc", sessionKey: "sess_1" } };
    await expect(first.json()).resolves.toEqual(expected);
    await expect(second.json()).resolves.toEqual(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const form = new URLSearchParams(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(form.get("total_amount")).toBe("1500.00");
    expect(form.get("ipn_url")).toBe("https://api.example.test/api/v1/webhooks/sslcommerz");
    expect(form.get("success_url")).toMatch(/^https:\/\/api\.example\.test\/api\/v1\/payment\/sslcommerz\/success\?order_id=order_1/);
    expect(form.get("value_b")).toBe("order_1");

    const attempt = sqlite.prepare("SELECT gateway, status, provider_session_id, provider_correlation_id FROM payment_session_attempts").get() as Record<string, string>;
    expect(attempt).toMatchObject({ gateway: "sslcommerz", status: "created", provider_session_id: "sess_1" });
    expect(form.get("tran_id")).toBe(attempt.provider_correlation_id);
    expect(sqlite.prepare("SELECT payment_intent_id FROM orders").get()).toEqual({ payment_intent_id: "sess_1" });
  });

  it("fails closed without calling the provider when the gateway is not selected or not configured", async () => {
    await seed({ paymentMethod: "sslcommerz", enabledMethods: ["cod"] });
    const app = createApp();
    expect((await post(app, "/payment/sslcommerz/session", { orderId: "order_1", receiptToken: RECEIPT })).status).toBe(503);

    sqlite.prepare("UPDATE settings SET value = ? WHERE category = 'payment_methods' AND key = 'enabled_methods'")
      .run(JSON.stringify(["sslcommerz"]));
    sqlite.prepare("UPDATE settings SET value = 'dummy' WHERE category = 'sslcommerz' AND key = 'store_id'").run();
    expect((await post(app, "/payment/sslcommerz/session", { orderId: "order_1", receiptToken: RECEIPT })).status).toBe(503);

    expect((await post(app, "/payment/unknownpay/session", { orderId: "order_1", receiptToken: RECEIPT })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT count(*) AS n FROM payment_session_attempts").get()).toEqual({ n: 0 });
  });

  it("records a provider rejection on the attempt and lets the buyer retry", async () => {
    await seed({ paymentMethod: "sslcommerz", enabledMethods: ["sslcommerz"] });
    fetchMock.mockImplementationOnce(async () => Response.json({ status: "FAILED", failedreason: "Store is inactive" }));
    const app = createApp();

    const rejected = await post(app, "/payment/sslcommerz/session", { orderId: "order_1", receiptToken: RECEIPT });
    expect(rejected.status).toBe(500);
    await expect(rejected.json()).resolves.toMatchObject({ error: { code: "PAYMENT_ERROR", message: "Store is inactive" } });
    expect(sqlite.prepare("SELECT status FROM payment_session_attempts").get()).toEqual({ status: "failed" });

    fetchMock.mockImplementationOnce(async () => Response.json({ status: "SUCCESS", GatewayPageURL: "https://x.test/pay", sessionkey: "s2" }));
    expect((await post(app, "/payment/sslcommerz/session", { orderId: "order_1", receiptToken: RECEIPT })).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("a newly registered gateway: webhooks, returns, and queue application", () => {
  let state: FakeGatewayState;
  let unregister: () => void;

  beforeEach(() => {
    ({ state, unregister } = registerFakeGateway());
  });
  afterEach(() => unregister());

  const event: PaymentEvent = {
    kind: "confirmed",
    eventType: "charge",
    eventId: "evt_1",
    orderId: "order_1",
    providerRef: "fp_pay_1",
    secondaryRef: "fp_txn_1",
    amountMinor: 150_000,
    currency: "BDT",
    paymentType: "full",
  };

  function webhook(app: ReturnType<typeof createApp>, body: unknown, signature = "live_key") {
    return post(app, "/webhooks/fakepay", body, { "x-fake-signature": signature });
  }

  it("rejects an unauthenticated callback before any state change and claims an authentic one once", async () => {
    await seed({ paymentMethod: "fakepay", enabledMethods: ["cod"] });
    const app = createApp();

    expect((await webhook(app, event, "forged")).status).toBe(400);
    expect(sqlite.prepare("SELECT count(*) AS n FROM webhook_events").get()).toEqual({ n: 0 });

    await expect((await webhook(app, event)).json()).resolves.toEqual({ received: true });
    await expect((await webhook(app, event)).json()).resolves.toMatchObject({ received: true, duplicate: true });
    expect(sent).toEqual([{
      type: "payment.event",
      provider: "fakepay",
      webhookEventId: "fakepay:charge:evt_1",
      event,
    }]);
    expect(sqlite.prepare("SELECT event_type, status FROM webhook_events").get())
      .toEqual({ event_type: "payment.confirmed", status: "queued" });
    expect((await post(app, "/webhooks/unknownpay", event)).status).toBe(404);
  });

  it("applies a webhook racing the buyer return once, and credits the order once", async () => {
    await seed({ paymentMethod: "fakepay", enabledMethods: ["cod"] });
    const app = createApp();

    // The buyer return verifies the same provider fact as the webhook.
    const buyerReturn = await app.request("/api/v1/payment/fakepay/success?order_id=order_1&payment_type=full", {
      method: "POST",
      headers: { "x-fake-signature": "live_key" },
      body: JSON.stringify(event),
    }, env);
    expect(buyerReturn.status).toBe(302);
    expect(buyerReturn.headers.get("location"))
      .toBe("https://shop.example.test/order-success?orderId=order_1&payment=fakepay&paymentType=full");
    await webhook(app, event);
    expect(sent).toHaveLength(1);

    // A provider resend under a different event id reaches the queue too; the
    // kernel still credits the provider reference once.
    await webhook(app, { ...event, eventId: "evt_resend" });
    expect(sent).toHaveLength(2);
    // Both messages are delivered concurrently; the loser of the provider-ref
    // claim is retried by the queue and then sees the payment already applied.
    const deliver = async (bodies: PaymentEventQueueMessage[]) => {
      const messages = bodies.map((body, index) => ({
        id: `m${index}`, timestamp: new Date(), attempts: 1, body, ack: vi.fn(), retry: vi.fn(),
      }));
      await handleQueueBatch({ queue: "jobs", messages, ackAll: vi.fn(), retryAll: vi.fn() } as never, env);
      return messages.filter((message) => message.retry.mock.calls.length > 0).map((message) => message.body);
    };
    const retried = await deliver(sent);
    expect(retried.length).toBeLessThanOrEqual(1);
    expect(await deliver(retried)).toEqual([]);

    expect(sqlite.prepare("SELECT status, payment_status, paid_amount_minor FROM orders").get())
      .toEqual({ status: OrderStatus.PENDING, payment_status: PaymentStatus.PAID, paid_amount_minor: 150_000 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM order_payments WHERE status = 'succeeded'").get()).toEqual({ n: 1 });
    expect(sqlite.prepare("SELECT status FROM webhook_events ORDER BY id").all())
      .toEqual([{ status: "processed" }, { status: "processed" }]);
    expect(state.sessions).toEqual([]);
  });
});
