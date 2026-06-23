import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrderStatus, PaymentRecordStatus, PaymentStatus } from "@scalius/database/schema";

const mocks = vi.hoisted(() => ({
  getStripeSettings: vi.fn(),
  getSSLCommerzSettings: vi.fn(),
  getPolarSettings: vi.fn(),
  createPaymentProvider: vi.fn(),
  providerCreateRefund: vi.fn(),
  getCurrencyConfig: vi.fn(),
  canTransitionTo: vi.fn(),
  applyInventoryForStatusChange: vi.fn(),
}));

vi.mock("./gateway-settings", () => ({
  FRESH_GATEWAY_SETTINGS_READ_OPTIONS: { bypassMemoryCache: true },
  getStripeSettings: mocks.getStripeSettings,
  getSSLCommerzSettings: mocks.getSSLCommerzSettings,
  getPolarSettings: mocks.getPolarSettings,
}));

vi.mock("./factory", () => ({
  createPaymentProvider: mocks.createPaymentProvider,
}));

vi.mock("../settings/settings.service", () => ({
  getCurrencyConfig: mocks.getCurrencyConfig,
}));

vi.mock("../orders/order-state-machine", () => ({
  canTransitionTo: mocks.canTransitionTo,
}));

vi.mock("../inventory/inventory-transitions", () => ({
  applyInventoryForStatusChange: mocks.applyInventoryForStatusChange,
}));

import { processRefund } from "./refund-service";

type PaymentRow = {
  id: string;
  orderId: string;
  amount: number;
  paymentMethod: "stripe" | "sslcommerz" | "polar" | "cod";
  paymentType: "full" | "deposit" | "balance" | "refund";
  status: string;
  stripeChargeId: string | null;
  sslcommerzBankTranId: string | null;
  polarCheckoutId: string | null;
  metadata: string | null;
};

const order = {
  id: "order_1",
  totalAmount: 100,
  paidAmount: 100,
  balanceDue: 0,
  paymentStatus: PaymentStatus.PAID,
  paymentMethod: "stripe",
  status: OrderStatus.DELIVERED,
  inventoryAction: "deducted",
  version: 3,
  shipmentClaimId: null,
  shipmentClaimExpiresAt: null,
};

function stripePayment(overrides: Partial<PaymentRow>): PaymentRow {
  return {
    id: "pay_stripe",
    orderId: "order_1",
    amount: 100,
    paymentMethod: "stripe",
    paymentType: "full",
    status: PaymentRecordStatus.SUCCEEDED,
    stripeChargeId: "ch_stripe",
    sslcommerzBankTranId: null,
    polarCheckoutId: null,
    metadata: null,
    ...overrides,
  };
}

function sslPayment(overrides: Partial<PaymentRow>): PaymentRow {
  return {
    id: "pay_ssl",
    orderId: "order_1",
    amount: 100,
    paymentMethod: "sslcommerz",
    paymentType: "full",
    status: PaymentRecordStatus.SUCCEEDED,
    stripeChargeId: null,
    sslcommerzBankTranId: "bank_ssl",
    polarCheckoutId: null,
    metadata: null,
    ...overrides,
  };
}

function refundRow(overrides: Partial<PaymentRow>): PaymentRow {
  return {
    id: "refund_1",
    orderId: "order_1",
    amount: 10,
    paymentMethod: "stripe",
    paymentType: "refund",
    status: PaymentRecordStatus.REFUNDED,
    stripeChargeId: null,
    sslcommerzBankTranId: null,
    polarCheckoutId: null,
    metadata: null,
    ...overrides,
  };
}

