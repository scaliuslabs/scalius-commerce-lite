import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

const mocks = vi.hoisted(() => ({
  getStripeSettings: vi.fn(),
  getSSLCommerzSettings: vi.fn(),
  createPaymentProvider: vi.fn(),
  providerCreateRefund: vi.fn(),
  getCurrencyConfig: vi.fn(),
  canTransitionTo: vi.fn(),
  applyInventoryForStatusChange: vi.fn(),
  readPromotionRefundSnapshot: vi.fn(),
}));

vi.mock("./gateway-settings", () => ({
  getStripeSettings: mocks.getStripeSettings,
  getSSLCommerzSettings: mocks.getSSLCommerzSettings,
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
  applyInventoryForStatusChangeWithImpact: mocks.applyInventoryForStatusChange,
}));

vi.mock("../promotions/promotions.refunds", () => ({
  readPromotionRefundSnapshot: mocks.readPromotionRefundSnapshot,
}));

import { processRefund } from "./refund-service";

function createRefundDatabase() {
  const fixture = createSqliteD1Database();
  fixture.sqlite.exec(`
    INSERT INTO orders (
      id, customer_name, customer_phone, shipping_address, city, zone,
      total_amount, shipping_charge, paid_amount, balance_due, payment_status,
      payment_method, status, inventory_action, version, currency_code, currency_decimal_places
    ) VALUES (
      'order_1', 'Buyer', '+8801700000000', 'Address', 'city', 'zone',
      100, 0, 100, 0, 'paid', 'sslcommerz', 'pending', 'deducted', 2, 'BDT', 2
    );
    INSERT INTO order_payments (
      id, order_id, amount, currency, payment_method, payment_type, status, sslcommerz_bank_tran_id
    ) VALUES ('payment_1', 'order_1', 100, 'BDT', 'sslcommerz', 'full', 'succeeded', 'bank_transaction_1');
  `);
  return fixture;
}

describe("refund claim database transaction", () => {
  let sqlite: DatabaseSync | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrencyConfig.mockResolvedValue({ code: "BDT" });
    mocks.canTransitionTo.mockReturnValue(false);
    mocks.readPromotionRefundSnapshot.mockResolvedValue(null);
    mocks.getSSLCommerzSettings.mockResolvedValue({
      enabled: true,
      storeId: "store",
      storePassword: "password",
      sandbox: true,
    });
    mocks.createPaymentProvider.mockReturnValue({
      createRefund: mocks.providerCreateRefund,
    });
    mocks.providerCreateRefund.mockResolvedValue({ refundId: "provider_refund_1" });
  });

  afterEach(() => sqlite?.close());

  it("claims before inserting its own active refund rows and reconciles provider acceptance", async () => {
    const fixture = createRefundDatabase();
    sqlite = fixture.sqlite;

    await expect(processRefund(fixture.db, undefined, {
      orderId: "order_1",
      reason: "customer_request",
      gateway: "sslcommerz",
    })).resolves.toMatchObject({
      success: true,
      gateway: "sslcommerz",
      refundId: "provider_refund_1",
      amount: 100,
      isFullRefund: true,
    });

    expect(mocks.providerCreateRefund).toHaveBeenCalledTimes(1);
    expect(mocks.providerCreateRefund).toHaveBeenCalledWith(expect.objectContaining({
      transactionId: "bank_transaction_1",
      amount: 100,
      reason: "customer_request",
    }));

    expect(sqlite.prepare(`
      SELECT paid_amount, balance_due, payment_status, version
      FROM orders WHERE id = 'order_1'
    `).get()).toEqual({
      paid_amount: 0,
      balance_due: 100,
      payment_status: "refunded",
      version: 4,
    });
    expect(sqlite.prepare(`
      SELECT status, provider_status, provider_refund_id
      FROM refund_attempts
    `).get()).toEqual({
      status: "refunded",
      provider_status: "accepted",
      provider_refund_id: "provider_refund_1",
    });
  });
});
