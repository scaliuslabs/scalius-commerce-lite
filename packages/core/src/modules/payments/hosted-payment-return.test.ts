import { describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import {
  OrderStatus,
  PaymentPlanStatus,
  PaymentRecordStatus,
  PaymentStatus,
  orderPayments,
  orders,
  paymentPlans,
  paymentSessionAttempts,
} from "@scalius/database/schema";
import {
  createMigratedSqlite,
  createSqliteD1Database,
  createSqliteTursoDatabase,
} from "@scalius/database/testing/sqlite-d1";

import { reconcileHostedPaymentReturn } from "./hosted-payment-return";
import { processPaymentConfirmed } from "./process-payment";

const createPaymentDatabase = () => createSqliteD1Database();

function createTursoPaymentDatabase() {
  const sqlite = createMigratedSqlite({ provider: "turso" });
  return { sqlite, db: createSqliteTursoDatabase(sqlite) };
}

async function insertHostedOrder(
  db: Database,
  overrides: Partial<typeof orders.$inferInsert> = {},
): Promise<void> {
  await db.insert(orders).values({
    id: "order_1",
    customerName: "Buyer",
    customerPhone: "+8801711111111",
    shippingAddress: "Dhaka",
    city: "dhaka",
    zone: "zone_1",
    status: OrderStatus.INCOMPLETE,
    paymentMethod: "sslcommerz",
    paymentStatus: PaymentStatus.UNPAID,
    balanceDueMinor: 10_000,
    version: 3,
    currencyCode: "BDT",
    currencyDecimalPlaces: 2,
    totalAmountMinor: 10_000,
    ...overrides,
  });
}

async function insertHostedAttempt(
  db: Database,
  overrides: Partial<typeof paymentSessionAttempts.$inferInsert> = {},
): Promise<void> {
  await db.insert(paymentSessionAttempts).values({
    id: "psa_1",
    attemptKey: "payment_session:sslcommerz:attempt_1",
    orderId: "order_1",
    gateway: "sslcommerz",
    paymentType: "full",
    amountMinor: 10_000,
    currency: "BDT",
    requestHash: "request_hash_1",
    status: "created",
    providerSessionId: "session_1",
    providerCorrelationId: "order_1_full_ABC12345",
    responsePayload: JSON.stringify({ gatewayUrl: "https://provider.example.test/pay" }),
    attempts: 1,
    ...overrides,
  });
}

describe("hosted payment return reconciliation", () => {
  it("applies the guarded same-order transition through the TursoDB adapter", async () => {
    const { sqlite, db } = createTursoPaymentDatabase();
    try {
      await insertHostedOrder(db);
      await insertHostedAttempt(db);

      await expect(reconcileHostedPaymentReturn(db, {
        orderId: "order_1",
        gateway: "sslcommerz",
        paymentType: "full",
        result: "failed",
        providerCorrelationId: "order_1_full_ABC12345",
      })).resolves.toBe("retry_ready");

      expect(sqlite.prepare("SELECT payment_status, version FROM orders WHERE id = ?").get("order_1"))
        .toMatchObject({ payment_status: PaymentStatus.FAILED, version: 4 });
      expect(sqlite.prepare("SELECT status FROM payment_session_attempts WHERE id = ?").get("psa_1"))
        .toMatchObject({ status: "failed" });
    } finally {
      sqlite.close();
    }
  });

  it.each([
    { result: "failed" as const, expectedAttemptStatus: "failed" },
    { result: "cancelled" as const, expectedAttemptStatus: "failed" },
  ])("makes an SSLCommerz $result return retryable exactly once", async ({ result, expectedAttemptStatus }) => {
    const { sqlite, db } = createPaymentDatabase();
    try {
      await insertHostedOrder(db);
      await insertHostedAttempt(db);

      await expect(reconcileHostedPaymentReturn(db, {
        orderId: "order_1",
        gateway: "sslcommerz",
        paymentType: "full",
        result,
        providerCorrelationId: "order_1_full_ABC12345",
      })).resolves.toBe("retry_ready");

      expect(sqlite.prepare(`
        SELECT payment_status, paid_amount_minor, version
        FROM orders WHERE id = ?
      `).get("order_1")).toMatchObject({
        payment_status: PaymentStatus.FAILED,
        paid_amount_minor: 0,
        version: 4,
      });
      expect(sqlite.prepare(`
        SELECT status, claim_id, claim_expires_at
        FROM payment_session_attempts WHERE id = ?
      `).get("psa_1")).toMatchObject({
        status: expectedAttemptStatus,
        claim_id: null,
        claim_expires_at: null,
      });
      expect(sqlite.prepare("SELECT count(*) AS count FROM order_payments").get()).toMatchObject({ count: 0 });

      await expect(reconcileHostedPaymentReturn(db, {
        orderId: "order_1",
        gateway: "sslcommerz",
        paymentType: "full",
        result,
        providerCorrelationId: "order_1_full_ABC12345",
      })).resolves.toBe("retry_ready");
      expect(sqlite.prepare("SELECT version FROM orders WHERE id = ?").get("order_1"))
        .toMatchObject({ version: 4 });
    } finally {
      sqlite.close();
    }
  });

  it("ignores an SSLCommerz return whose transaction does not match the stored attempt", async () => {
    const { sqlite, db } = createPaymentDatabase();
    try {
      await insertHostedOrder(db);
      await insertHostedAttempt(db);

      await expect(reconcileHostedPaymentReturn(db, {
        orderId: "order_1",
        gateway: "sslcommerz",
        paymentType: "full",
        result: "failed",
        providerCorrelationId: "order_1_full_FORGED",
      })).resolves.toBe("ignored");

      expect(sqlite.prepare("SELECT payment_status, version FROM orders WHERE id = ?").get("order_1"))
        .toMatchObject({ payment_status: PaymentStatus.UNPAID, version: 3 });
      expect(sqlite.prepare("SELECT status FROM payment_session_attempts WHERE id = ?").get("psa_1"))
        .toMatchObject({ status: "created" });
    } finally {
      sqlite.close();
    }
  });

  it("terminalizes a failed balance attempt without erasing the paid deposit", async () => {
    const { sqlite, db } = createPaymentDatabase();
    try {
      await insertHostedOrder(db, {
        status: OrderStatus.PENDING,
        paymentStatus: PaymentStatus.PARTIAL,
        paidAmountMinor: 2500,
        balanceDueMinor: 7500,
        version: 5,
      });
      await db.insert(paymentPlans).values({
        id: "plan_1",
        orderId: "order_1",
        totalAmountMinor: 10_000,
        depositAmountMinor: 2500,
        balanceDueMinor: 7500,
        status: PaymentPlanStatus.DEPOSIT_PAID,
      });
      await db.insert(orderPayments).values({
        id: "pay_deposit",
        orderId: "order_1",
        amountMinor: 2500,
        currency: "BDT",
        paymentMethod: "sslcommerz",
        paymentType: "deposit",
        status: PaymentRecordStatus.SUCCEEDED,
        providerRef: "val_deposit",
      });
      await insertHostedAttempt(db, {
        attemptKey: "payment_session:sslcommerz:balance_attempt",
        paymentType: "balance",
        amountMinor: 7500,
        providerCorrelationId: "order_1_balance_BALANCE1",
      });

      const input = {
        orderId: "order_1",
        gateway: "sslcommerz" as const,
        paymentType: "balance" as const,
        result: "failed" as const,
        providerCorrelationId: "order_1_balance_BALANCE1",
      };
      await expect(reconcileHostedPaymentReturn(db, input)).resolves.toBe("retry_ready");
      expect(sqlite.prepare(`
        SELECT status, payment_status, paid_amount_minor, balance_due_minor, version
        FROM orders WHERE id = ?
      `).get("order_1")).toMatchObject({
        status: OrderStatus.PENDING,
        payment_status: PaymentStatus.PARTIAL,
        paid_amount_minor: 2500,
        balance_due_minor: 7500,
        version: 6,
      });
      expect(sqlite.prepare("SELECT status FROM payment_session_attempts WHERE id = ?").get("psa_1"))
        .toMatchObject({ status: "failed" });
      expect(sqlite.prepare("SELECT status, amount_minor FROM order_payments WHERE id = ?").get("pay_deposit"))
        .toMatchObject({ status: PaymentRecordStatus.SUCCEEDED, amount_minor: 2500 });

      await expect(reconcileHostedPaymentReturn(db, input)).resolves.toBe("retry_ready");
      expect(sqlite.prepare("SELECT version FROM orders WHERE id = ?").get("order_1"))
        .toMatchObject({ version: 6 });

      await expect(processPaymentConfirmed(db, {
        orderId: "order_1",
        provider: "sslcommerz",
        paymentType: "balance",
        providerRef: "val_balance",
        secondaryRef: "bank_balance",
        amountMinor: 7500,
        currency: "BDT",
      })).resolves.toMatchObject({ success: true });
      expect(sqlite.prepare(`
        SELECT payment_status, paid_amount_minor, balance_due_minor
        FROM orders WHERE id = ?
      `).get("order_1")).toMatchObject({
        payment_status: PaymentStatus.PAID,
        paid_amount_minor: 10_000,
        balance_due_minor: 0,
      });
      expect(sqlite.prepare("SELECT status FROM payment_plans WHERE id = ?").get("plan_1"))
        .toMatchObject({ status: PaymentPlanStatus.COMPLETED });
    } finally {
      sqlite.close();
    }
  });

  it.each([
    {
      gateway: "sslcommerz" as const,
      paymentMethod: "sslcommerz",
      attemptKey: "payment_session:sslcommerz:attempt_1",
      providerSessionId: "session_1",
      providerCorrelationId: "order_1_full_ABC12345",
      confirmation: {
        orderId: "order_1",
        provider: "sslcommerz",
        paymentType: "full" as const,
        providerRef: "val_1",
        secondaryRef: "bank_1",
        amountMinor: 10_000,
        currency: "BDT",
      },
    },
  ])("lets a late $gateway success promote the same failed/cancelled order", async ({
    gateway,
    paymentMethod,
    attemptKey,
    providerSessionId,
    providerCorrelationId,
    confirmation,
  }) => {
    const { sqlite, db } = createPaymentDatabase();
    try {
      await insertHostedOrder(db, {
        paymentMethod,
        paymentIntentId: providerSessionId,
      });
      await insertHostedAttempt(db, {
        attemptKey,
        gateway,
        providerSessionId,
        providerCorrelationId,
      });
      await reconcileHostedPaymentReturn(db, {
        orderId: "order_1",
        gateway,
        paymentType: "full",
        result: "failed",
        providerCorrelationId,
      });

      await expect(processPaymentConfirmed(db, confirmation)).resolves.toMatchObject({ success: true });

      expect(sqlite.prepare(`
        SELECT status, payment_status, paid_amount_minor, balance_due_minor
        FROM orders WHERE id = ?
      `).get("order_1")).toMatchObject({
        status: OrderStatus.PENDING,
        payment_status: PaymentStatus.PAID,
        paid_amount_minor: 10_000,
        balance_due_minor: 0,
      });
      expect(sqlite.prepare(`
        SELECT count(*) AS count
        FROM order_payments
        WHERE order_id = ? AND status = ?
      `).get("order_1", PaymentRecordStatus.SUCCEEDED)).toMatchObject({ count: 1 });

      await expect(reconcileHostedPaymentReturn(db, {
        orderId: "order_1",
        gateway,
        paymentType: "full",
        result: "failed",
        providerCorrelationId,
      })).resolves.toBe("retry_suppressed");
    } finally {
      sqlite.close();
    }
  });

  it("suppresses a cancel while a provider success payment row is already in flight", async () => {
    const { sqlite, db } = createPaymentDatabase();
    try {
      await insertHostedOrder(db);
      await insertHostedAttempt(db);
      await db.insert(orderPayments).values({
        id: "pay_pending",
        orderId: "order_1",
        amountMinor: 10_000,
        currency: "BDT",
        paymentMethod: "sslcommerz",
        paymentType: "full",
        status: PaymentRecordStatus.PENDING,
        providerRef: "val_pending",
      });

      await expect(reconcileHostedPaymentReturn(db, {
        orderId: "order_1",
        gateway: "sslcommerz",
        paymentType: "full",
        result: "cancelled",
        providerCorrelationId: "order_1_full_ABC12345",
      })).resolves.toBe("retry_suppressed");
      expect(sqlite.prepare("SELECT payment_status, version FROM orders WHERE id = ?").get("order_1"))
        .toMatchObject({ payment_status: PaymentStatus.UNPAID, version: 3 });
      expect(sqlite.prepare("SELECT status FROM payment_session_attempts WHERE id = ?").get("psa_1"))
        .toMatchObject({ status: "created" });
    } finally {
      sqlite.close();
    }
  });
});