function createDbMock({
  payments,
  refunds = [],
  activeAttempt = null,
  pendingRefund = null,
}: {
  payments: PaymentRow[];
  refunds?: PaymentRow[];
  activeAttempt?: Record<string, unknown> | null;
  pendingRefund?: Record<string, unknown> | null;
}) {
  let selectCall = 0;
  const insertValues: Array<Record<string, unknown>> = [];
  const refundAttemptInsertValues: Array<Record<string, unknown>> = [];
  const updateValues: Array<Record<string, unknown>> = [];

  const batch = vi.fn(async (statements: unknown[]) => [
    ...statements.slice(0, -1).map((_, index) => [{ id: `refund_row_${index + 1}` }]),
    [{ id: "order_1", version: 4 }],
  ]);

  const chainFor = (result: unknown) => {
    const chain = {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      get: vi.fn(async () => result ?? null),
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(Array.isArray(result) ? result : result ? [result] : []).then(resolve, reject),
    };
    return chain;
  };

  return {
    batch,
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        if ("attemptKey" in values || "refundPaymentId" in values) {
          refundAttemptInsertValues.push(values);
        } else {
          insertValues.push(values);
        }
        return { kind: "insert", values };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updateValues.push(values);
        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () => [{ id: "order_1", version: 5 }]),
          })),
        };
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async () => undefined),
    })),
    select: vi.fn(() => {
      selectCall += 1;
      const result = selectCall === 1
        ? order
        : selectCall === 2
          ? activeAttempt
          : selectCall === 3
            ? pendingRefund
            : selectCall === 4
              ? payments
              : refunds;
      return chainFor(result);
    }),
    insertValues,
    refundAttemptInsertValues,
    updateValues,
  };
}

