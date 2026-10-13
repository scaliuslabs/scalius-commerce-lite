// Behaviour tests for the gateway-agnostic payment routes on the migrated
// SQLite schema: session creation, webhook and buyer-return claim-once (a
// test-only app gateway in the request's providers), queue application that
// credits an order exactly once, and a retired built-in id (`sslcommerz`)
// failing closed until the app that replaced it is active.
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
} from "@scalius/core/modules/settings";
import { recordOrderReceipt } from "@scalius/core/modules/orders";
import { PaymentProviderError, type PaymentEvent } from "@scalius/core/modules/payments";
import { createFakeGateway, FAKE_GATEWAY_ID, type FakeGatewayState } from "@scalius/core/testing";
import type { PaymentProviders } from "@scalius/core/modules/payments";

import { errorResponseFromError } from "../../utils/api-response";
import { paymentWebhookRoutes } from "../webhooks/payments";
import { paymentRoutes } from "./payment-routes";

const CREDENTIAL_ENCRYPTION_KEY = btoa("p".repeat(32));
const RECEIPT = "chk_receipt_token_for_tests";

let sqlite: DatabaseSync;
let db: Database;
let binding: D1Database;
let env: Env;
const fetchMock = vi.fn();

// The request's gateways: an app gateway joins them the way an installed app does.
const requestProviders = vi.hoisted(() => ({ current: null as PaymentProviders | null }));
vi.mock("../../plugins/providers/payment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/providers/payment")>();
  return {
    ...actual,
    requestPaymentProviders: (...args: Parameters<typeof actual.requestPaymentProviders>) =>
      requestProviders.current ? Promise.resolve(requestProviders.current) : actual.requestPaymentProviders(...args),
  };
});

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

async function seed(options: { paymentMethod: string; enabledMethods: string[] }) {
  await checkoutDocument.write(db, { checkoutMode: "all", partialPaymentEnabled: false, partialPaymentAmount: 0 });
  await paymentMethodsDocument.write(db, { enabledMethods: options.enabledMethods, defaultMethod: options.enabledMethods[0]! });
  await currencyDocument.write(db, { currencyCode: "BDT" });
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
  env = {
    CREDENTIAL_ENCRYPTION_KEY,
    DB: binding,
    STOREFRONT_URL: "https://shop.example.test",
    PUBLIC_API_BASE_URL: "https://api.example.test",
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
  let fake: ReturnType<typeof createFakeGateway>;

  beforeEach(() => {
    fake = createFakeGateway();
    requestProviders.current = fake.providers;
  });
  afterEach(() => {
    requestProviders.current = null;
  });

  it("claims the attempt locally, calls the provider once, and replays the stored session", async () => {
    await seed({ paymentMethod: FAKE_GATEWAY_ID, enabledMethods: [FAKE_GATEWAY_ID, "cod"] });
    const app = createApp();

    const path = `/payment/${FAKE_GATEWAY_ID}/session`;
    const first = await post(app, path, { orderId: "order_1" }, { "X-Receipt-Token": RECEIPT });
    const second = await post(app, path, { orderId: "order_1" }, { "X-Receipt-Token": RECEIPT });

    const [session] = fake.state.sessions;
    expect(fake.state.sessions).toHaveLength(1);
    const expected = { success: true, data: { gatewayUrl: `https://pay.fake.test/${session!.correlationId}`, sessionKey: `fs_${session!.attemptKey.slice(-8)}` } };
    await expect(first.json()).resolves.toEqual(expected);
    await expect(second.json()).resolves.toEqual(expected);

    expect(session).toMatchObject({ orderId: "order_1", amountMinor: 150_000, wireAmount: { decimal: "1500.00" } });
    expect(session!.urls.webhook).toBe(`https://api.example.test/api/v1/webhooks/${encodeURIComponent(FAKE_GATEWAY_ID)}`);
    expect(session!.urls.success).toMatch(new RegExp(`^https://api\\.example\\.test/api/v1/payment/${encodeURIComponent(FAKE_GATEWAY_ID)}/success\\?order_id=order_1`));

    const attempt = sqlite.prepare("SELECT gateway, status, provider_session_id, provider_correlation_id FROM payment_session_attempts").get() as Record<string, string>;
    expect(attempt).toMatchObject({ gateway: FAKE_GATEWAY_ID, status: "created", provider_session_id: expected.data.sessionKey });
    expect(session!.correlationId).toBe(attempt.provider_correlation_id);
    expect(sqlite.prepare("SELECT payment_intent_id FROM orders").get()).toEqual({ payment_intent_id: expected.data.sessionKey });
  });

  it("fails closed without calling the provider when the gateway is not selected or not configured", async () => {
    await seed({ paymentMethod: FAKE_GATEWAY_ID, enabledMethods: ["cod"] });
    const app = createApp();
    const path = `/payment/${FAKE_GATEWAY_ID}/session`;
    expect((await post(app, path, { orderId: "order_1", receiptToken: RECEIPT })).status).toBe(503);

    sqlite.prepare("UPDATE settings SET value = ? WHERE category = 'payment_methods' AND key = 'document'")
      .run(JSON.stringify({ enabledMethods: [FAKE_GATEWAY_ID], defaultMethod: FAKE_GATEWAY_ID }));
    fake.state.settings = { enabled: true, apiKey: "dummy" };
    expect((await post(app, path, { orderId: "order_1", receiptToken: RECEIPT })).status).toBe(503);

    expect((await post(app, "/payment/unknownpay/session", { orderId: "order_1", receiptToken: RECEIPT })).status).toBe(400);
    expect(fake.state.sessions).toEqual([]);
    expect(sqlite.prepare("SELECT count(*) AS n FROM payment_session_attempts").get()).toEqual({ n: 0 });
  });

  it("records a provider rejection on the attempt and lets the buyer retry", async () => {
    await seed({ paymentMethod: FAKE_GATEWAY_ID, enabledMethods: [FAKE_GATEWAY_ID] });
    const createSession = fake.gateway.createSession;
    fake.gateway.createSession = vi.fn(createSession).mockRejectedValueOnce(new PaymentProviderError("Store is inactive"));
    const app = createApp();
    const path = `/payment/${FAKE_GATEWAY_ID}/session`;

    const rejected = await post(app, path, { orderId: "order_1", receiptToken: RECEIPT });
    expect(rejected.status).toBe(500);
    await expect(rejected.json()).resolves.toMatchObject({ error: { code: "PAYMENT_ERROR", message: "Store is inactive" } });
    expect(sqlite.prepare("SELECT status FROM payment_session_attempts").get()).toEqual({ status: "failed" });

    expect((await post(app, path, { orderId: "order_1", receiptToken: RECEIPT })).status).toBe(200);
    expect(fake.gateway.createSession).toHaveBeenCalledTimes(2);
  });

  it("refuses a session for a retired SSLCommerz order until the Bangladesh pack is active, calling nothing", async () => {
    requestProviders.current = null;
    await seed({ paymentMethod: "sslcommerz", enabledMethods: ["sslcommerz", "cod"] });
    const response = await post(createApp(), "/payment/sslcommerz/session", { orderId: "order_1", receiptToken: RECEIPT });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { message: "SSLCommerz: Activate Bangladesh pack in Apps to use it." } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT count(*) AS n FROM payment_session_attempts").get()).toEqual({ n: 0 });
  });
});

