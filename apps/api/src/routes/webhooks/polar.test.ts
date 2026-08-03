import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

type TestPolarPayload = {
  id?: string;
  type: string;
  data: {
    id: string;
    status: string;
    checkout_id?: string;
    amount?: number;
    total_amount?: number;
    refunded_amount?: number;
    currency?: string;
    metadata?: Record<string, string>;
  };
};

const mocks = vi.hoisted(() => ({
  payload: {
    id: "evt_polar_1",
    type: "order.paid",
    data: {
      id: "polar_order_1",
      checkout_id: "checkout_1",
      status: "paid",
      total_amount: 1200,
      currency: "usd",
      metadata: { orderId: "ord_1", paymentType: "full" },
    },
  } as TestPolarPayload,
  getPolarSettings: vi.fn(),
  verifyPolarWebhook: vi.fn(),
  claimWebhookEvent: vi.fn(),
  markWebhookEventQueued: vi.fn(),
  markWebhookEventProcessed: vi.fn(),
  markWebhookEventFailed: vi.fn(),
}));

vi.mock("@scalius/core/modules/payments/gateway-settings", () => ({
  getPolarSettings: mocks.getPolarSettings,
}));

vi.mock("@scalius/core/modules/payments/polar", () => ({
  verifyPolarWebhook: mocks.verifyPolarWebhook,
}));