describe("refund allocation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrencyConfig.mockResolvedValue({ code: "BDT" });
    mocks.canTransitionTo.mockReturnValue(false);
    mocks.providerCreateRefund.mockResolvedValue({ refundId: "provider_refund" });
    mocks.createPaymentProvider.mockReturnValue({
      createRefund: mocks.providerCreateRefund,
    });
    mocks.getStripeSettings.mockResolvedValue({ enabled: true, secretKey: "sk_test" });
    mocks.getSSLCommerzSettings.mockResolvedValue({
      enabled: true,
      storeId: "store",
      storePassword: "password",
      sandbox: true,
    });
    mocks.getPolarSettings.mockResolvedValue({
      enabled: true,
      accessToken: "polar_token",
      productId: "polar_product",
      sandbox: true,
    });
  });

  it("allocates a full Stripe split-payment refund across balance and deposit charges with explicit amounts", async () => {
    const db = createDbMock({
      payments: [
        stripePayment({ id: "pay_balance", amount: 70, paymentType: "balance", stripeChargeId: "ch_balance" }),
        stripePayment({ id: "pay_deposit", amount: 30, paymentType: "deposit", stripeChargeId: "ch_deposit" }),
      ],
    });

    await expect(processRefund(db as never, undefined, {
      orderId: "order_1",
      reason: "customer_request",
      gateway: "stripe",
    })).resolves.toMatchObject({
      success: true,
      gateway: "stripe",
      amount: 100,
      isFullRefund: true,
    });

    expect(mocks.providerCreateRefund).toHaveBeenCalledTimes(2);
    expect(mocks.providerCreateRefund).toHaveBeenNthCalledWith(1, expect.objectContaining({
      transactionId: "ch_balance",
      amount: 7000,
      metadata: expect.objectContaining({ sourcePaymentId: "pay_balance" }),
    }));
    expect(mocks.providerCreateRefund).toHaveBeenNthCalledWith(2, expect.objectContaining({
      transactionId: "ch_deposit",
      amount: 3000,
      metadata: expect.objectContaining({ sourcePaymentId: "pay_deposit" }),
    }));
    expect(db.insertValues).toHaveLength(2);
    expect(db.insertValues.map((values) => JSON.parse(values.metadata as string))).toEqual([
      expect.objectContaining({ sourcePaymentId: "pay_balance", allocationIndex: 0 }),
      expect.objectContaining({ sourcePaymentId: "pay_deposit", allocationIndex: 1 }),
    ]);
    expect(db.refundAttemptInsertValues).toHaveLength(2);
    expect(db.refundAttemptInsertValues).toEqual([
      expect.objectContaining({
        sourcePaymentId: "pay_balance",
        refundPaymentId: "refund_order_1_3_1",
        status: "pending",
        providerIdempotencyKey: "refund:order_1:pay_balance:4",
      }),
      expect.objectContaining({
        sourcePaymentId: "pay_deposit",
        refundPaymentId: "refund_order_1_3_2",
        status: "pending",
        providerIdempotencyKey: "refund:order_1:pay_deposit:4",
      }),
    ]);
    expect(db.updateValues).toContainEqual(expect.objectContaining({
      status: "refunded",
      providerStatus: "accepted",
    }));
  });

  it("spills a partial refund into an older payment when the latest payment remaining is insufficient", async () => {
    const db = createDbMock({
      payments: [
        stripePayment({ id: "pay_balance", amount: 70, paymentType: "balance", stripeChargeId: "ch_balance" }),
        stripePayment({ id: "pay_deposit", amount: 30, paymentType: "deposit", stripeChargeId: "ch_deposit" }),
      ],
    });

    await processRefund(db as never, undefined, {
      orderId: "order_1",
      amount: 80,
      reason: "customer_request",
      gateway: "stripe",
    });

    expect(mocks.providerCreateRefund).toHaveBeenCalledTimes(2);
    expect(mocks.providerCreateRefund).toHaveBeenNthCalledWith(1, expect.objectContaining({
      transactionId: "ch_balance",
      amount: 7000,
    }));
    expect(mocks.providerCreateRefund).toHaveBeenNthCalledWith(2, expect.objectContaining({
      transactionId: "ch_deposit",
      amount: 1000,
    }));
  });

  it("reduces source payment capacity by previous refunded rows before allocating", async () => {
    const db = createDbMock({
      payments: [
        stripePayment({ id: "pay_balance", amount: 70, paymentType: "balance", stripeChargeId: "ch_balance" }),
        stripePayment({ id: "pay_deposit", amount: 30, paymentType: "deposit", stripeChargeId: "ch_deposit" }),
      ],
      refunds: [
        refundRow({
          amount: 50,
          metadata: JSON.stringify({ sourcePaymentId: "pay_balance" }),
        }),
      ],
    });

    await processRefund(db as never, undefined, {
      orderId: "order_1",
      amount: 40,
      reason: "customer_request",
      gateway: "stripe",
    });

    expect(mocks.providerCreateRefund).toHaveBeenCalledTimes(2);
    expect(mocks.providerCreateRefund).toHaveBeenNthCalledWith(1, expect.objectContaining({
      transactionId: "ch_balance",
      amount: 2000,
    }));
    expect(mocks.providerCreateRefund).toHaveBeenNthCalledWith(2, expect.objectContaining({
      transactionId: "ch_deposit",
      amount: 2000,
    }));
  });

  it("allocates mixed-gateway refunds with each provider's amount convention", async () => {
    const db = createDbMock({
      payments: [
        sslPayment({ id: "pay_balance", amount: 70, paymentType: "balance", sslcommerzBankTranId: "bank_balance" }),
        stripePayment({ id: "pay_deposit", amount: 30, paymentType: "deposit", stripeChargeId: "ch_deposit" }),
      ],
    });

    await expect(processRefund(db as never, undefined, {
      orderId: "order_1",
      reason: "customer_request",
    })).resolves.toMatchObject({
      gateway: "mixed",
      amount: 100,
    });

    expect(mocks.providerCreateRefund).toHaveBeenCalledTimes(2);
    expect(mocks.providerCreateRefund).toHaveBeenNthCalledWith(1, expect.objectContaining({
      transactionId: "bank_balance",
      amount: 70,
    }));
    expect(mocks.providerCreateRefund).toHaveBeenNthCalledWith(2, expect.objectContaining({
      transactionId: "ch_deposit",
      amount: 3000,
    }));
  });

  it("rejects a gateway override when that gateway has insufficient refundable balance", async () => {
    const db = createDbMock({
      payments: [
        sslPayment({ id: "pay_balance", amount: 70, paymentType: "balance", sslcommerzBankTranId: "bank_balance" }),
        stripePayment({ id: "pay_deposit", amount: 30, paymentType: "deposit", stripeChargeId: "ch_deposit" }),
      ],
    });

    await expect(processRefund(db as never, undefined, {
      orderId: "order_1",
      amount: 40,
      reason: "customer_request",
      gateway: "stripe",
    })).rejects.toThrow("Refund amount exceeds refundable captured payment balance");

    expect(mocks.providerCreateRefund).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("keeps unresolved provider allocations pending when a later provider outcome is unknown", async () => {
    mocks.providerCreateRefund
      .mockResolvedValueOnce({ refundId: "refund_balance" })
      .mockRejectedValueOnce(new Error("provider timeout"));

    const db = createDbMock({
      payments: [
        stripePayment({ id: "pay_balance", amount: 70, paymentType: "balance", stripeChargeId: "ch_balance" }),
        stripePayment({ id: "pay_deposit", amount: 30, paymentType: "deposit", stripeChargeId: "ch_deposit" }),
      ],
    });

    await expect(processRefund(db as never, undefined, {
      orderId: "order_1",
      reason: "customer_request",
      gateway: "stripe",
    })).rejects.toThrow("Refund partially processed: 70 was accepted by the provider, but 30 has an unknown provider outcome.");

    expect(mocks.providerCreateRefund).toHaveBeenCalledTimes(2);
    expect(db.updateValues).toContainEqual(expect.objectContaining({
      status: PaymentRecordStatus.REFUNDED,
    }));
    expect(db.updateValues).toContainEqual(expect.objectContaining({
      status: PaymentRecordStatus.PENDING,
      metadata: expect.stringContaining('"providerOutcome":"unknown"'),
    }));
    expect(db.updateValues).toContainEqual(expect.objectContaining({
      status: "provider_unknown",
      providerStatus: "unknown",
    }));
    expect(db.updateValues).toContainEqual(expect.objectContaining({
      paidAmount: 30,
      balanceDue: 70,
      paymentStatus: PaymentStatus.PARTIAL,
    }));
  });

  it("blocks a new refund while a durable refund attempt is active", async () => {
    const db = createDbMock({
      payments: [
        stripePayment({ id: "pay_1", amount: 100, stripeChargeId: "ch_1" }),
      ],
      activeAttempt: { id: "rfa_active", status: "provider_unknown" },
    });

    await expect(processRefund(db as never, undefined, {
      orderId: "order_1",
      amount: 40,
      reason: "customer_request",
      gateway: "stripe",
    })).rejects.toThrow("A refund is already in progress");

    expect(mocks.providerCreateRefund).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("blocks a new refund while a legacy pending refund row exists", async () => {
    const db = createDbMock({
      payments: [
        stripePayment({ id: "pay_1", amount: 100, stripeChargeId: "ch_1" }),
      ],
      pendingRefund: { id: "refund_pending" },
    });

    await expect(processRefund(db as never, undefined, {
      orderId: "order_1",
      amount: 40,
      reason: "customer_request",
      gateway: "stripe",
    })).rejects.toThrow("A refund is already in progress");

    expect(mocks.providerCreateRefund).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("leaves the whole refund pending when the first provider outcome is unknown", async () => {
    mocks.providerCreateRefund.mockRejectedValueOnce(new Error("network timeout"));

    const db = createDbMock({
      payments: [
        stripePayment({ id: "pay_1", amount: 100, stripeChargeId: "ch_1" }),
      ],
    });

    await expect(processRefund(db as never, undefined, {
      orderId: "order_1",
      amount: 40,
      reason: "customer_request",
      gateway: "stripe",
    })).rejects.toThrow("Refund provider outcome is unknown");

    expect(mocks.providerCreateRefund).toHaveBeenCalledTimes(1);
    expect(db.updateValues).toContainEqual(expect.objectContaining({
      status: PaymentRecordStatus.PENDING,
      metadata: expect.stringContaining('"providerOutcome":"unknown"'),
    }));
    expect(db.updateValues).toContainEqual(expect.objectContaining({
      status: "provider_unknown",
      providerStatus: "unknown",
    }));
    expect(db.updateValues).not.toContainEqual(expect.objectContaining({
      paidAmount: expect.any(Number),
      balanceDue: expect.any(Number),
    }));
  });
});
