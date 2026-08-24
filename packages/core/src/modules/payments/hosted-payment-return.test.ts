import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import {
  createTursoDatabase,
  type Database,
} from "@scalius/database/client";
import { compileSqliteMigrationForProvider } from "@scalius/database/migration-artifacts";
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
import * as schema from "@scalius/database/schema";

import { reconcileHostedPaymentReturn } from "./hosted-payment-return";
import { processPaymentConfirmed } from "./process-payment";

const POLAR_RETURN_NONCE = `hpr_${"a".repeat(64)}`;

const migrationDirectory = fileURLToPath(new URL(
  "../../../../database/migrations/",
  import.meta.url,
));

interface SqliteD1Result {
  results: Record<string, SQLOutputValue>[];
  success: true;
  meta: Record<string, never>;
}

interface SqliteD1Statement {
  bind(...values: SQLInputValue[]): SqliteD1Statement;
  run(): Promise<SqliteD1Result>;
  all(): Promise<SqliteD1Result>;
  raw(): Promise<SQLOutputValue[][]>;
  first(column?: string): Promise<unknown>;
  execute(): SqliteD1Result;
}

function statementRows(statement: StatementSync, values: SQLInputValue[]) {
  return statement.all(...values) as Record<string, SQLOutputValue>[];
}

function d1Statement(
  sqlite: DatabaseSync,
  query: string,
  values: SQLInputValue[] = [],
): SqliteD1Statement {
  const execute = (): SqliteD1Result => ({
    results: statementRows(sqlite.prepare(query), values),
    success: true,
    meta: {},
  });
  return {
    bind: (...nextValues) => d1Statement(sqlite, query, nextValues),
    run: async () => execute(),
    all: async () => execute(),
    raw: async () => {
      const statement = sqlite.prepare(query);
      statement.setReturnArrays(true);
      return statement.all(...values) as unknown as SQLOutputValue[][];
    },
    first: async (column) => {
      const row = statementRows(sqlite.prepare(query), values)[0];
      return column ? row?.[column] ?? null : row ?? null;
    },
    execute,
  };
}

function createPaymentDatabase(): { sqlite: DatabaseSync; db: Database } {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of readdirSync(migrationDirectory).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort()) {
    sqlite.exec(compileSqliteMigrationForProvider(readFileSync(`${migrationDirectory}/${name}`, "utf8"), "d1"));
  }
  const binding = {
    prepare: (query: string) => d1Statement(sqlite, query),
    async batch(statements: SqliteD1Statement[]) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return {
    sqlite,
    db: drizzle(binding as unknown as D1Database, { schema }) as unknown as Database,
  };
}

