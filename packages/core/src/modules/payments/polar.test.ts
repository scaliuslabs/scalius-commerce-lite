import { beforeEach, describe, expect, it, vi } from "vitest";
import { orderPayments, OrderStatus, PaymentRecordStatus, PaymentStatus } from "@scalius/database/schema";

const mocks = vi.hoisted(() => ({
  applyInventoryForStatusChange: vi.fn(),
  polarConstructor: vi.fn(),
  polarCheckoutCreate: vi.fn(),
  polarCheckoutGet: vi.fn(),
  polarCheckoutList: vi.fn(),
  polarRefundCreate: vi.fn(),
}));

vi.mock("@polar-sh/sdk", () => ({
  Polar: vi.fn(function PolarMock(options: unknown) {
    mocks.polarConstructor(options);
    return {
      checkouts: { create: mocks.polarCheckoutCreate, get: mocks.polarCheckoutGet, list: mocks.polarCheckoutList },
      refunds: { create: mocks.polarRefundCreate },
    };
  }),
}));

vi.mock("../inventory/inventory-transitions", () => ({
  applyInventoryForStatusChange: mocks.applyInventoryForStatusChange,
}));

import {
  createPolarCheckout,
  createPolarRefund,
  findReusablePolarCheckout,
  processPolarWebhookRefund,
  retrievePolarCheckout,
} from "./polar";

function createDbMock({
  order,
  payments = [],
  updateRows = [{ id: "order_1" }],
}: {
  order: Record<string, unknown> | null;
  payments?: Array<Record<string, unknown>>;
  updateRows?: Array<{ id: string }>;
}) {
  const updates: Array<Record<string, unknown>> = [];
  const paymentUpdates: Array<Record<string, unknown>> = [];
  const paymentInserts: Array<Record<string, unknown>> = [];

  const db = {
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              if (table === orderPayments) {
                return payments;
              }
              return {
                get: async () => order,
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values: async (values: Record<string, unknown>) => {
          if (table === orderPayments) {
            paymentInserts.push(values);
            payments.push(values);
          }
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          if (table === orderPayments) {
            paymentUpdates.push(values);
          } else {
            updates.push(values);
          }
          return {
            where() {
              return {
                returning: async () => table === orderPayments ? [{ id: "refund_row" }] : updateRows,
              };
            },
          };
        },
      };
    },
  };

  return { db, updates, paymentUpdates, paymentInserts };
}

function polarPayment(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "pay_polar",
    amount: 100,
    currency: "BDT",
    paymentMethod: "polar",
    paymentType: "full",
    status: PaymentRecordStatus.SUCCEEDED,
    polarCheckoutId: "polar_order_1",
    metadata: null,
    ...overrides,
  };
}

