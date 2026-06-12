import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const mocks = vi.hoisted(() => ({
  getSSLCommerzSettings: vi.fn(),
  validateSSLCommerzIPN: vi.fn(),
  claimWebhookEvent: vi.fn(),
  markWebhookEventQueued: vi.fn(),
  markWebhookEventProcessed: vi.fn(),
  markWebhookEventFailed: vi.fn(),
}));

vi.mock("@scalius/core/modules/payments/gateway-settings", () => ({
  getSSLCommerzSettings: mocks.getSSLCommerzSettings,
}));

vi.mock("@scalius/core/modules/payments/sslcommerz", () => ({
  validateSSLCommerzIPN: mocks.validateSSLCommerzIPN,
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

import { sslcommerzWebhookRoutes } from "./sslcommerz";

function createApp(db: unknown) {
  const app = new Hono<{ Bindings: Env; Variables: { db: unknown } }>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/", sslcommerzWebhookRoutes);
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
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        tran_id: "ord_1",
        val_id: "val_1",
        bank_tran_id: "bank_1",
        currency: "BDT",
        card_type: "VISA",
        card_brand: "VISA",
        value_a: "full",
      }).toString(),
    },
    env,
  );
}

describe("SSLCommerz webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    mocks.getSSLCommerzSettings.mockResolvedValue({
      storeId: "store_test",
      storePassword: "password_test",
      sandbox: true,
    });
    mocks.validateSSLCommerzIPN.mockResolvedValue({
      status: "VALID",
      amount: "100.50",
      store_amount: "100.50",
    });
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
    expect(await response.text()).toBe("OK");
    expect(mocks.claimWebhookEvent).toHaveBeenCalledWith(
      { id: "db" },
      expect.objectContaining({
        id: "sslcommerz:ipn:ord_1:val_1",
        provider: "sslcommerz",
        eventType: "ipn",
        orderId: "ord_1",
        status: "processing",
      }),
    );
    expect(queue.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "payment.sslcommerz.confirmed",
      orderId: "ord_1",
      tranId: "ord_1",
      valId: "val_1",
    }));
    expect(mocks.claimWebhookEvent.mock.invocationCallOrder[0]!)
      .toBeLessThan(queue.send.mock.invocationCallOrder[0]!);
    expect(queue.send.mock.invocationCallOrder[0]!)
      .toBeLessThan(mocks.markWebhookEventQueued.mock.invocationCallOrder[0]!);
    expect(mocks.markWebhookEventQueued).toHaveBeenCalledWith(
      { id: "db" },
      "sslcommerz:ipn:ord_1:val_1",
      expect.objectContaining({ status: "VALID" }),
    );
    expect(mocks.markWebhookEventFailed).not.toHaveBeenCalled();
  });

  it("does not validate or enqueue duplicate durable events", async () => {
    mocks.claimWebhookEvent.mockResolvedValue({
      claimed: false,
      existing: { status: "queued" },
    });
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const app = createApp({ id: "db" });

    const response = await postWebhook(app, { PAYMENT_EVENTS_QUEUE: queue as unknown as Queue });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
    expect(mocks.validateSSLCommerzIPN).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
    expect(mocks.markWebhookEventQueued).not.toHaveBeenCalled();
  });

  it("marks the durable event failed and returns RETRY when validation cannot complete", async () => {
    mocks.validateSSLCommerzIPN.mockResolvedValue(null);
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const app = createApp({ id: "db" });

    const response = await postWebhook(app, { PAYMENT_EVENTS_QUEUE: queue as unknown as Queue });

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("RETRY");
    expect(queue.send).not.toHaveBeenCalled();
    expect(mocks.markWebhookEventFailed).toHaveBeenCalledWith(
      { id: "db" },
      "sslcommerz:ipn:ord_1:val_1",
      expect.objectContaining({ error: "Validation API call failed" }),
    );
  });

  it("marks the durable event failed and returns RETRY when queue send fails", async () => {
    const queue = { send: vi.fn().mockRejectedValue(new Error("queue down")) };
    const app = createApp({ id: "db" });

    const response = await postWebhook(app, { PAYMENT_EVENTS_QUEUE: queue as unknown as Queue });

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("RETRY");
    expect(mocks.markWebhookEventFailed).toHaveBeenCalledWith(
      { id: "db" },
      "sslcommerz:ipn:ord_1:val_1",
      expect.objectContaining({ error: "queue down" }),
    );
    expect(mocks.markWebhookEventQueued).not.toHaveBeenCalled();
  });
});
