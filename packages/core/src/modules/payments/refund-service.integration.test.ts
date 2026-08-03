import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@scalius/database/client";
import * as schema from "@scalius/database/schema";

const mocks = vi.hoisted(() => ({
  getStripeSettings: vi.fn(),
  getSSLCommerzSettings: vi.fn(),
  getPolarSettings: vi.fn(),
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

vi.mock("../promotions/promotions.refunds", () => ({
  readPromotionRefundSnapshot: mocks.readPromotionRefundSnapshot,
}));

import { processRefund } from "./refund-service";

type ProxyMethod = "run" | "all" | "values" | "get";
type ProxyQuery = { sql: string; params: unknown[]; method: ProxyMethod };

function queryRows(sqlite: DatabaseSync, query: ProxyQuery) {
  const statement = sqlite.prepare(query.sql);
  statement.setReturnArrays(true);
  const params = query.params as SQLInputValue[];
  if (query.method === "run") {
    statement.run(...params);
    return [];
  }
  if (query.method === "get") {
    return statement.get(...params) as unknown as unknown[];
  }
  return statement.all(...params) as unknown as unknown[][];
}

function createRefundDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE orders (
      id TEXT PRIMARY KEY NOT NULL,
      total_amount REAL NOT NULL,
      paid_amount REAL NOT NULL,
      balance_due REAL NOT NULL,
      payment_status TEXT NOT NULL,
      payment_method TEXT NOT NULL,
      status TEXT NOT NULL,
      inventory_action TEXT NOT NULL,
      version INTEGER NOT NULL,
      shipment_claim_id TEXT,
      shipment_claim_expires_at INTEGER,
      currency_code TEXT,
      currency_decimal_places INTEGER,
      discount_amount_minor INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE order_payments (
      id TEXT PRIMARY KEY NOT NULL,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'BDT' NOT NULL,
      payment_method TEXT NOT NULL,
      payment_type TEXT DEFAULT 'full' NOT NULL,
      status TEXT DEFAULT 'pending' NOT NULL,
      stripe_payment_intent_id TEXT,
      stripe_charge_id TEXT,
      sslcommerz_tran_id TEXT,
      sslcommerz_val_id TEXT,
      sslcommerz_bank_tran_id TEXT,
      polar_checkout_id TEXT,
      cod_collected_by TEXT,
      cod_collected_at INTEGER,
      cod_receipt_url TEXT,
      metadata TEXT,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch()) NOT NULL
    );

    CREATE TABLE refund_attempts (
      id TEXT PRIMARY KEY NOT NULL,
      attempt_key TEXT NOT NULL,
      refund_group_id TEXT NOT NULL,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      source_payment_id TEXT NOT NULL REFERENCES order_payments(id) ON DELETE CASCADE,
      refund_payment_id TEXT NOT NULL REFERENCES order_payments(id) ON DELETE CASCADE,
      gateway TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'BDT' NOT NULL,
      reason TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      provider_idempotency_key TEXT NOT NULL,
      refund_reference TEXT NOT NULL,
      allocation_index INTEGER DEFAULT 0 NOT NULL,
      allocation_count INTEGER DEFAULT 1 NOT NULL,
      source_transaction_id TEXT,
      provider_refund_id TEXT,
      provider_correlation_id TEXT,
      provider_status TEXT,
      request_payload TEXT,
      response_payload TEXT,
      status TEXT DEFAULT 'pending' NOT NULL,
      attempts INTEGER DEFAULT 0 NOT NULL,
      next_probe_at INTEGER DEFAULT (unixepoch()) NOT NULL,
      claim_id TEXT,
      claim_expires_at INTEGER,
      last_probe_at INTEGER,
      last_error TEXT,
      metadata TEXT,
      refunded_at INTEGER,
      failed_at INTEGER,
      cancelled_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch()) NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch()) NOT NULL
    );

    CREATE UNIQUE INDEX refund_attempts_attempt_key_unique
      ON refund_attempts(attempt_key);
    CREATE UNIQUE INDEX refund_attempts_provider_idempotency_key_unique
      ON refund_attempts(provider_idempotency_key);
    CREATE UNIQUE INDEX refund_attempts_reference_unique
      ON refund_attempts(refund_reference);
    CREATE UNIQUE INDEX refund_attempts_group_allocation_unique
      ON refund_attempts(refund_group_id, allocation_index);
    CREATE UNIQUE INDEX refund_attempts_live_source_payment_singleflight
      ON refund_attempts(source_payment_id)
      WHERE status IN ('pending', 'processing', 'provider_unknown', 'reconcile_required');

    CREATE TABLE payment_session_attempts (
      order_id TEXT NOT NULL,
      status TEXT NOT NULL,
      claim_expires_at INTEGER
    );

    INSERT INTO orders (
      id, total_amount, paid_amount, balance_due, payment_status,
      payment_method, status, inventory_action, version,
      shipment_claim_id, shipment_claim_expires_at, currency_code,
      currency_decimal_places, discount_amount_minor, updated_at
    ) VALUES (
      'order_1', 100, 100, 0, 'paid', 'sslcommerz', 'pending',
      'deducted', 2, NULL, NULL, 'BDT', 2, 0, unixepoch()
    );

    INSERT INTO order_payments (
      id, order_id, amount, currency, payment_method, payment_type,
      status, sslcommerz_bank_tran_id, created_at, updated_at
    ) VALUES (
      'payment_1', 'order_1', 100, 'BDT', 'sslcommerz', 'full',
      'succeeded', 'bank_transaction_1', unixepoch(), unixepoch()
    );
  `);

  const execute = async (sql: string, params: unknown[], method: ProxyMethod) => ({
    rows: queryRows(sqlite, { sql, params, method }),
  });
  const batch = async (queries: ProxyQuery[]) => {
    sqlite.exec("BEGIN");
    try {
      const results = queries.map((query) => ({ rows: queryRows(sqlite, query) }));
      sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  };

  return {
    sqlite,
    db: drizzle(execute, batch, { schema }) as unknown as Database,
  };
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