function polarRefundPayment(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "refund_polar_existing",
    amount: 25,
    currency: "BDT",
    paymentMethod: "polar",
    paymentType: "refund",
    status: PaymentRecordStatus.REFUNDED,
    polarCheckoutId: "polar_order_1",
    metadata: JSON.stringify({
      source: "polar_webhook",
      sourcePaymentId: "pay_polar",
      polarCheckoutId: "polar_order_1",
    }),
    ...overrides,
  };
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
      payments: [polarPayment()],
    });

    const result = await processPolarWebhookRefund(db as never, {
      orderId: "order_1",
      polarCheckoutId: "polar_order_1",
      amountRefunded: 10_000,
      totalAmount: 10_000,
      currency: "usd",
      polarStatus: "refunded",
    });

    expect(result).toEqual({
      success: true,
      notification: {
        notificationType: "order_refunded",
        dedupeKey: "polar-refund:order_1:full",
        data: {
          gateway: "polar",
          polarStatus: "refunded",
          amountRefunded: 10_000,
          totalAmount: 10_000,
          currency: "usd",
          localRefundAmount: 100,
        },
      },
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      paidAmount: 0,
      balanceDue: 100,
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
      payments: [polarPayment()],
    });

    const result = await processPolarWebhookRefund(db as never, {
      orderId: "order_1",
      polarCheckoutId: "polar_order_1",
      amountRefunded: 10_000,
      totalAmount: 10_000,
      currency: "usd",
      polarStatus: "refunded",
    });

    expect(result).toEqual({
      success: true,
      notification: {
        notificationType: "order_refunded",
        dedupeKey: "polar-refund:order_1:full",
        data: {
          gateway: "polar",
          polarStatus: "refunded",
          amountRefunded: 10_000,
          totalAmount: 10_000,
          currency: "usd",
          localRefundAmount: 100,
        },
      },
    });
    expect(updates[0]).toMatchObject({
      paidAmount: 0,
      balanceDue: 100,
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
      payments: [polarPayment()],
      updateRows: [],
    });

    const result = await processPolarWebhookRefund(db as never, {
      orderId: "order_1",
      polarCheckoutId: "polar_order_1",
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

  it("recomputes balance due for partial Polar refunds", async () => {
    const { db, updates, paymentInserts, paymentUpdates } = createDbMock({
      order: {
        id: "order_1",
        paidAmount: 100,
        balanceDue: 0,
        paymentStatus: PaymentStatus.PAID,
        totalAmount: 100,
        status: OrderStatus.DELIVERED,
        version: 3,
      },
      payments: [polarPayment()],
    });

    const result = await processPolarWebhookRefund(db as never, {
      orderId: "order_1",
      polarCheckoutId: "polar_order_1",
      amountRefunded: 2_500,
      totalAmount: 10_000,
      currency: "usd",
      polarStatus: "partially_refunded",
    });

    expect(result).toEqual({
      success: true,
      notification: {
        notificationType: "order_partially_refunded",
        dedupeKey: "polar-refund:order_1:partial:2500:10000:usd",
        data: {
          gateway: "polar",
          polarStatus: "partially_refunded",
          amountRefunded: 2_500,
          totalAmount: 10_000,
          currency: "usd",
          localRefundAmount: 25,
        },
      },
    });
    expect(updates[0]).toMatchObject({
      paidAmount: 75,
      balanceDue: 25,
      paymentStatus: PaymentStatus.PARTIAL,
    });
    expect(paymentInserts[0]).toMatchObject({
      amount: 25,
      paymentType: "refund",
      status: PaymentRecordStatus.PENDING,
      polarCheckoutId: "polar_order_1",
    });
    expect(paymentUpdates[0]).toMatchObject({ status: PaymentRecordStatus.REFUNDED });
    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });

  it("preserves KWD precision when mapping a cumulative provider refund to local money", async () => {
    const { db, updates, paymentInserts } = createDbMock({
      order: {
        id: "order_1",
        paidAmount: 1.234,
        balanceDue: 0,
        paymentStatus: PaymentStatus.PAID,
        totalAmount: 1.234,
        status: OrderStatus.DELIVERED,
        version: 3,
        currencyCode: "KWD",
        currencyDecimalPlaces: 3,
      },
      payments: [polarPayment({ amount: 1.234, currency: "KWD" })],
    });

    const result = await processPolarWebhookRefund(db as never, {
      orderId: "order_1",
      polarCheckoutId: "polar_order_1",
      amountRefunded: 333,
      totalAmount: 1_000,
      currency: "usd",
      polarStatus: "partially_refunded",
    });

    expect(result).toMatchObject({
      success: true,
      notification: {
        data: { localRefundAmount: 0.411 },
      },
    });
    expect(updates[0]).toMatchObject({
      paidAmount: 0.823,
      balanceDue: 0.411,
      paymentStatus: PaymentStatus.PARTIAL,
    });
    expect(paymentInserts[0]).toMatchObject({
      amount: 0.411,
      currency: "KWD",
      paymentType: "refund",
      status: PaymentRecordStatus.PENDING,
    });
  });

  it("applies only the delta when Polar sends a larger cumulative partial refund", async () => {
    const { db, updates, paymentInserts } = createDbMock({
      order: {
        id: "order_1",
        paidAmount: 75,
        balanceDue: 25,
        paymentStatus: PaymentStatus.PARTIAL,
        totalAmount: 100,
        status: OrderStatus.PARTIALLY_REFUNDED,
        version: 4,
      },
      payments: [
        polarPayment(),
        polarRefundPayment({ amount: 25 }),
      ],
    });

    const result = await processPolarWebhookRefund(db as never, {
      orderId: "order_1",
      polarCheckoutId: "polar_order_1",
      amountRefunded: 5_000,
      totalAmount: 10_000,
      currency: "usd",
      polarStatus: "partially_refunded",
    });

    expect(result).toEqual({
      success: true,
      notification: {
        notificationType: "order_partially_refunded",
        dedupeKey: "polar-refund:order_1:partial:5000:10000:usd",
        data: {
          gateway: "polar",
          polarStatus: "partially_refunded",
          amountRefunded: 5_000,
          totalAmount: 10_000,
          currency: "usd",
          localRefundAmount: 25,
        },
      },
    });
    expect(updates[0]).toMatchObject({
      paidAmount: 50,
      balanceDue: 50,
      paymentStatus: PaymentStatus.PARTIAL,
    });
    expect(paymentInserts[0]).toMatchObject({
      amount: 25,
      paymentType: "refund",
      status: PaymentRecordStatus.PENDING,
    });
  });

  it("preserves KWD precision when applying only a later cumulative refund delta", async () => {
    const { db, updates, paymentInserts } = createDbMock({
      order: {
        id: "order_1",
        paidAmount: 0.823,
        balanceDue: 0.411,
        paymentStatus: PaymentStatus.PARTIAL,
        totalAmount: 1.234,
        status: OrderStatus.PARTIALLY_REFUNDED,
        version: 4,
        currencyCode: "KWD",
        currencyDecimalPlaces: 3,
      },
      payments: [
        polarPayment({ amount: 1.234, currency: "KWD" }),
        polarRefundPayment({ amount: 0.411, currency: "KWD" }),
      ],
    });

    const result = await processPolarWebhookRefund(db as never, {
      orderId: "order_1",
      polarCheckoutId: "polar_order_1",
      amountRefunded: 667,
      totalAmount: 1_000,
      currency: "usd",
      polarStatus: "partially_refunded",
    });

    expect(result).toMatchObject({
      success: true,
      notification: {
        data: { localRefundAmount: 0.412 },
      },
    });
    expect(updates[0]).toMatchObject({
      paidAmount: 0.411,
      balanceDue: 0.823,
      paymentStatus: PaymentStatus.PARTIAL,
    });
    expect(paymentInserts[0]).toMatchObject({
      amount: 0.412,
      currency: "KWD",
      paymentType: "refund",
      status: PaymentRecordStatus.PENDING,
    });
  });

  it("rounds local Polar refund facts to JPY zero-decimal precision", async () => {
    const { db, updates, paymentInserts } = createDbMock({
      order: {
        id: "order_1",
        paidAmount: 101,
        balanceDue: 0,
        paymentStatus: PaymentStatus.PAID,
        totalAmount: 101,
        status: OrderStatus.DELIVERED,
        version: 3,
        currencyCode: "JPY",
        currencyDecimalPlaces: 0,
      },
      payments: [polarPayment({ amount: 101, currency: "JPY" })],
    });

    const result = await processPolarWebhookRefund(db as never, {
      orderId: "order_1",
      polarCheckoutId: "polar_order_1",
      amountRefunded: 2_560,
      totalAmount: 10_000,
      currency: "usd",
      polarStatus: "partially_refunded",
    });

    expect(result).toMatchObject({
      success: true,
      notification: {
        data: { localRefundAmount: 26 },
      },
    });
    expect(updates[0]).toMatchObject({
      paidAmount: 75,
      balanceDue: 26,
      paymentStatus: PaymentStatus.PARTIAL,
    });
    expect(paymentInserts[0]).toMatchObject({
      amount: 26,
      currency: "JPY",
      paymentType: "refund",
      status: PaymentRecordStatus.PENDING,
    });
  });

  it("fails closed before mutation when the Polar ledger currency differs from the order snapshot", async () => {
    const { db, updates, paymentInserts, paymentUpdates } = createDbMock({
      order: {
        id: "order_1",
        paidAmount: 1.234,
        balanceDue: 0,
        paymentStatus: PaymentStatus.PAID,
        totalAmount: 1.234,
        status: OrderStatus.DELIVERED,
        version: 3,
        currencyCode: "KWD",
        currencyDecimalPlaces: 3,
      },
      payments: [polarPayment({ amount: 1.234, currency: "BDT" })],
    });

    const result = await processPolarWebhookRefund(db as never, {
      orderId: "order_1",
      polarCheckoutId: "polar_order_1",
      amountRefunded: 333,
      totalAmount: 1_000,
      currency: "usd",
      polarStatus: "partially_refunded",
    });

    expect(result).toEqual({
      success: false,
      error: "Polar order payment currency does not match the immutable order currency. Repair the payment ledger before continuing.",
    });
    expect(updates).toHaveLength(0);
    expect(paymentInserts).toHaveLength(0);
    expect(paymentUpdates).toHaveLength(0);
  });

  it("treats a fully refunded Polar deposit as a partial order refund", async () => {
    const { db, updates } = createDbMock({
      order: {
        id: "order_1",
        paidAmount: 100,
        balanceDue: 0,
        paymentStatus: PaymentStatus.PAID,
        totalAmount: 100,
        status: OrderStatus.CONFIRMED,
        version: 3,
      },
      payments: [
        polarPayment({ amount: 30, paymentType: "deposit" }),
        {
          id: "pay_ssl",
          amount: 70,
          currency: "BDT",
          paymentMethod: "sslcommerz",
          paymentType: "balance",
          status: PaymentRecordStatus.SUCCEEDED,
          polarCheckoutId: null,
          metadata: null,
        },
      ],
    });

    const result = await processPolarWebhookRefund(db as never, {
      orderId: "order_1",
      polarCheckoutId: "polar_order_1",
      amountRefunded: 3_000,
      totalAmount: 3_000,
      currency: "usd",
      polarStatus: "refunded",
    });

    expect(result).toEqual({
      success: true,
      notification: {
        notificationType: "order_partially_refunded",
        dedupeKey: "polar-refund:order_1:partial:3000:3000:usd",
        data: {
          gateway: "polar",
          polarStatus: "refunded",
          amountRefunded: 3_000,
          totalAmount: 3_000,
          currency: "usd",
          localRefundAmount: 30,
        },
      },
    });
    expect(updates[0]).toMatchObject({
      paidAmount: 70,
      balanceDue: 30,
      paymentStatus: PaymentStatus.PARTIAL,
    });
    expect(updates[0]).not.toHaveProperty("status");
    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });

  it("retries a later cumulative refund while an earlier source refund row is pending", async () => {
    const { db, updates, paymentInserts } = createDbMock({
      order: {
        id: "order_1",
        paidAmount: 100,
        balanceDue: 0,
        paymentStatus: PaymentStatus.PAID,
        totalAmount: 100,
        status: OrderStatus.DELIVERED,
        version: 3,
      },
      payments: [
        polarPayment(),
        polarRefundPayment({
          id: "refund_pending_2500",
          amount: 25,
          status: PaymentRecordStatus.PENDING,
        }),
      ],
    });

    const result = await processPolarWebhookRefund(db as never, {
      orderId: "order_1",
      polarCheckoutId: "polar_order_1",
      amountRefunded: 5_000,
      totalAmount: 10_000,
      currency: "usd",
      polarStatus: "partially_refunded",
    });

    expect(result).toEqual({
      success: false,
      error: "A previous Polar external refund is still being reconciled; retry required",
    });
    expect(updates).toHaveLength(0);
    expect(paymentInserts).toHaveLength(0);
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
      payments: [polarPayment()],
    });

    const result = await processPolarWebhookRefund(db as never, {
      orderId: "order_1",
      polarCheckoutId: "polar_order_1",
      amountRefunded: 10_000,
      totalAmount: 10_000,
      currency: "usd",
      polarStatus: "refunded",
    });

    expect(result).toEqual({
      success: true,
      notification: {
        notificationType: "order_refunded",
        dedupeKey: "polar-refund:order_1:full",
        data: {
          gateway: "polar",
          polarStatus: "refunded",
          amountRefunded: 10_000,
          totalAmount: 10_000,
          currency: "usd",
          localRefundAmount: 100,
        },
      },
    });
    expect(updates[0]).toMatchObject({
      paymentStatus: PaymentStatus.REFUNDED,
      balanceDue: 100,
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
      payments: [polarPayment()],
    });

    const result = await processPolarWebhookRefund(db as never, {
      orderId: "order_1",
      polarCheckoutId: "polar_order_1",
      amountRefunded: 10_000,
      totalAmount: 10_000,
      currency: "usd",
      polarStatus: "refunded",
    });

    expect(result).toEqual({
      success: true,
      notification: {
        notificationType: "order_refunded",
        dedupeKey: "polar-refund:order_1:full",
        data: {
          gateway: "polar",
          polarStatus: "refunded",
          amountRefunded: 10_000,
          totalAmount: 10_000,
          currency: "usd",
          localRefundAmount: 0,
        },
      },
    });
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
      payments: [polarPayment()],
    });

    const result = await processPolarWebhookRefund(db as never, {
      orderId: "order_1",
      polarCheckoutId: "polar_order_1",
      amountRefunded: 10_000,
      totalAmount: 10_000,
      currency: "usd",
      polarStatus: "refunded",
    });

    expect(result).toEqual({
      success: true,
      notification: {
        notificationType: "order_refunded",
        dedupeKey: "polar-refund:order_1:full",
        data: {
          gateway: "polar",
          polarStatus: "refunded",
          amountRefunded: 10_000,
          totalAmount: 10_000,
          currency: "usd",
          localRefundAmount: 0,
        },
      },
    });
    expect(updates).toHaveLength(0);
    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });
});

