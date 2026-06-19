import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrderStatus, PaymentStatus } from "@scalius/database/schema";

const mocks = vi.hoisted(() => ({
  applyInventoryForStatusChange: vi.fn(),
  polarConstructor: vi.fn(),
  polarCheckoutCreate: vi.fn(),
  polarRefundCreate: vi.fn(),
}));

vi.mock("@polar-sh/sdk", () => ({
  Polar: vi.fn(function PolarMock(options: unknown) {
    mocks.polarConstructor(options);
    return {
      checkouts: { create: mocks.polarCheckoutCreate },
      refunds: { create: mocks.polarRefundCreate },
    };
  }),
}));

vi.mock("../inventory/inventory-transitions", () => ({
  applyInventoryForStatusChange: mocks.applyInventoryForStatusChange,
}));

import { createPolarCheckout, processPolarWebhookRefund } from "./polar";

function createDbMock({
  order,
  updateRows = [{ id: "order_1" }],
}: {
  order: Record<string, unknown> | null;
  updateRows?: Array<{ id: string }>;
}) {
  const updates: Array<Record<string, unknown>> = [];

  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                get: async () => order,
              };
            },
          };
        },
      };
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          updates.push(values);
          return {
            where() {
              return {
                returning: async () => updateRows,
              };
            },
          };
        },
      };
    },
  };

  return { db, updates };
}

describe("Polar webhook refund processing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.applyInventoryForStatusChange.mockResolvedValue("restored");
  });

  it("cancels pre-fulfillment fully refunded orders and releases reservations", async () => {
    const { db, updates } = createDbMock({
      order: {
        id: "order_1",
        paidAmount: 100,
        paymentStatus: PaymentStatus.PAID,
        totalAmount: 100,
        status: OrderStatus.PENDING,
        version: 3,
      },
    });

    const result = await processPolarWebhookRefund(db as never, {
      orderId: "order_1",
      amountRefunded: 10_000,
      totalAmount: 10_000,
      currency: "usd",
      polarStatus: "refunded",
    });

    expect(result).toEqual({ success: true });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      paidAmount: 0,
      paymentStatus: PaymentStatus.REFUNDED,
      status: OrderStatus.CANCELLED,
    });
    expect(mocks.applyInventoryForStatusChange).toHaveBeenCalledWith(
      db,
      "order_1",
      OrderStatus.CANCELLED,
    );
  });

  it("marks fulfilled full refunds as refunded without auto-restocking inventory", async () => {
    const { db, updates } = createDbMock({
      order: {
        id: "order_1",
        paidAmount: 100,
        paymentStatus: PaymentStatus.PAID,
        totalAmount: 100,
        status: OrderStatus.DELIVERED,
        version: 3,
      },
    });

    const result = await processPolarWebhookRefund(db as never, {
      orderId: "order_1",
      amountRefunded: 10_000,
      totalAmount: 10_000,
      currency: "usd",
      polarStatus: "refunded",
    });

    expect(result).toEqual({ success: true });
    expect(updates[0]).toMatchObject({
      paidAmount: 0,
      paymentStatus: PaymentStatus.REFUNDED,
      status: OrderStatus.REFUNDED,
    });
    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });

  it("retries when the refund order CAS loses", async () => {
    const { db } = createDbMock({
      order: {
        id: "order_1",
        paidAmount: 100,
        paymentStatus: PaymentStatus.PAID,
        totalAmount: 100,
        status: OrderStatus.PENDING,
        version: 3,
      },
      updateRows: [],
    });

    const result = await processPolarWebhookRefund(db as never, {
      orderId: "order_1",
      amountRefunded: 10_000,
      totalAmount: 10_000,
      currency: "usd",
      polarStatus: "refunded",
    });

    expect(result).toEqual({
      success: false,
      error: "Order was modified concurrently while applying Polar refund; retry required",
    });
    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });

  it("repairs old fully-refunded payment rows whose order status was never transitioned", async () => {
    const { db, updates } = createDbMock({
      order: {
        id: "order_1",
        paidAmount: 0,
        paymentStatus: PaymentStatus.REFUNDED,
        totalAmount: 100,
        status: OrderStatus.PENDING,
        version: 3,
      },
    });

    const result = await processPolarWebhookRefund(db as never, {
      orderId: "order_1",
      amountRefunded: 10_000,
      totalAmount: 10_000,
      currency: "usd",
      polarStatus: "refunded",
    });

    expect(result).toEqual({ success: true });
    expect(updates[0]).toMatchObject({
      paymentStatus: PaymentStatus.REFUNDED,
      status: OrderStatus.CANCELLED,
    });
    expect(mocks.applyInventoryForStatusChange).toHaveBeenCalledWith(
      db,
      "order_1",
      OrderStatus.CANCELLED,
    );
  });

  it("reconciles inventory when retry sees a pre-fulfillment refund already cancelled", async () => {
    const { db, updates } = createDbMock({
      order: {
        id: "order_1",
        paidAmount: 0,
        paymentStatus: PaymentStatus.REFUNDED,
        totalAmount: 100,
        status: OrderStatus.CANCELLED,
        version: 4,
      },
    });

    const result = await processPolarWebhookRefund(db as never, {
      orderId: "order_1",
      amountRefunded: 10_000,
      totalAmount: 10_000,
      currency: "usd",
      polarStatus: "refunded",
    });

    expect(result).toEqual({ success: true });
    expect(updates).toHaveLength(0);
    expect(mocks.applyInventoryForStatusChange).toHaveBeenCalledWith(
      db,
      "order_1",
      OrderStatus.CANCELLED,
    );
  });

  it("does not auto-restore deducted inventory for an already-cancelled fulfilled refund retry", async () => {
    const { db, updates } = createDbMock({
      order: {
        id: "order_1",
        paidAmount: 0,
        paymentStatus: PaymentStatus.REFUNDED,
        totalAmount: 100,
        status: OrderStatus.CANCELLED,
        inventoryAction: "deducted",
        version: 4,
      },
    });

    const result = await processPolarWebhookRefund(db as never, {
      orderId: "order_1",
      amountRefunded: 10_000,
      totalAmount: 10_000,
      currency: "usd",
      polarStatus: "refunded",
    });

    expect(result).toEqual({ success: true });
    expect(updates).toHaveLength(0);
    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });
});

describe("Polar client cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.polarCheckoutCreate.mockResolvedValue({ url: "https://polar.example/checkout", id: "co_1" });
  });

  it("creates a new SDK client when sandbox changes with the same access token", async () => {
    const params = {
      orderId: "order_1",
      amount: 1000,
      currency: "usd",
      productId: "product_1",
      paymentType: "full" as const,
      successUrl: "https://shop.example/success",
      cancelUrl: "https://shop.example/cancel",
    };

    await createPolarCheckout(
      {
        enabled: true,
        accessToken: "polar_token_same",
        webhookSecret: "polar_whs_test",
        productId: "product_1",
        sandbox: true,
      },
      params,
    );
    await createPolarCheckout(
      {
        enabled: true,
        accessToken: "polar_token_same",
        webhookSecret: "polar_whs_test",
        productId: "product_1",
        sandbox: false,
      },
      params,
    );

    expect(mocks.polarConstructor).toHaveBeenCalledTimes(2);
    expect(mocks.polarConstructor).toHaveBeenNthCalledWith(1, expect.objectContaining({
      accessToken: "polar_token_same",
      server: "sandbox",
    }));
    expect(mocks.polarConstructor).toHaveBeenNthCalledWith(2, expect.objectContaining({
      accessToken: "polar_token_same",
      server: "production",
    }));
  });
});
