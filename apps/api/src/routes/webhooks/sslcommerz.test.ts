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
  FRESH_GATEWAY_SETTINGS_READ_OPTIONS: { bypassMemoryCache: true },
  getSSLCommerzSettings: mocks.getSSLCommerzSettings,
}));

vi.mock("@scalius/core/modules/payments/sslcommerz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/payments/sslcommerz")>()),
  validateSSLCommerzIPN: mocks.validateSSLCommerzIPN,
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

import { sslcommerzWebhookRoutes } from "./sslcommerz";

const defaultOrder = {
  id: "ord_1",
  totalAmount: 100.5,
  paidAmount: 0,
  balanceDue: 100.5,
  paymentMethod: "sslcommerz",
};

function createSelectQuery(value: unknown) {
  const query: Record<string, unknown> = {};
  const returnSelf = () => query;
  query.from = vi.fn(returnSelf);
  query.where = vi.fn(returnSelf);
  query.get = vi.fn(() => Promise.resolve(value));
  return query;
}

function createDb(options: {
  order?: unknown | null;
  plan?: unknown | null;
} = {}) {
  const selectValues = [
    options.order === undefined ? defaultOrder : options.order,
    options.plan === undefined ? null : options.plan,
  ];

  return {
    id: "db",
    select: vi.fn(() => createSelectQuery(selectValues.shift() ?? null)),
  };
}

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
  form: Record<string, string> = {},
) {
  return app.request(
    "/",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        tran_id: "ord_1",
        val_id: "val_1",
        bank_tran_id: "form_bank",
        currency: "USD",
        card_type: "FORM_CARD",
        card_brand: "FORM_BRAND",
        value_a: "full",
        ...form,
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
      tran_id: "ord_1",
      val_id: "val_1",
      amount: "100.50",
      store_amount: "100.50",
      bank_tran_id: "bank_1",
      currency_type: "BDT",
      currency_amount: "100.50",
      card_type: "VISA",
      card_brand: "VISA",
      value_a: "full",
    });
    mocks.claimWebhookEvent.mockResolvedValue({ claimed: true });
    mocks.markWebhookEventQueued.mockResolvedValue(undefined);
    mocks.markWebhookEventProcessed.mockResolvedValue(undefined);
    mocks.markWebhookEventFailed.mockResolvedValue(undefined);
  });

  it("claims a durable event before enqueueing and marks it queued after queue send", async () => {
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const kv = { id: "kv" } as unknown as KVNamespace;
    const db = createDb();
    const app = createApp(db);

    const response = await postWebhook(
      app,
      {
        CACHE: kv,
        PAYMENT_EVENTS_QUEUE: queue as unknown as Queue,
      },
      { tran_id: "form_ord", bank_tran_id: "form_bank", value_a: "deposit" },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
    expect(mocks.getSSLCommerzSettings).toHaveBeenCalledWith(
      db,
      kv,
      "test-key",
      expect.objectContaining({ bypassMemoryCache: true }),
    );
    expect(mocks.validateSSLCommerzIPN).toHaveBeenCalledWith(
      "store_test",
      "password_test",
      true,
      "val_1",
    );
    expect(mocks.claimWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: "db" }),
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
      bankTranId: "bank_1",
      currency: "BDT",
      cardType: "VISA",
      cardBrand: "VISA",
      paymentType: "full",
    }));
    expect(mocks.claimWebhookEvent.mock.invocationCallOrder[0]!)
      .toBeLessThan(queue.send.mock.invocationCallOrder[0]!);
    expect(queue.send.mock.invocationCallOrder[0]!)
      .toBeLessThan(mocks.markWebhookEventQueued.mock.invocationCallOrder[0]!);
    expect(mocks.markWebhookEventQueued).toHaveBeenCalledWith(
      expect.objectContaining({ id: "db" }),
      "sslcommerz:ipn:ord_1:val_1",
      expect.objectContaining({ status: "VALID" }),
    );
    expect(mocks.markWebhookEventFailed).not.toHaveBeenCalled();
  });

  it("returns RETRY without validating or claiming when fresh settings cannot be read", async () => {
    mocks.getSSLCommerzSettings.mockRejectedValue(new Error("d1 overloaded"));
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const db = createDb();
    const app = createApp(db);

    const response = await postWebhook(app, { PAYMENT_EVENTS_QUEUE: queue as unknown as Queue });

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("RETRY");
    expect(mocks.validateSSLCommerzIPN).not.toHaveBeenCalled();
    expect(mocks.claimWebhookEvent).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("does not validate or enqueue duplicate durable events", async () => {
    mocks.claimWebhookEvent.mockResolvedValue({
      claimed: false,
      existing: { status: "queued" },
    });
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const db = createDb();
    const app = createApp(db);

    const response = await postWebhook(app, { PAYMENT_EVENTS_QUEUE: queue as unknown as Queue });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
    expect(mocks.validateSSLCommerzIPN).toHaveBeenCalledWith("store_test", "password_test", true, "val_1");
    expect(db.select).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
    expect(mocks.markWebhookEventQueued).not.toHaveBeenCalled();
  });

  it("marks the durable event failed and returns RETRY when validation cannot complete", async () => {
    mocks.validateSSLCommerzIPN.mockResolvedValue(null);
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(createDb());

    const response = await postWebhook(app, { PAYMENT_EVENTS_QUEUE: queue as unknown as Queue });

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("RETRY");
    expect(queue.send).not.toHaveBeenCalled();
    expect(mocks.claimWebhookEvent).not.toHaveBeenCalled();
    expect(mocks.markWebhookEventFailed).not.toHaveBeenCalled();
  });

  it("marks the durable event failed and returns RETRY when queue send fails", async () => {
    const queue = { send: vi.fn().mockRejectedValue(new Error("queue down")) };
    const app = createApp(createDb());

    const response = await postWebhook(app, { PAYMENT_EVENTS_QUEUE: queue as unknown as Queue });

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("RETRY");
    expect(mocks.markWebhookEventFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: "db" }),
      "sslcommerz:ipn:ord_1:val_1",
      expect.objectContaining({ error: "queue down" }),
    );
    expect(mocks.markWebhookEventQueued).not.toHaveBeenCalled();
  });

  it("infers payment type from server-side payment plan when validation has no value_a", async () => {
    mocks.validateSSLCommerzIPN.mockResolvedValue({
      status: "VALID",
      tran_id: "ord_1",
      val_id: "val_1",
      amount: "25.00",
      store_amount: "25.00",
      bank_tran_id: "bank_1",
      currency_type: "BDT",
      currency_amount: "25.00",
      card_type: "VISA",
      card_brand: "VISA",
    });
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(createDb({
      plan: {
        depositAmount: 25,
        balanceDue: 75.5,
      },
    }));

    const response = await postWebhook(
      app,
      { PAYMENT_EVENTS_QUEUE: queue as unknown as Queue },
      { value_a: "full" },
    );

    expect(response.status).toBe(200);
    expect(queue.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "payment.sslcommerz.confirmed",
      paymentType: "deposit",
      amount: 25,
    }));
  });

  it("uses scoped SSLCommerz transaction IDs for idempotency while applying payment to the canonical order", async () => {
    mocks.validateSSLCommerzIPN.mockResolvedValue({
      status: "VALID",
      tran_id: "ord_1_deposit_ABC12345",
      val_id: "val_1",
      amount: "25.00",
      store_amount: "25.00",
      bank_tran_id: "bank_1",
      currency_type: "BDT",
      currency_amount: "25.00",
      card_type: "VISA",
      card_brand: "VISA",
      value_a: "deposit",
      value_b: "ord_1",
    });
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(createDb({
      plan: {
        depositAmount: 25,
        balanceDue: 75.5,
      },
    }));

    const response = await postWebhook(app, { PAYMENT_EVENTS_QUEUE: queue as unknown as Queue });

    expect(response.status).toBe(200);
    expect(mocks.claimWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: "db" }),
      expect.objectContaining({
        id: "sslcommerz:ipn:ord_1_deposit_abc12345:val_1",
        orderId: "ord_1",
      }),
    );
    expect(queue.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "payment.sslcommerz.confirmed",
      orderId: "ord_1",
      tranId: "ord_1_deposit_ABC12345",
      paymentType: "deposit",
      amount: 25,
    }));
  });

  it("does not claim or enqueue when validation identifiers are inconsistent", async () => {
    mocks.validateSSLCommerzIPN.mockResolvedValue({
      status: "VALID",
      tran_id: "ord_1",
      val_id: "other_val",
      amount: "100.50",
      store_amount: "100.50",
      bank_tran_id: "bank_1",
      currency_type: "BDT",
      currency_amount: "100.50",
    });
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(createDb());

    const response = await postWebhook(app, { PAYMENT_EVENTS_QUEUE: queue as unknown as Queue });

    expect(response.status).toBe(200);
    expect(mocks.claimWebhookEvent).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("marks canonical events failed when validated payment data conflicts with server state", async () => {
    mocks.validateSSLCommerzIPN.mockResolvedValue({
      status: "VALID",
      tran_id: "ord_1",
      val_id: "val_1",
      amount: "25.00",
      store_amount: "25.00",
      bank_tran_id: "bank_1",
      currency_type: "BDT",
      currency_amount: "25.00",
      value_a: "full",
    });
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const app = createApp(createDb({
      plan: {
        depositAmount: 25,
        balanceDue: 75.5,
      },
    }));

    const response = await postWebhook(app, { PAYMENT_EVENTS_QUEUE: queue as unknown as Queue });

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("RETRY");
    expect(queue.send).not.toHaveBeenCalled();
    expect(mocks.markWebhookEventFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: "db" }),
      "sslcommerz:ipn:ord_1:val_1",
      expect.objectContaining({
        error: "Validated payment type or amount is inconsistent with server-side order state",
      }),
    );
  });
});