vi.mock("../../utils/encryption-key", () => ({
  getEncryptionKey: vi.fn(() => "test-key"),
  getCredentialEncryptionKey: vi.fn(() => "test-key"),
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

import { polarWebhookRoutes, getPolarSourceEventId } from "./polar";

function createApp(db: unknown, _queue: { send: ReturnType<typeof vi.fn> } | null) {
  const app = new Hono<{ Bindings: Env; Variables: { db: unknown } }>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/", polarWebhookRoutes);
  return app;
}

async function postWebhook(app: ReturnType<typeof createApp>, env: Partial<Env> = {}) {
  return app.request(
    "/",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
    },
    env,
  );
}

describe("Polar webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    mocks.payload = {
      id: "evt_polar_1",
      type: "order.paid",
      data: {
        id: "polar_order_1",
        checkout_id: "checkout_1",
        status: "paid",
        total_amount: 1200,
        currency: "usd",
        metadata: { orderId: "ord_1", paymentType: "full" },
      },
    };
    mocks.getPolarSettings.mockResolvedValue({ webhookSecret: "polar_whs_test" });
    mocks.verifyPolarWebhook.mockImplementation(() => ({ verified: true, payload: mocks.payload }));
    mocks.claimWebhookEvent.mockResolvedValue({ claimed: true });
    mocks.markWebhookEventQueued.mockResolvedValue(undefined);
    mocks.markWebhookEventProcessed.mockResolvedValue(undefined);
    mocks.markWebhookEventFailed.mockResolvedValue(undefined);
  });

  it("claims a durable event before enqueueing and marks it queued after queue send", async () => {
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const kv = { id: "kv" } as unknown as KVNamespace;
    const app = createApp({ id: "db" }, queue);

    const response = await postWebhook(app, {
      CACHE: kv,
      PAYMENT_EVENTS_QUEUE: queue as unknown as Queue,
    });

    expect(response.status).toBe(200);
    expect(mocks.getPolarSettings).toHaveBeenCalledWith(
      { id: "db" },
      "test-key",
    );
    expect(mocks.verifyPolarWebhook).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      "polar_whs_test",
    );
    expect(mocks.claimWebhookEvent).toHaveBeenCalledWith(
      { id: "db" },
      expect.objectContaining({
        id: "polar:order-paid:evt_polar_1",
        provider: "polar",
        eventType: "order.paid",
        orderId: "ord_1",
        status: "processing",
      }),
    );
    expect(queue.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "payment.polar.confirmed",
      orderId: "ord_1",
      checkoutId: "checkout_1",
      amount: 1200,
    }));
    expect(mocks.markWebhookEventQueued).toHaveBeenCalledWith(
      { id: "db" },
      "polar:order-paid:evt_polar_1",
      expect.objectContaining({ eventType: "order.paid" }),
    );
    expect(mocks.markWebhookEventFailed).not.toHaveBeenCalled();
  });

  it("falls back to a legacy checkout-shaped data.id and amount only when checkout_id and total_amount are absent", async () => {
    mocks.payload = {
      id: "evt_polar_legacy_paid",
      type: "order.paid",
      data: {
        id: "co_legacy_checkout",
        status: "paid",
        amount: 900,
        currency: "usd",
        metadata: { orderId: "ord_legacy", paymentType: "full" },
      },
    };
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const app = createApp({ id: "db" }, queue);

    const response = await postWebhook(app, {
      PAYMENT_EVENTS_QUEUE: queue as unknown as Queue,
    });

    expect(response.status).toBe(200);
    expect(queue.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "payment.polar.confirmed",
      orderId: "ord_legacy",
      checkoutId: "co_legacy_checkout",
      amount: 900,
    }));
  });

  it("does not fall back to a Polar order id when order.paid is missing checkout_id", async () => {
    mocks.payload = {
      id: "evt_polar_missing_checkout",
      type: "order.paid",
      data: {
        id: "polar_order_missing_checkout",
        status: "paid",
        total_amount: 1200,
        currency: "usd",
        metadata: { orderId: "ord_missing_checkout", paymentType: "full" },
      },
    };
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const app = createApp({ id: "db" }, queue);

    const response = await postWebhook(app, {
      PAYMENT_EVENTS_QUEUE: queue as unknown as Queue,
    });

    expect(response.status).toBe(200);
    expect(queue.send).not.toHaveBeenCalled();
    expect(mocks.markWebhookEventProcessed).toHaveBeenCalledWith(
      { id: "db" },
      "polar:order-paid:evt_polar_missing_checkout",
      expect.objectContaining({ eventType: "order.paid", enqueued: false }),
    );
  });

  it("maps Polar order refunds through checkout_id so they reconcile with the stored polarCheckoutId", async () => {
    mocks.payload = {
      id: "evt_polar_refund_1",
      type: "order.refunded",
      data: {
        id: "polar_order_1",
        checkout_id: "checkout_1",
        status: "refunded",
        refunded_amount: 1200,
        total_amount: 1200,
        currency: "usd",
        metadata: { orderId: "ord_1" },
      },
    };
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const app = createApp({ id: "db" }, queue);

    const response = await postWebhook(app, {
      PAYMENT_EVENTS_QUEUE: queue as unknown as Queue,
    });

    expect(response.status).toBe(200);
    expect(queue.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "payment.polar.refunded",
      orderId: "ord_1",
      polarCheckoutId: "checkout_1",
      amountRefunded: 1200,
      totalAmount: 1200,
    }));
  });

  it("returns retryable failure without claiming when fresh settings cannot be read", async () => {
    mocks.getPolarSettings.mockRejectedValue(new Error("d1 overloaded"));
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const app = createApp({ id: "db" }, queue);

    const response = await postWebhook(app, { PAYMENT_EVENTS_QUEUE: queue as unknown as Queue });

    expect(response.status).toBe(503);
    expect(mocks.verifyPolarWebhook).not.toHaveBeenCalled();
    expect(mocks.claimWebhookEvent).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("rejects invalid signatures before claiming an event", async () => {
    mocks.verifyPolarWebhook.mockReturnValue({ verified: false, error: "bad sig" });
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const app = createApp({ id: "db" }, queue);

    const response = await postWebhook(app, { PAYMENT_EVENTS_QUEUE: queue as unknown as Queue });

    expect(response.status).toBe(403);
    expect(mocks.claimWebhookEvent).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("does not enqueue duplicate durable events", async () => {
    mocks.claimWebhookEvent.mockResolvedValue({
      claimed: false,
      existing: { status: "queued" },
    });
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const app = createApp({ id: "db" }, queue);

    const response = await postWebhook(app, { PAYMENT_EVENTS_QUEUE: queue as unknown as Queue });
    const body = await response.json() as { duplicate?: boolean; status?: string };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ duplicate: true, status: "queued" });
    expect(queue.send).not.toHaveBeenCalled();
    expect(mocks.markWebhookEventQueued).not.toHaveBeenCalled();
  });

  it("marks the durable event failed and returns 503 when queue send fails", async () => {
    const queue = { send: vi.fn().mockRejectedValue(new Error("queue down")) };
    const app = createApp({ id: "db" }, queue);

    const response = await postWebhook(app, { PAYMENT_EVENTS_QUEUE: queue as unknown as Queue });

    expect(response.status).toBe(503);
    expect(mocks.markWebhookEventFailed).toHaveBeenCalledWith(
      { id: "db" },
      "polar:order-paid:evt_polar_1",
      expect.objectContaining({ error: "queue down" }),
    );
    expect(mocks.markWebhookEventQueued).not.toHaveBeenCalled();
  });

  it("uses refund details in fallback event ids so separate refund updates do not collapse", () => {
    const first = getPolarSourceEventId({
      type: "order.refunded",
      data: {
        id: "polar_order_1",
        checkout_id: "checkout_1",
        status: "partially_refunded",
        refunded_amount: 500,
        total_amount: 1200,
        metadata: { orderId: "ord_1" },
      },
    });
    const second = getPolarSourceEventId({
      type: "order.refunded",
      data: {
        id: "polar_order_1",
        checkout_id: "checkout_1",
        status: "refunded",
        refunded_amount: 1200,
        total_amount: 1200,
        metadata: { orderId: "ord_1" },
      },
    });

    expect(first).not.toBe(second);
  });
});
