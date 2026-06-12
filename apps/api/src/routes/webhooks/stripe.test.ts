import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const mocks = vi.hoisted(() => ({
  event: {
    id: "evt_stripe_1",
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: "pi_1",
        amount_received: 1234,
        currency: "usd",
        latest_charge: "ch_1",
        metadata: { orderId: "ord_1", paymentType: "full" },
      },
    },
  },
  getStripeSettings: vi.fn(),
  verifyStripeWebhook: vi.fn(),
  claimWebhookEvent: vi.fn(),
  markWebhookEventQueued: vi.fn(),
  markWebhookEventProcessed: vi.fn(),
  markWebhookEventFailed: vi.fn(),
}));

vi.mock("@scalius/core/modules/payments/gateway-settings", () => ({
  getStripeSettings: mocks.getStripeSettings,
}));

vi.mock("@scalius/core/modules/payments/stripe", () => ({
  verifyStripeWebhook: mocks.verifyStripeWebhook,
}));

vi.mock("../../utils/encryption-key", () => ({
  getEncryptionKey: vi.fn(() => "test-key"),
}));

vi.mock("../../utils/webhook-idempotency", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/webhook-idempotency")>();
  return {
    ...actual,
    claimWebhookEvent: mocks.claimWebhookEvent,
    markWebhookEventQueued: mocks.markWebhookEventQueued,
    markWebhookEventProcessed: mocks.markWebhookEventProcessed,
    markWebhookEventFailed: mocks.markWebhookEventFailed,
  };
});

import { stripeWebhookRoutes } from "./stripe";

function createApp(db: unknown) {
  const app = new Hono<{ Bindings: Env; Variables: { db: unknown } }>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/", stripeWebhookRoutes);
  return app;
}

async function postWebhook(
  app: ReturnType<typeof createApp>,
  env: Partial<Env> = {},
) {
  return app.request(
    "/",
    {
      method: "POST",
      headers: { "Stripe-Signature": "sig_test" },
      body: JSON.stringify({ ok: true }),
    },
    env,
  );
}

describe("Stripe webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    mocks.event = {
      id: "evt_stripe_1",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_1",
          amount_received: 1234,
          currency: "usd",
          latest_charge: "ch_1",
          metadata: { orderId: "ord_1", paymentType: "full" },
        },
      },
    };
    mocks.getStripeSettings.mockResolvedValue({
      secretKey: "sk_test",
      webhookSecret: "whsec_test",
    });
    mocks.verifyStripeWebhook.mockResolvedValue(mocks.event);
    mocks.claimWebhookEvent.mockResolvedValue({ claimed: true });
    mocks.markWebhookEventQueued.mockResolvedValue(undefined);
    mocks.markWebhookEventProcessed.mockResolvedValue(undefined);
    mocks.markWebhookEventFailed.mockResolvedValue(undefined);
  });

  it("claims a durable event before enqueueing and marks it queued after queue send", async () => {
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const app = createApp({ id: "db" });

    const response = await postWebhook(app, { PAYMENT_EVENTS_QUEUE: queue as unknown as Queue });

    expect(response.status).toBe(200);
    expect(mocks.claimWebhookEvent).toHaveBeenCalledWith(
      { id: "db" },
      expect.objectContaining({
        id: "stripe:payment_intent-succeeded:evt_stripe_1",
        provider: "stripe",
        eventType: "payment_intent.succeeded",
        orderId: "ord_1",
        status: "processing",
      }),
    );
    expect(queue.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "payment.stripe.confirmed",
      orderId: "ord_1",
      paymentIntentId: "pi_1",
    }));
    expect(mocks.claimWebhookEvent.mock.invocationCallOrder[0]!)
      .toBeLessThan(queue.send.mock.invocationCallOrder[0]!);
    expect(queue.send.mock.invocationCallOrder[0]!)
      .toBeLessThan(mocks.markWebhookEventQueued.mock.invocationCallOrder[0]!);
    expect(mocks.markWebhookEventQueued).toHaveBeenCalledWith(
      { id: "db" },
      "stripe:payment_intent-succeeded:evt_stripe_1",
      expect.objectContaining({ eventType: "payment_intent.succeeded" }),
    );
    expect(mocks.markWebhookEventFailed).not.toHaveBeenCalled();
  });

  it("does not enqueue duplicate durable events", async () => {
    mocks.claimWebhookEvent.mockResolvedValue({
      claimed: false,
      existing: { status: "queued" },
    });
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const app = createApp({ id: "db" });

    const response = await postWebhook(app, { PAYMENT_EVENTS_QUEUE: queue as unknown as Queue });
    const body = await response.json() as { duplicate?: boolean; status?: string };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ duplicate: true, status: "queued" });
    expect(queue.send).not.toHaveBeenCalled();
    expect(mocks.markWebhookEventQueued).not.toHaveBeenCalled();
  });

  it("marks the durable event failed and returns 503 when queue send fails", async () => {
    const queue = { send: vi.fn().mockRejectedValue(new Error("queue down")) };
    const app = createApp({ id: "db" });

    const response = await postWebhook(app, { PAYMENT_EVENTS_QUEUE: queue as unknown as Queue });

    expect(response.status).toBe(503);
    expect(mocks.markWebhookEventFailed).toHaveBeenCalledWith(
      { id: "db" },
      "stripe:payment_intent-succeeded:evt_stripe_1",
      expect.objectContaining({ error: "queue down" }),
    );
    expect(mocks.markWebhookEventQueued).not.toHaveBeenCalled();
  });
});
