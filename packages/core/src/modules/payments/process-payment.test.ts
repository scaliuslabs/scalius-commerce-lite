// Behaviour tests on the migrated SQLite schema: provider payment events are
// applied through the gateway-agnostic kernel exactly once.
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import {
  orders,
  orderPayments,
  paymentPlans,
  OrderStatus,
  PaymentPlanStatus,
  PaymentRecordStatus,
  PaymentStatus,
} from "@scalius/database/schema";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

const mocks = vi.hoisted(() => ({
  applyInventoryForStatusChange: vi.fn(),
}));

vi.mock("../inventory/inventory-transitions", () => ({
  applyInventoryForStatusChange: mocks.applyInventoryForStatusChange,
}));

import {
  processPaymentConfirmed,
  processPaymentFailed,
  releaseOrderInventory,
} from "./process-payment";
import type { ProcessPaymentParams } from "./types";

let sqlite: DatabaseSync;
let db: Database;

function openDatabase(beforeFirstBatch?: (sqlite: DatabaseSync) => void) {
  let pending = beforeFirstBatch;
  const created = createSqliteD1Database({
    beforeBatch(raceSqlite) {
      const race = pending;
      pending = undefined;
      race?.(raceSqlite);
    },
  });
  sqlite = created.sqlite;
  db = created.db;
}

async function insertOrder(overrides: Partial<typeof orders.$inferInsert> = {}) {
  await db.insert(orders).values({
    id: "order_1",
    customerName: "Buyer",
    customerPhone: "+8801711111111",
    shippingAddress: "Dhaka",
    city: "dhaka",
    zone: "zone_1",
    totalAmountMinor: 100,
    balanceDueMinor: 100,
    paymentMethod: "stripe",
    status: OrderStatus.INCOMPLETE,
    currencyCode: "BDT",
    currencyDecimalPlaces: 2,
    ...overrides,
  });
}

function confirm(overrides: Partial<ProcessPaymentParams> = {}) {
  return processPaymentConfirmed(db, {
    orderId: "order_1",
    provider: "stripe",
    amountMinor: 100,
    currency: "BDT",
    paymentType: "full",
    providerRef: "pi_1",
    secondaryRef: "ch_1",
    ...overrides,
  });
}

function order() {
  return sqlite.prepare("SELECT status, payment_status, payment_method, paid_amount_minor, balance_due_minor FROM orders WHERE id = 'order_1'").get();
}

function payments() {
  return sqlite.prepare(`
    SELECT order_id, payment_method, payment_type, status, amount_minor, provider_ref, provider_secondary_ref
    FROM order_payments ORDER BY created_at, id
  `).all();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.applyInventoryForStatusChange.mockResolvedValue("restored");
  openDatabase();
});

afterEach(() => {
  sqlite.close();
});

