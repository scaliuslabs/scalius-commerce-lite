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

import { PaymentRecordStatus, PaymentStatus, OrderStatus } from "@scalius/database/schema";
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
  };
  const payment = {
    id: "payment_1",
    orderId: "order_1",
    amount: 100,
    paymentMethod: gateway,
    paymentType: "full",
    status: "succeeded",
    stripeChargeId: "ch_1",
    sslcommerzBankTranId: "bank_1",
    polarCheckoutId: "polar_order_1",
    metadata: null,
  };

  let selectCall = 0;
  const updateSets: Array<Record<string, unknown>> = [];
  const batch = vi.fn(async () => [undefined, [{ id: "order_1", version: 4 }]]);
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
      selectCall += 1;
      const result = selectCall === 1
        ? order
        : selectCall === 2
          ? null
          : selectCall === 3
            ? [payment]
            : [];
      const chain = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        get: vi.fn(async () => result ?? null),
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(Array.isArray(result) ? result : result ? [result] : []).then(resolve, reject),
      };
      return chain;
    }),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ kind: "insert-refund-claim" })),
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
      kv,
      "enc-key",
      expect.objectContaining({ bypassMemoryCache: true }),
    );
    expect(mocks.createPaymentProvider).toHaveBeenCalledWith(expect.objectContaining({
      type: gateway,
      settings: expect.objectContaining({ enabled: true }),
    }));
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
      kv,
      "enc-key",
      expect.objectContaining({ bypassMemoryCache: true }),
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