function createTursoPaymentDatabase(): { sqlite: DatabaseSync; db: Database } {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of readdirSync(migrationDirectory).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort()) {
    sqlite.exec(compileSqliteMigrationForProvider(readFileSync(`${migrationDirectory}/${name}`, "utf8"), "turso"));
  }
  const db = createTursoDatabase(
    { url: "turso://hosted-return-conformance.turso.io", authToken: "test" },
    {
      connect: () => ({
        async batch(statements, options) {
          const transactional = options?.mode !== undefined;
          if (transactional) sqlite.exec("BEGIN IMMEDIATE");
          try {
            const results = statements.map((statement) => {
              const sqlText = typeof statement === "string" ? statement : statement.sql;
              const args = typeof statement === "string" || statement.args === undefined
                ? []
                : statement.args;
              if (!Array.isArray(args)) throw new Error("Positional arguments are required.");
              const prepared = sqlite.prepare(sqlText);
              if (prepared.columns().length === 0) {
                const result = prepared.run(...args as SQLInputValue[]);
                return { rows: [], rowsAffected: Number(result.changes) };
              }
              prepared.setReturnArrays(true);
              return {
                rows: prepared.all(...args as SQLInputValue[]) as unknown as SQLOutputValue[][],
                rowsAffected: 0,
              };
            });
            if (transactional) sqlite.exec("COMMIT");
            return results;
          } catch (error) {
            if (transactional && sqlite.isTransaction) sqlite.exec("ROLLBACK");
            throw error;
          }
        },
      }),
      writeBatchMode: "concurrent",
    },
  );
  return { sqlite, db };
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
    totalAmount: 100,
    shippingCharge: 0,
    status: OrderStatus.INCOMPLETE,
    paymentMethod: "sslcommerz",
    paymentStatus: PaymentStatus.UNPAID,
    paidAmount: 0,
    balanceDue: 100,
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
    amount: 100,
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
        SELECT payment_status, paid_amount, version
        FROM orders WHERE id = ?
      `).get("order_1")).toMatchObject({
        payment_status: PaymentStatus.FAILED,
        paid_amount: 0,
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

  it("makes a Polar cancel retryable without creating a second order or payment row", async () => {
    const { sqlite, db } = createPaymentDatabase();
    try {
      await insertHostedOrder(db, {
        paymentMethod: "polar",
        paymentIntentId: "checkout_1",
      });
      await insertHostedAttempt(db, {
        attemptKey: "payment_session:polar:attempt_1",
        gateway: "polar",
        providerSessionId: "checkout_1",
        providerCorrelationId: POLAR_RETURN_NONCE,
      });

      await expect(reconcileHostedPaymentReturn(db, {
        orderId: "order_1",
        gateway: "polar",
        paymentType: "full",
        result: "cancelled",
        providerCorrelationId: POLAR_RETURN_NONCE,
      })).resolves.toBe("retry_ready");

      expect(sqlite.prepare("SELECT count(*) AS count FROM orders").get()).toMatchObject({ count: 1 });
      expect(sqlite.prepare("SELECT count(*) AS count FROM order_payments").get()).toMatchObject({ count: 0 });
      expect(sqlite.prepare("SELECT payment_status, payment_intent_id, version FROM orders WHERE id = ?").get("order_1"))
        .toMatchObject({
          payment_status: PaymentStatus.FAILED,
          payment_intent_id: "checkout_1",
          version: 4,
        });
      expect(sqlite.prepare("SELECT status FROM payment_session_attempts WHERE id = ?").get("psa_1"))
        .toMatchObject({ status: "failed" });
    } finally {
      sqlite.close();
    }
  });

  it("ignores a Polar cancel nonce that does not match the stored attempt", async () => {
    const { sqlite, db } = createPaymentDatabase();
    try {
      await insertHostedOrder(db, { paymentMethod: "polar" });
      await insertHostedAttempt(db, {
        attemptKey: "payment_session:polar:attempt_1",
        gateway: "polar",
        providerSessionId: "checkout_1",
        providerCorrelationId: POLAR_RETURN_NONCE,
      });

      await expect(reconcileHostedPaymentReturn(db, {
        orderId: "order_1",
        gateway: "polar",
        paymentType: "full",
        result: "cancelled",
        providerCorrelationId: `hpr_${"b".repeat(64)}`,
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
        paidAmount: 25,
        balanceDue: 75,
        version: 5,
      });
      await db.insert(paymentPlans).values({
        id: "plan_1",
        orderId: "order_1",
        totalAmount: 100,
        depositAmount: 25,
        balanceDue: 75,
        status: PaymentPlanStatus.DEPOSIT_PAID,
      });
      await db.insert(orderPayments).values({
        id: "pay_deposit",
        orderId: "order_1",
        amount: 25,
        currency: "BDT",
        paymentMethod: "sslcommerz",
        paymentType: "deposit",
        status: PaymentRecordStatus.SUCCEEDED,
        sslcommerzTranId: "order_1_deposit_DEPOSIT1",
        sslcommerzValId: "val_deposit",
      });
      await insertHostedAttempt(db, {
        attemptKey: "payment_session:sslcommerz:balance_attempt",
        paymentType: "balance",
        amount: 75,
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
        SELECT status, payment_status, paid_amount, balance_due, version
        FROM orders WHERE id = ?
      `).get("order_1")).toMatchObject({
        status: OrderStatus.PENDING,
        payment_status: PaymentStatus.PARTIAL,
        paid_amount: 25,
        balance_due: 75,
        version: 6,
      });
      expect(sqlite.prepare("SELECT status FROM payment_session_attempts WHERE id = ?").get("psa_1"))
        .toMatchObject({ status: "failed" });
      expect(sqlite.prepare("SELECT status, amount FROM order_payments WHERE id = ?").get("pay_deposit"))
        .toMatchObject({ status: PaymentRecordStatus.SUCCEEDED, amount: 25 });

      await expect(reconcileHostedPaymentReturn(db, input)).resolves.toBe("retry_ready");
      expect(sqlite.prepare("SELECT version FROM orders WHERE id = ?").get("order_1"))
        .toMatchObject({ version: 6 });

      await expect(processPaymentConfirmed(db, {
        orderId: "order_1",
        paymentGateway: "sslcommerz",
        paymentType: "balance",
        sslcommerzTranId: "order_1_balance_BALANCE1",
        sslcommerzValId: "val_balance",
        sslcommerzBankTranId: "bank_balance",
        amount: 75,
        metadata: { currency: "BDT" },
      })).resolves.toMatchObject({ success: true });
      expect(sqlite.prepare(`
        SELECT payment_status, paid_amount, balance_due
        FROM orders WHERE id = ?
      `).get("order_1")).toMatchObject({
        payment_status: PaymentStatus.PAID,
        paid_amount: 100,
        balance_due: 0,
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
        paymentGateway: "sslcommerz" as const,
        paymentType: "full" as const,
        sslcommerzTranId: "order_1_full_ABC12345",
        sslcommerzValId: "val_1",
        sslcommerzBankTranId: "bank_1",
        amount: 100,
        metadata: { currency: "BDT" },
      },
    },
    {
      gateway: "polar" as const,
      paymentMethod: "polar",
      attemptKey: "payment_session:polar:attempt_1",
      providerSessionId: "checkout_1",
      providerCorrelationId: POLAR_RETURN_NONCE,
      confirmation: {
        orderId: "order_1",
        paymentGateway: "polar" as const,
        paymentType: "full" as const,
        polarCheckoutId: "checkout_1",
        amount: 100,
        metadata: { currency: "BDT" },
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
        result: gateway === "polar" ? "cancelled" : "failed",
        providerCorrelationId,
      });

      await expect(processPaymentConfirmed(db, confirmation)).resolves.toMatchObject({ success: true });

      expect(sqlite.prepare(`
        SELECT status, payment_status, paid_amount, balance_due
        FROM orders WHERE id = ?
      `).get("order_1")).toMatchObject({
        status: OrderStatus.PENDING,
        payment_status: PaymentStatus.PAID,
        paid_amount: 100,
        balance_due: 0,
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
        result: gateway === "polar" ? "cancelled" : "failed",
        providerCorrelationId,
      })).resolves.toBe("retry_suppressed");
    } finally {
      sqlite.close();
    }
  });

  it("suppresses a cancel while a provider success payment row is already in flight", async () => {
    const { sqlite, db } = createPaymentDatabase();
    try {
      await insertHostedOrder(db, { paymentMethod: "polar" });
      await insertHostedAttempt(db, {
        attemptKey: "payment_session:polar:attempt_1",
        gateway: "polar",
        providerSessionId: "checkout_1",
        providerCorrelationId: POLAR_RETURN_NONCE,
      });
      await db.insert(orderPayments).values({
        id: "pay_pending",
        orderId: "order_1",
        amount: 100,
        currency: "BDT",
        paymentMethod: "polar",
        paymentType: "full",
        status: PaymentRecordStatus.PENDING,
        polarCheckoutId: "checkout_1",
      });

      await expect(reconcileHostedPaymentReturn(db, {
        orderId: "order_1",
        gateway: "polar",
        paymentType: "full",
        result: "cancelled",
        providerCorrelationId: POLAR_RETURN_NONCE,
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