describe("confirmed payments", () => {
  it("credits a provider reference once no matter how often it is delivered", async () => {
    await insertOrder();

    await expect(confirm()).resolves.toEqual({ success: true, paymentType: "full" });
    await expect(confirm()).resolves.toEqual({ success: true, alreadyProcessed: true });
    await expect(confirm({ secondaryRef: undefined })).resolves.toEqual({ success: true, alreadyProcessed: true });

    expect(order()).toMatchObject({
      status: OrderStatus.PENDING,
      payment_status: PaymentStatus.PAID,
      paid_amount_minor: 100,
      balance_due_minor: 0,
    });
    expect(payments()).toEqual([{
      order_id: "order_1",
      payment_method: "stripe",
      payment_type: "full",
      status: PaymentRecordStatus.SUCCEEDED,
      amount_minor: 100,
      provider_ref: "pi_1",
      provider_secondary_ref: "ch_1",
    }]);
  });

  it("promotes an earlier failed attempt for the same provider reference", async () => {
    await insertOrder({ status: OrderStatus.PENDING });
    await processPaymentFailed(db, "order_1", "stripe", "pi_1");
    expect(order()).toMatchObject({ payment_status: PaymentStatus.FAILED });

    await expect(confirm()).resolves.toMatchObject({ success: true });

    expect(order()).toMatchObject({ payment_status: PaymentStatus.PAID, paid_amount_minor: 100 });
    expect(payments()).toEqual([expect.objectContaining({
      status: PaymentRecordStatus.SUCCEEDED,
      provider_ref: "pi_1",
      amount_minor: 100,
    })]);
  });

  it("never credits a provider reference that already belongs to another order", async () => {
    await insertOrder();
    await insertOrder({ id: "order_2" });
    await confirm({ orderId: "order_2" });

    await expect(confirm()).resolves.toMatchObject({ success: false, retryable: false });
    expect(order()).toMatchObject({ payment_status: PaymentStatus.UNPAID, paid_amount_minor: 0 });
  });

  it("sends a provider currency that differs from the order snapshot to manual reconciliation", async () => {
    await insertOrder();

    await expect(confirm({ currency: "USD" })).resolves.toMatchObject({ success: false, retryable: false });
    expect(payments()).toEqual([]);
    expect(order()).toMatchObject({ payment_status: PaymentStatus.UNPAID });
  });

  it("rejects a full payment whose amount differs from the order total", async () => {
    await insertOrder();

    await expect(confirm({ amountMinor: 99 })).resolves.toMatchObject({ success: false, retryable: false });
    expect(payments()).toEqual([]);
  });

  it("does not credit a cancelled order", async () => {
    await insertOrder({ status: OrderStatus.CANCELLED });

    await expect(confirm()).resolves.toMatchObject({ success: false, retryable: false });
    expect(payments()).toEqual([]);
  });

  it("retries rather than credits while shipment creation holds the order", async () => {
    await insertOrder({
      shipmentClaimId: "claim_1",
      shipmentClaimExpiresAt: new Date(Date.now() + 60_000),
    });

    const result = await confirm();
    expect(result.success).toBe(false);
    expect(result.retryable).toBeUndefined();
    expect(payments()).toEqual([]);
  });

  it("accepts a late success from another online gateway only after the checkout failed", async () => {
    await insertOrder({ paymentMethod: "sslcommerz" });
    await expect(confirm()).resolves.toMatchObject({ success: false, retryable: false });

    sqlite.prepare("UPDATE orders SET payment_status = 'failed' WHERE id = 'order_1'").run();
    await expect(confirm()).resolves.toMatchObject({ success: true });
    expect(order()).toMatchObject({ payment_method: "stripe", payment_status: PaymentStatus.PAID });
  });

  it("applies deposit then balance against the payment plan, inferring the type when the provider did not bind one", async () => {
    await insertOrder();
    await db.insert(paymentPlans).values({
      id: "plan_1",
      orderId: "order_1",
      totalAmountMinor: 100,
      depositAmountMinor: 25,
      balanceDueMinor: 75,
      status: PaymentPlanStatus.PENDING,
    });

    await expect(confirm({ paymentType: "balance", amountMinor: 75, providerRef: "pi_early" }))
      .resolves.toMatchObject({ success: false, retryable: false });
    await expect(confirm({ paymentType: undefined, amountMinor: 25, providerRef: "pi_deposit" }))
      .resolves.toEqual({ success: true, paymentType: "deposit" });
    expect(order()).toMatchObject({ payment_status: PaymentStatus.PARTIAL, paid_amount_minor: 25, balance_due_minor: 75 });

    await expect(confirm({ paymentType: "deposit", amountMinor: 25, providerRef: "pi_again" }))
      .resolves.toMatchObject({ success: false, retryable: false });
    await expect(confirm({ paymentType: "balance", amountMinor: 75, providerRef: "pi_balance" }))
      .resolves.toEqual({ success: true, paymentType: "balance" });

    expect(order()).toMatchObject({ payment_status: PaymentStatus.PAID, paid_amount_minor: 100, balance_due_minor: 0 });
    expect(sqlite.prepare("SELECT status FROM payment_plans WHERE id = 'plan_1'").get())
      .toEqual({ status: PaymentPlanStatus.COMPLETED });
    expect(payments().map((row) => (row as { provider_ref: string }).provider_ref).sort()).toEqual(["pi_balance", "pi_deposit"]);
  });

  it("applies money at the immutable order precision", async () => {
    await insertOrder({ totalAmountMinor: 1235, balanceDueMinor: 1235, currencyCode: "KWD", currencyDecimalPlaces: 3 });

    await expect(confirm({ amountMinor: 1235, currency: "KWD" })).resolves.toMatchObject({ success: true });
    expect(order()).toMatchObject({ payment_status: PaymentStatus.PAID, paid_amount_minor: 1235, balance_due_minor: 0 });
  });
});

