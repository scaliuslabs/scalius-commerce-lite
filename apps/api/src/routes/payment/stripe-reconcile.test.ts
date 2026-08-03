import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorResponseFromError } from "../../utils/api-response";
import { ValidationError } from "../../utils/api-error";

const mocks = vi.hoisted(() => ({
  validateReceiptToken: vi.fn(),
  getStripeSettings: vi.fn(),
  retrieveStripePaymentIntent: vi.fn(),
  claimWebhookEvent: vi.fn(),
  markWebhookEventQueued: vi.fn(),
  markWebhookEventFailed: vi.fn(),
}));

vi.mock("../../utils/order-receipt-token", () => ({
  validateReceiptToken: mocks.validateReceiptToken,
}));

vi.mock("@scalius/core/modules/payments/gateway-settings", () => ({
  getStripeSettings: mocks.getStripeSettings,
}));

vi.mock("@scalius/core/modules/payments/stripe", () => ({
  retrieveStripePaymentIntent: mocks.retrieveStripePaymentIntent,
}));

vi.mock("../../utils/webhook-idempotency", () => ({
  buildWebhookEventId: (provider: string, eventType: string, source: string) =>
    `${provider}:${eventType}:${source}`,
  claimWebhookEvent: mocks.claimWebhookEvent,
  markWebhookEventQueued: mocks.markWebhookEventQueued,
  markWebhookEventFailed: mocks.markWebhookEventFailed,
}));

vi.mock("./payment-session-create", () => ({
  createStripePaymentSession: vi.fn(),
  isPaymentSessionProcessingResult: vi.fn(() => false),
}));

import { stripePaymentRoutes } from "./stripe-routes";

type OrderRow = {
  id: string;
  paymentMethod: string;
  paymentStatus: string;
  paymentIntentId: string | null;
};

function createApp(order: OrderRow | null = {
  id: "order_1",
  paymentMethod: "stripe",
  paymentStatus: "unpaid",
  paymentIntentId: "pi_1",
}) {
  const db = {
    select: vi.fn(() => {
      const query = {
        from: vi.fn(() => query),
        where: vi.fn(() => query),
        get: vi.fn(async () => order),
      };
      return query;
    }),
  };
  const queue = { send: vi.fn(async () => undefined) };
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/payment/stripe", stripePaymentRoutes);

  const env = {
    CACHE: {},
    CREDENTIAL_ENCRYPTION_KEY: "credential-key",
    PAYMENT_EVENTS_QUEUE: queue,
  } as never;
  return { app, db, env, queue };
}

function reconcileRequest(app: ReturnType<typeof createApp>["app"], env: Env) {
  return app.request(
    "/api/v1/payment/stripe/reconcile",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: "order_1", receiptToken: "receipt-proof" }),
    },
    env,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.validateReceiptToken.mockResolvedValue(undefined);
  mocks.getStripeSettings.mockResolvedValue({
    enabled: true,
    secretKey: "sk_test",
    credentialErrors: [],
  });
  mocks.retrieveStripePaymentIntent.mockResolvedValue({
    success: true,
    paymentIntent: {
      id: "pi_1",
      status: "succeeded",
      amountReceived: 507740,
      currency: "bdt",
      chargeId: "ch_1",
      metadata: { orderId: "order_1", paymentType: "full" },
    },
  });
  mocks.claimWebhookEvent.mockResolvedValue({ claimed: true });
  mocks.markWebhookEventQueued.mockResolvedValue(undefined);
  mocks.markWebhookEventFailed.mockResolvedValue(undefined);
});

describe("Stripe receipt reconciliation", () => {
  it("fails closed before provider access when private receipt proof is invalid", async () => {
    mocks.validateReceiptToken.mockRejectedValueOnce(new ValidationError("Invalid receipt token"));
    const { app, env, queue } = createApp();
    const response = await reconcileRequest(app, env);

    expect(response.status).toBe(400);
    expect(mocks.getStripeSettings).not.toHaveBeenCalled();
    expect(mocks.retrieveStripePaymentIntent).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("queues a provider-verified succeeded PaymentIntent", async () => {
    const { app, env, queue } = createApp();
    const response = await reconcileRequest(app, env);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      success: true,
      data: { status: "scheduled", providerStatus: "succeeded" },
    });
    expect(queue.send).toHaveBeenCalledWith({
      type: "payment.stripe.confirmed",
      orderId: "order_1",
      paymentIntentId: "pi_1",
      amount: 507740,
      currency: "bdt",
      chargeId: "ch_1",
      metadata: { orderId: "order_1", paymentType: "full" },
      webhookEventId: "stripe:payment_intent.succeeded:buyer-reconcile:pi_1",
    });
  });

  it("does not queue an unsettled provider status", async () => {
    mocks.retrieveStripePaymentIntent.mockResolvedValueOnce({
      success: true,
      paymentIntent: {
        id: "pi_1",
        status: "requires_payment_method",
        amountReceived: 0,
        currency: "bdt",
        chargeId: null,
        metadata: { orderId: "order_1" },
      },
    });
    const { app, env, queue } = createApp();
    const response = await reconcileRequest(app, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { status: "pending", providerStatus: "requires_payment_method" },
    });
    expect(queue.send).not.toHaveBeenCalled();
    expect(mocks.claimWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects a PaymentIntent whose trusted metadata belongs to another order", async () => {
    mocks.retrieveStripePaymentIntent.mockResolvedValueOnce({
      success: true,
      paymentIntent: {
        id: "pi_1",
        status: "succeeded",
        amountReceived: 507740,
        currency: "bdt",
        chargeId: "ch_1",
        metadata: { orderId: "order_other" },
      },
    });
    const { app, env, queue } = createApp();
    const response = await reconcileRequest(app, env);

    expect(response.status).toBe(400);
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("does not probe Stripe again after the local order is paid", async () => {
    const { app, env, queue } = createApp({
      id: "order_1",
      paymentMethod: "stripe",
      paymentStatus: "paid",
      paymentIntentId: "pi_1",
    });
    const response = await reconcileRequest(app, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { status: "settled", providerStatus: "succeeded" },
    });
    expect(mocks.retrieveStripePaymentIntent).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("does not enqueue a second event when reconciliation was already claimed", async () => {
    mocks.claimWebhookEvent.mockResolvedValueOnce({
      claimed: false,
      existing: { status: "queued" },
    });
    const { app, env, queue } = createApp();
    const response = await reconcileRequest(app, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { status: "scheduled", providerStatus: "succeeded" },
    });
    expect(queue.send).not.toHaveBeenCalled();
  });
});