describe("Polar client cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.polarCheckoutCreate.mockResolvedValue({ url: "https://polar.example/checkout", id: "co_1" });
    mocks.polarCheckoutList.mockResolvedValue(checkoutPages([]));
    mocks.polarRefundCreate.mockResolvedValue({ id: "refund_1" });
  });

  it("retrieves only the safe checkout verification projection", async () => {
    mocks.polarCheckoutGet.mockResolvedValueOnce({
      id: "co_1",
      status: "succeeded",
      totalAmount: 2149,
      currency: "usd",
      clientSecret: "provider-secret",
      customerEmail: "buyer@example.test",
      metadata: {
        orderId: "order_1",
        paymentType: "full",
        ignoredObject: { nested: true },
      },
    });

    const result = await retrievePolarCheckout({
      enabled: true,
      accessToken: "polar_token",
      webhookSecret: "polar_whs_test",
      productId: "product_1",
      sandbox: true,
    }, "co_1", 5_000);

    expect(result).toEqual({
      success: true,
      checkout: {
        id: "co_1",
        status: "succeeded",
        totalAmount: 2149,
        currency: "usd",
        metadata: { orderId: "order_1", paymentType: "full" },
      },
    });
    expect(mocks.polarCheckoutGet).toHaveBeenCalledWith(
      { id: "co_1" },
      { retries: { strategy: "none" }, timeoutMs: 5_000 },
    );
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

  it("creates checkout sessions with retry metadata and Polar return URL", async () => {
    const result = await createPolarCheckout(
      {
        enabled: true,
        accessToken: "polar_token",
        webhookSecret: "polar_whs_test",
        productId: "product_1",
        sandbox: true,
      },
      {
        orderId: "order_1",
        amount: 1000,
        currency: "usd",
        productId: "product_1",
        paymentType: "full",
        successUrl: "https://shop.example/success",
        cancelUrl: "https://shop.example/cancel",
        customerId: "customer_1",
        customerEmail: "buyer@example.com",
        idempotencyKey: "payment_session:polar:hash_1",
      },
    );

    expect(result).toEqual({
      success: true,
      checkoutUrl: "https://polar.example/checkout",
      checkoutId: "co_1",
    });
    expect(mocks.polarCheckoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        successUrl: "https://shop.example/success",
        returnUrl: "https://shop.example/cancel",
        externalCustomerId: "customer_1",
        customerEmail: "buyer@example.com",
        metadata: expect.objectContaining({
          orderId: "order_1",
          paymentType: "full",
          scaliusPaymentAttemptKey: "payment_session:polar:hash_1",
        }),
      }),
      expect.objectContaining({ retries: { strategy: "none" } }),
    );
  });

  it("finds a reusable open checkout by deterministic metadata", async () => {
    mocks.polarCheckoutList.mockResolvedValueOnce(checkoutPages([
      {
        id: "co_wrong",
        url: "https://polar.example/wrong",
        productId: "product_1",
        amount: 1000,
        currency: "usd",
        metadata: { orderId: "order_1", paymentType: "full", scaliusPaymentAttemptKey: "different" },
      },
      {
        id: "co_recovered",
        url: "https://polar.example/recovered",
        productId: "product_1",
        amount: 1000,
        currency: "usd",
        metadata: {
          orderId: "order_1",
          paymentType: "full",
          scaliusPaymentAttemptKey: "payment_session:polar:hash_1",
        },
      },
    ]));

    const result = await findReusablePolarCheckout(
      {
        enabled: true,
        accessToken: "polar_token",
        webhookSecret: "polar_whs_test",
        productId: "product_1",
        sandbox: true,
      },
      {
        orderId: "order_1",
        amount: 1000,
        currency: "usd",
        productId: "product_1",
        paymentType: "full",
        customerId: "customer_1",
        idempotencyKey: "payment_session:polar:hash_1",
      },
    );

    expect(result).toEqual({
      success: true,
      checkoutUrl: "https://polar.example/recovered",
      checkoutId: "co_recovered",
      recovered: true,
    });
    expect(mocks.polarCheckoutList).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: "product_1",
        status: "open",
        externalCustomerId: "customer_1",
        limit: 100,
      }),
      expect.objectContaining({ retries: { strategy: "none" } }),
    );
  });

  it("uses Polar's supported customer-request reason when none is supplied", async () => {
    const result = await createPolarRefund(
      {
        enabled: true,
        accessToken: "polar_token",
        webhookSecret: "polar_whs_test",
        productId: "product_1",
        sandbox: true,
      },
      {
        polarOrderId: "polar_order_1",
        amount: 1_000,
      },
    );

    expect(result).toEqual({ success: true, refundId: "refund_1" });
    expect(mocks.polarRefundCreate).toHaveBeenCalledWith({
      orderId: "polar_order_1",
      amount: 1_000,
      reason: "customer_request",
      comment: undefined,
      metadata: undefined,
    });
  });
});

async function* checkoutPages(items: Array<Record<string, unknown>>) {
  yield { result: { items } };
}