describe("failed payments", () => {
  it("durably converges a pending deposit attempt and its unpaid order", async () => {
    await insertOrder({ status: OrderStatus.PENDING, version: 3 });
    await db.insert(paymentPlans).values({
      id: "plan_1",
      orderId: "order_1",
      totalAmountMinor: 100,
      depositAmountMinor: 25,
      balanceDueMinor: 75,
      status: PaymentPlanStatus.PENDING,
    });
    await db.insert(orderPayments).values({
      id: "pay_1",
      orderId: "order_1",
      amountMinor: 0,
      currency: "BDT",
      paymentMethod: "stripe",
      paymentType: "deposit",
      status: PaymentRecordStatus.PENDING,
      providerRef: "pi_deposit",
    });

    await processPaymentFailed(db, "order_1", "stripe", "pi_deposit");
    await processPaymentFailed(db, "order_1", "stripe", "pi_deposit");

    expect(sqlite.prepare("SELECT payment_status, version FROM orders WHERE id = 'order_1'").get())
      .toEqual({ payment_status: PaymentStatus.FAILED, version: 4 });
    expect(sqlite.prepare("SELECT status, payment_type FROM order_payments WHERE id = 'pay_1'").get())
      .toEqual({ status: PaymentRecordStatus.FAILED, payment_type: "deposit" });
  });

  it("records a balance failure without changing partial-payment truth", async () => {
    await insertOrder({ status: OrderStatus.PENDING, paidAmountMinor: 25, balanceDueMinor: 75, paymentStatus: PaymentStatus.PARTIAL, version: 5 });
    await db.insert(paymentPlans).values({
      id: "plan_1",
      orderId: "order_1",
      totalAmountMinor: 100,
      depositAmountMinor: 25,
      balanceDueMinor: 75,
      status: PaymentPlanStatus.DEPOSIT_PAID,
    });

    await processPaymentFailed(db, "order_1", "sslcommerz", "val_balance");

    expect(order()).toMatchObject({ payment_status: PaymentStatus.PARTIAL, paid_amount_minor: 25, balance_due_minor: 75 });
    expect(payments()).toEqual([expect.objectContaining({
      status: PaymentRecordStatus.FAILED,
      payment_type: "balance",
      payment_method: "sslcommerz",
      provider_ref: "val_balance",
    })]);
  });

  it("does not let a late failure overwrite success committed before its batch", async () => {
    sqlite.close();
    openDatabase((race) => {
      race.prepare("UPDATE order_payments SET status = ?, amount_minor = 100 WHERE id = 'pay_1'").run(PaymentRecordStatus.SUCCEEDED);
      race.prepare("UPDATE orders SET payment_status = ?, paid_amount_minor = 100, balance_due_minor = 0, version = version + 1 WHERE id = 'order_1'")
        .run(PaymentStatus.PAID);
    });
    await insertOrder({ status: OrderStatus.PENDING, version: 7 });
    await db.insert(orderPayments).values({
      id: "pay_1",
      orderId: "order_1",
      amountMinor: 0,
      currency: "BDT",
      paymentMethod: "stripe",
      paymentType: "full",
      status: PaymentRecordStatus.PENDING,
      providerRef: "pi_race",
    });

    await processPaymentFailed(db, "order_1", "stripe", "pi_race");

    expect(order()).toMatchObject({ payment_status: PaymentStatus.PAID, paid_amount_minor: 100 });
    expect(sqlite.prepare("SELECT status FROM order_payments WHERE id = 'pay_1'").get())
      .toEqual({ status: PaymentRecordStatus.SUCCEEDED });
  });

  it("releases a cancelled payment's inventory through the central transition", async () => {
    await insertOrder();
    await releaseOrderInventory(db, "order_1");
    expect(mocks.applyInventoryForStatusChange).toHaveBeenCalledWith(db, "order_1", OrderStatus.CANCELLED);
  });
});
