import { beforeEach, describe, expect, it, vi } from "vitest";

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

import {
  orderPayments,
  orders,
  paymentSessionAttempts,
  PaymentRecordStatus,
  PaymentStatus,
  refundAttempts,
  OrderStatus,
} from "@scalius/database/schema";
import { processRefund } from "./refund-service";

type Gateway = "stripe" | "sslcommerz" | "polar";

function createDbMock(gateway: Gateway) {
  const order = {
    id: "order_1",
    totalAmount: 100,
    paidAmount: 100,
    balanceDue: 0,
    paymentStatus: PaymentStatus.PAID,
    paymentMethod: gateway,
    status: OrderStatus.PROCESSING,
    inventoryAction: "reserved",
    version: 3,
    shipmentClaimId: null,
    shipmentClaimExpiresAt: null,
    currencyCode: "BDT",
    currencyDecimalPlaces: 2,
  };
  const payment = {
    id: "payment_1",
    orderId: "order_1",
    amount: 100,
    currency: "BDT",
    paymentMethod: gateway,
    paymentType: "full",
    status: "succeeded",
    stripeChargeId: "ch_1",
    sslcommerzBankTranId: "bank_1",
    polarCheckoutId: "polar_order_1",
    metadata: gateway === "polar"
      ? JSON.stringify({
          originalCurrency: "bdt",
          gatewayCurrency: "usd",
          exchangeRate: "110",
          originalAmount: "100",
          gatewayAmount: 0.91,
        })
      : null,
  };
  const refundAttempt = {
    id: "rfa_refund_order_1_3_1",
    orderId: "order_1",
    refundPaymentId: "refund_order_1_3_1",
    providerRefundId: "refund_1",
    amount: 10,
    currency: "BDT",
  };
  const refundPayment = {
    paymentType: "refund",
    status: PaymentRecordStatus.REFUNDED,
    currency: "BDT",
    get amount() {
      return Number(insertValues[0]?.amount ?? 10);
    },
  };

  let paymentSelectCall = 0;
  let refundAttemptSelectCall = 0;
  const updateSets: Array<Record<string, unknown>> = [];
  const insertValues: Array<Record<string, unknown>> = [];
  const batch = vi.fn(async (statements: unknown[]) => [
    [{ id: "order_1", version: 4 }],
    ...statements.slice(1).map(() => undefined),
  ]);
  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => {
      updateSets.push(values);
      return {
      where: vi.fn(() => ({
        returning: vi.fn(async () => [{ id: "order_1", version: 4 }]),
      })),
    };
    }),
  }));

  return {
    batch,
    update,
    select: vi.fn(() => {
      let result: unknown = null;
      const chain = {
        from: vi.fn((table: unknown) => {
          if (table === orders) {
            result = order;
          } else if (table === paymentSessionAttempts) {
            result = [];
          } else if (table === refundAttempts) {
            refundAttemptSelectCall += 1;
            result = refundAttemptSelectCall === 1 ? null : refundAttempt;
          } else if (table === orderPayments) {
            paymentSelectCall += 1;
            result = paymentSelectCall === 1
              ? null
              : paymentSelectCall === 2
                ? [payment]
                : [payment, refundPayment];
          }
          return chain;
        }),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        get: vi.fn(async () => result ?? null),
        all: vi.fn(async () => Array.isArray(result) ? result : result ? [result] : []),
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(Array.isArray(result) ? result : result ? [result] : []).then(resolve, reject),
      };
      return chain;
    }),
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        if (!("attemptKey" in values)) {
          insertValues.push(values);
        }
        return { kind: "insert-refund-claim", values };
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async () => undefined),
    })),
    updateSets,
  };
}

describe("refund gateway settings freshness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrencyConfig.mockResolvedValue({ code: "BDT" });
    mocks.canTransitionTo.mockReturnValue(false);
    mocks.providerCreateRefund.mockResolvedValue({ refundId: "refund_1" });
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

  it.each([
    ["stripe", mocks.getStripeSettings],
    ["sslcommerz", mocks.getSSLCommerzSettings],
    ["polar", mocks.getPolarSettings],
  ] as const)("uses fresh %s settings when dispatching refunds", async (gateway, settingsReader) => {
    const db = createDbMock(gateway);
    const kv = { id: "kv" } as unknown as KVNamespace;

    await expect(
      processRefund(
        db as never,
        kv,
        { orderId: "order_1", amount: 10, reason: "customer_request", gateway },
        "enc-key",
      ),
    ).resolves.toMatchObject({
      success: true,
      gateway,
      refundId: "refund_1",
    });

    expect(settingsReader).toHaveBeenCalledWith(
      db,
      "enc-key",
    );
    expect(mocks.createPaymentProvider).toHaveBeenCalledWith(expect.objectContaining({
      type: gateway,
      settings: expect.objectContaining({ enabled: true }),
    }));
    if (gateway === "polar") {
      expect(mocks.providerCreateRefund).toHaveBeenCalledWith(expect.objectContaining({
        amount: 9,
      }));
    }
  });

  it("marks the local refund claim failed when a fresh settings read fails before provider dispatch", async () => {
    mocks.getStripeSettings.mockRejectedValue(new Error("d1 overloaded"));
    const db = createDbMock("stripe");
    const kv = { id: "kv" } as unknown as KVNamespace;

    await expect(
      processRefund(
        db as never,
        kv,
        { orderId: "order_1", amount: 10, reason: "customer_request", gateway: "stripe" },
        "enc-key",
      ),
    ).rejects.toThrow("d1 overloaded");

    expect(mocks.getStripeSettings).toHaveBeenCalledWith(
      db,
      "enc-key",
    );
    expect(db.batch).toHaveBeenCalledTimes(2);
    expect(db.updateSets).toContainEqual(expect.objectContaining({
      status: PaymentRecordStatus.FAILED,
      metadata: expect.stringContaining('"providerOutcome":"rejected"'),
    }));
    expect(mocks.createPaymentProvider).not.toHaveBeenCalled();
  });

  it("recomputes balance due when claiming a partial refund", async () => {
    const db = createDbMock("stripe");

    await processRefund(
      db as never,
      undefined,
      { orderId: "order_1", amount: 25, reason: "customer_request", gateway: "stripe" },
      "enc-key",
    );

    expect(db.updateSets).toContainEqual(expect.objectContaining({
      paidAmount: 75,
      balanceDue: 25,
      paymentStatus: PaymentStatus.PARTIAL,
    }));
  });
});
