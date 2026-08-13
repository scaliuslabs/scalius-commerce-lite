import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPolarSettings: vi.fn(),
  isPolarCheckoutUsable: vi.fn(),
  retrievePolarCheckout: vi.fn(),
  claimWebhookEvent: vi.fn(),
  markWebhookEventQueued: vi.fn(),
  markWebhookEventFailed: vi.fn(),
}));

vi.mock("@scalius/core/modules/payments/gateway-settings", () => ({
  getPolarSettings: mocks.getPolarSettings,
  isPolarCheckoutUsable: mocks.isPolarCheckoutUsable,
}));

vi.mock("@scalius/core/modules/payments/polar", () => ({
  retrievePolarCheckout: mocks.retrievePolarCheckout,
}));

vi.mock("../../utils/webhook-idempotency", () => ({
  buildWebhookEventId: (provider: string, eventType: string, source: string) =>
    `${provider}:${eventType}:${source}`,
  claimWebhookEvent: mocks.claimWebhookEvent,
  markWebhookEventQueued: mocks.markWebhookEventQueued,
  markWebhookEventFailed: mocks.markWebhookEventFailed,
}));

import { reconcilePolarOrderPayment } from "./polar-reconciliation";

type OrderRow = {
  id: string;
  paymentMethod: string;
  paymentStatus: string;
  paymentIntentId: string | null;
};

function createInput(order: OrderRow = {
  id: "order_1",
  paymentMethod: "polar",
  paymentStatus: "unpaid",
  paymentIntentId: "checkout_1",
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
  const env = {
    CREDENTIAL_ENCRYPTION_KEY: "credential-key",
    PAYMENT_EVENTS_QUEUE: queue,
  } as never;
  return { db: db as never, env, queue };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPolarSettings.mockResolvedValue({
    enabled: true,
    sandbox: true,
    accessToken: "polar-token",
    productId: "polar-product",
    webhookSecret: "polar-webhook",
  });
  mocks.isPolarCheckoutUsable.mockReturnValue(true);
  mocks.retrievePolarCheckout.mockResolvedValue({
    success: true,
    checkout: {
      id: "checkout_1",
      status: "succeeded",
      totalAmount: 2149,
      currency: "usd",
      metadata: {
        orderId: "order_1",
        paymentType: "full",
        originalAmount: "2643.4",
        originalCurrency: "BDT",
        exchangeRate: "123",
      },
    },
  });
  mocks.claimWebhookEvent.mockResolvedValue({ claimed: true });
  mocks.markWebhookEventQueued.mockResolvedValue(undefined);
  mocks.markWebhookEventFailed.mockResolvedValue(undefined);
});

describe("Polar buyer-return reconciliation", () => {
  it("queues a provider-verified succeeded checkout with its trusted metadata", async () => {
    const { db, env, queue } = createInput();
    const result = await reconcilePolarOrderPayment({ db, env, orderId: "order_1" });

    expect(result).toEqual({
      data: { status: "scheduled", providerStatus: "succeeded" },
      accepted: true,
    });
    expect(queue.send).toHaveBeenCalledWith({
      type: "payment.polar.confirmed",
      orderId: "order_1",
      checkoutId: "checkout_1",
      amount: 2149,
      currency: "usd",
      paymentType: "full",
      metadata: {
        orderId: "order_1",
        paymentType: "full",
        originalAmount: "2643.4",
        originalCurrency: "BDT",
        exchangeRate: "123",
      },
      webhookEventId: "polar:order.paid:buyer-reconcile:checkout_1",
    });
  });

  it("does not queue a checkout that is only confirmed", async () => {
    mocks.retrievePolarCheckout.mockResolvedValueOnce({
      success: true,
      checkout: {
        id: "checkout_1",
        status: "confirmed",
        totalAmount: 2149,
        currency: "usd",
        metadata: { orderId: "order_1" },
      },
    });
    const { db, env, queue } = createInput();
    const result = await reconcilePolarOrderPayment({ db, env, orderId: "order_1" });

    expect(result).toEqual({
      data: { status: "pending", providerStatus: "confirmed" },
      accepted: false,
    });
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("rejects a checkout whose provider metadata belongs to another order", async () => {
    mocks.retrievePolarCheckout.mockResolvedValueOnce({
      success: true,
      checkout: {
        id: "checkout_1",
        status: "succeeded",
        totalAmount: 2149,
        currency: "usd",
        metadata: { orderId: "order_other" },
      },
    });
    const { db, env, queue } = createInput();

    await expect(reconcilePolarOrderPayment({ db, env, orderId: "order_1" }))
      .rejects.toThrow("did not match this order");
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("does not probe Polar again after local settlement", async () => {
    const { db, env, queue } = createInput({
      id: "order_1",
      paymentMethod: "polar",
      paymentStatus: "paid",
      paymentIntentId: "checkout_1",
    });
    const result = await reconcilePolarOrderPayment({ db, env, orderId: "order_1" });

    expect(result.data.status).toBe("settled");
    expect(mocks.retrievePolarCheckout).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("does not enqueue a duplicate reconciliation event", async () => {
    mocks.claimWebhookEvent.mockResolvedValueOnce({
      claimed: false,
      existing: { status: "queued" },
    });
    const { db, env, queue } = createInput();
    const result = await reconcilePolarOrderPayment({ db, env, orderId: "order_1" });

    expect(result.data.status).toBe("scheduled");
    expect(queue.send).not.toHaveBeenCalled();
  });
});