describe("an app gateway: webhooks, returns, and queue application", () => {
  let state: FakeGatewayState;

  beforeEach(() => {
    const fake = createFakeGateway();
    state = fake.state;
    requestProviders.current = fake.providers;
  });
  afterEach(() => {
    requestProviders.current = null;
  });

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
    return post(app, `/webhooks/${FAKE_GATEWAY_ID}`, body, { "x-fake-signature": signature });
  }

  it("rejects an unauthenticated callback before any state change and claims an authentic one once", async () => {
    await seed({ paymentMethod: FAKE_GATEWAY_ID, enabledMethods: ["cod"] });
    const app = createApp();

    expect((await webhook(app, event, "forged")).status).toBe(400);
    expect(sqlite.prepare("SELECT count(*) AS n FROM webhook_events").get()).toEqual({ n: 0 });

    await expect((await webhook(app, event)).json()).resolves.toEqual({ received: true });
    await expect((await webhook(app, event)).json()).resolves.toMatchObject({ received: true, duplicate: true });
    // The claim keeps the provider id's shape in the claim alphabet and the
    // event as its payload; without an execution context it is applied before
    // the response.
    expect(sqlite.prepare("SELECT id, event_type, status, attempts, payload FROM webhook_events").get()).toEqual({
      id: "acme-fake:pay:charge:evt_1",
      event_type: "payment.confirmed",
      status: "processed",
      attempts: 1,
      payload: JSON.stringify({ provider: FAKE_GATEWAY_ID, event }),
    });
    expect((await post(app, "/webhooks/unknownpay", event)).status).toBe(404);
  });

  it("applies a webhook racing the buyer return once, and credits the order once", async () => {
    await seed({ paymentMethod: FAKE_GATEWAY_ID, enabledMethods: ["cod"] });
    const app = createApp();

    // The buyer return verifies the same provider fact as the webhook.
    const buyerReturn = await app.request(`/api/v1/payment/${FAKE_GATEWAY_ID}/success?order_id=order_1&payment_type=full`, {
      method: "POST",
      headers: { "x-fake-signature": "live_key" },
      body: JSON.stringify(event),
    }, env);
    expect(buyerReturn.status).toBe(302);
    expect(buyerReturn.headers.get("location"))
      .toBe(`https://shop.example.test/order-success?orderId=order_1&payment=${encodeURIComponent(FAKE_GATEWAY_ID)}&paymentType=full`);
    await expect((await webhook(app, event)).json()).resolves.toMatchObject({ duplicate: true });

    // A provider resend under a different event id is claimed too; the kernel
    // still credits the provider reference once.
    await webhook(app, { ...event, eventId: "evt_resend" });

    expect(sqlite.prepare("SELECT status, payment_status, paid_amount_minor FROM orders").get())
      .toEqual({ status: OrderStatus.PENDING, payment_status: PaymentStatus.PAID, paid_amount_minor: 150_000 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM order_payments WHERE status = 'succeeded'").get()).toEqual({ n: 1 });
    expect(sqlite.prepare("SELECT status FROM webhook_events ORDER BY id").all())
      .toEqual([{ status: "processed" }, { status: "processed" }]);
    expect(state.sessions).toEqual([]);
  });
});
