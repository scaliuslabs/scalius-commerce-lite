import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { compileSqliteMigrationForProvider } from "@scalius/database/migration-artifacts";
import {
  orders,
  orderPayments,
  paymentPlans,
  OrderStatus,
  PaymentPlanStatus,
  PaymentRecordStatus,
  PaymentStatus,
} from "@scalius/database/schema";
import * as schema from "@scalius/database/schema";

const mocks = vi.hoisted(() => ({
  getCurrencyConfig: vi.fn(),
  applyInventoryForStatusChange: vi.fn(),
}));

vi.mock("../settings/settings.service", () => ({
  getCurrencyConfig: mocks.getCurrencyConfig,
}));

vi.mock("../inventory/inventory-transitions", () => ({
  applyInventoryForStatusChange: mocks.applyInventoryForStatusChange,
}));

import {
  processPaymentConfirmed,
  processPaymentFailed,
  releaseOrderInventory,
} from "./process-payment";

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

function createPaymentDatabase(beforeFirstBatch?: (sqlite: DatabaseSync) => void): {
  sqlite: DatabaseSync;
  db: Database;
} {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of readdirSync(migrationDirectory).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort()) {
    sqlite.exec(compileSqliteMigrationForProvider(readFileSync(`${migrationDirectory}/${name}`, "utf8"), "d1"));
  }
  let beforeBatch = beforeFirstBatch;
  const binding = {
    prepare: (query: string) => d1Statement(sqlite, query),
    async batch(statements: SqliteD1Statement[]) {
      if (beforeBatch) {
        const prepareRace = beforeBatch;
        beforeBatch = undefined;
        prepareRace(sqlite);
      }
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

async function insertPaymentTestOrder(
  db: Database,
  overrides: Partial<typeof orders.$inferInsert> = {},
) {
  await db.insert(orders).values({
    id: "order_1",
    customerName: "Buyer",
    customerPhone: "+8801711111111",
    shippingAddress: "Dhaka",
    city: "dhaka",
    zone: "zone_1",
    totalAmount: 100,
    shippingCharge: 0,
    balanceDue: 100,
    ...overrides,
  });
}

function createDbMock({
  selectGetResults,
  batchResults = [],
  insertError,
}: {
  selectGetResults: Array<Record<string, unknown> | null>;
  batchResults?: unknown[][];
  insertError?: unknown;
}) {
  const operations: string[] = [];
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const outboxClaimStatements: unknown[] = [];
  const batch = vi.fn(async () => batchResults.shift() ?? []);

  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                get: async () => selectGetResults.shift() ?? null,
              };
            },
          };
        },
      };
    },
    insert() {
      return {
        values: (values: Record<string, unknown>) => {
          operations.push("insert");
          inserts.push(values);
          const execution = insertError
            ? Promise.reject(insertError)
            : Promise.resolve(undefined);
          return {
            type: "insert-values",
            values,
            onConflictDoNothing: () => ({ type: "insert-values-on-conflict", values }),
            then: execution.then.bind(execution),
          };
        },
        select: (query: unknown) => ({
          type: "insert-select",
          query,
          onConflictDoNothing: () => {
            const statement = { type: "insert-select-on-conflict", query };
            outboxClaimStatements.push(statement);
            return statement;
          },
        }),
      };
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          operations.push("update");
          updates.push(values);
          return {
            where() {
              return {
                returning: () => ({ type: "returning-update" }),
              };
            },
          };
        },
      };
    },
    batch,
  };

  return { db, operations, inserts, updates, outboxClaimStatements, batch };
}

function createPaymentOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order_1",
    totalAmount: 100,
    paidAmount: 0,
    balanceDue: 100,
    paymentStatus: PaymentStatus.UNPAID,
    status: OrderStatus.PENDING,
    inventoryPool: "regular",
    version: 7,
    deletedAt: null,
    ...overrides,
  };
}

describe("payment processing idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getCurrencyConfig.mockResolvedValue({ code: "BDT" });
    mocks.applyInventoryForStatusChange.mockResolvedValue("restored");
  });

  it("promotes a failed gateway attempt when the same Stripe intent later succeeds", async () => {
    const { db, inserts, updates, outboxClaimStatements, batch } = createDbMock({
      selectGetResults: [
        { shipmentClaimId: null, shipmentClaimExpiresAt: null },
        { id: "pay_1", amount: 0, status: PaymentRecordStatus.FAILED },
        {
          id: "order_1",
          totalAmount: 100,
          paidAmount: 0,
          balanceDue: 100,
          paymentStatus: PaymentStatus.FAILED,
          status: OrderStatus.INCOMPLETE,
          inventoryPool: "regular",
          version: 7,
        },
      ],
      batchResults: [
        [[{ id: "order_1" }], [{ id: "pay_1" }]],
      ],
    });

    const result = await processPaymentConfirmed(db as never, {
      orderId: "order_1",
      paymentGateway: "stripe",
      paymentType: "full",
      stripePaymentIntentId: "pi_1",
      stripeChargeId: "ch_1",
      amount: 100,
      metadata: { currency: "bdt" },
    });

    expect(result).toEqual({ success: true });
    expect(inserts).toHaveLength(0);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(updates).toContainEqual(expect.objectContaining({
      status: OrderStatus.PENDING,
      paymentMethod: "stripe",
      paidAmount: 100,
      balanceDue: 0,
      paymentStatus: PaymentStatus.PAID,
    }));
    expect(updates).toContainEqual(expect.objectContaining({
      amount: 100,
      status: PaymentRecordStatus.SUCCEEDED,
      stripeChargeId: "ch_1",
      metadata: JSON.stringify({ currency: "bdt" }),
    }));
    expect(outboxClaimStatements).toHaveLength(1);
    const batchCalls = (batch as unknown as { mock: { calls: Array<[unknown[]]> } }).mock.calls;
    const firstBatch = batchCalls[0]?.[0];
    expect(firstBatch).toContain(outboxClaimStatements[0]);
  });

  it("applies SSLCommerz balance payments with a distinct val_id even when tran_id is reused", async () => {
    const { db, inserts, updates, outboxClaimStatements, batch } = createDbMock({
      selectGetResults: [
        { shipmentClaimId: null, shipmentClaimExpiresAt: null },
        null,
        createPaymentOrder({
          totalAmount: 100,
          paidAmount: 25,
          balanceDue: 75,
          paymentStatus: PaymentStatus.PARTIAL,
          status: OrderStatus.PENDING,
        }),
        {
          status: PaymentPlanStatus.DEPOSIT_PAID,
          balanceDue: 75,
        },
      ],
      batchResults: [
        [[{ id: "order_1" }], [{ id: "pay_balance" }], [{ id: "plan_1" }]],
      ],
    });

    const result = await processPaymentConfirmed(db as never, {
      orderId: "order_1",
      paymentGateway: "sslcommerz",
      paymentType: "balance",
      sslcommerzTranId: "order_1",
      sslcommerzValId: "val_balance",
      sslcommerzBankTranId: "bank_balance",
      amount: 75,
      metadata: { currency: "BDT" },
    });

    expect(result).toEqual({ success: true });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      orderId: "order_1",
      amount: 75,
      paymentType: "balance",
      sslcommerzTranId: "order_1",
    });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(updates).toContainEqual(expect.objectContaining({
      paymentMethod: "sslcommerz",
      paidAmount: 100,
      balanceDue: 0,
      paymentStatus: PaymentStatus.PAID,
    }));
    expect(updates).toContainEqual(expect.objectContaining({
      status: PaymentRecordStatus.SUCCEEDED,
      sslcommerzValId: "val_balance",
      sslcommerzBankTranId: "bank_balance",
    }));
    expect(updates).toContainEqual(expect.objectContaining({
      status: PaymentPlanStatus.COMPLETED,
    }));
    expect(outboxClaimStatements).toHaveLength(1);
  });

  it("applies a deposit payment only when the pending plan matches the incoming amount", async () => {
    const { db, inserts, updates, outboxClaimStatements, batch } = createDbMock({
      selectGetResults: [
        { shipmentClaimId: null, shipmentClaimExpiresAt: null },
        null,
        createPaymentOrder({
          totalAmount: 100,
          paidAmount: 0,
          balanceDue: 100,
          paymentStatus: PaymentStatus.UNPAID,
          status: OrderStatus.PENDING,
        }),
        {
          status: PaymentPlanStatus.PENDING,
          depositAmount: 50,
          balanceDue: 50,
        },
      ],
      batchResults: [
        [[{ id: "order_1" }], [{ id: "pay_deposit" }], [{ id: "plan_1" }]],
      ],
    });

    const result = await processPaymentConfirmed(db as never, {
      orderId: "order_1",
      paymentGateway: "sslcommerz",
      paymentType: "deposit",
      sslcommerzTranId: "order_1_deposit_ABC12345",
      sslcommerzValId: "val_deposit",
      sslcommerzBankTranId: "bank_deposit",
      amount: 50,
    });

    expect(result).toEqual({ success: true });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      orderId: "order_1",
      amount: 50,
      paymentType: "deposit",
      sslcommerzValId: "val_deposit",
    });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(updates).toContainEqual(expect.objectContaining({
      paidAmount: 50,
      balanceDue: 50,
      paymentStatus: PaymentStatus.PARTIAL,
    }));
    expect(updates).toContainEqual(expect.objectContaining({
      status: PaymentPlanStatus.DEPOSIT_PAID,
    }));
    expect(outboxClaimStatements).toHaveLength(1);
  });

  it("rejects balance confirmations before the deposit plan is marked paid", async () => {
    const { db, inserts, updates, batch } = createDbMock({
      selectGetResults: [
        { shipmentClaimId: null, shipmentClaimExpiresAt: null },
        null,
        createPaymentOrder({
          totalAmount: 100,
          paidAmount: 25,
          balanceDue: 75,
          paymentStatus: PaymentStatus.PARTIAL,
        }),
        {
          status: PaymentPlanStatus.PENDING,
          balanceDue: 75,
        },
      ],
    });

    const result = await processPaymentConfirmed(db as never, {
      orderId: "order_1",
      paymentGateway: "sslcommerz",
      paymentType: "balance",
      sslcommerzTranId: "order_1_balance_ABC12345",
      sslcommerzValId: "val_balance",
      amount: 75,
    });

    expect(result).toEqual({
      success: false,
      error: "Deposit payment must be confirmed before balance payment",
      retryable: false,
    });
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(batch).not.toHaveBeenCalled();
    expect(mocks.getCurrencyConfig).not.toHaveBeenCalled();
  });

  it("rejects repeated deposit confirmations after partial money has already been recorded", async () => {
    const { db, inserts, updates, batch } = createDbMock({
      selectGetResults: [
        { shipmentClaimId: null, shipmentClaimExpiresAt: null },
        null,
        createPaymentOrder({
          totalAmount: 100,
          paidAmount: 50,
          balanceDue: 50,
          paymentStatus: PaymentStatus.PARTIAL,
        }),
      ],
    });

    const result = await processPaymentConfirmed(db as never, {
      orderId: "order_1",
      paymentGateway: "sslcommerz",
      paymentType: "deposit",
      sslcommerzTranId: "order_1_deposit_RETRY",
      sslcommerzValId: "val_deposit_retry",
      amount: 50,
    });

    expect(result).toEqual({
      success: false,
      error: "Order already has a partial payment; use a balance payment",
      retryable: false,
    });
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(batch).not.toHaveBeenCalled();
    expect(mocks.getCurrencyConfig).not.toHaveBeenCalled();
  });

  it("rejects full-payment confirmations whose amount does not match the order total", async () => {
    const { db, inserts, updates, batch } = createDbMock({
      selectGetResults: [
        { shipmentClaimId: null, shipmentClaimExpiresAt: null },
        null,
        createPaymentOrder({ totalAmount: 100, paidAmount: 0, balanceDue: 100 }),
      ],
    });

    const result = await processPaymentConfirmed(db as never, {
      orderId: "order_1",
      paymentGateway: "stripe",
      paymentType: "full",
      stripePaymentIntentId: "pi_wrong_amount",
      amount: 90,
    });

    expect(result).toEqual({
      success: false,
      error: "Full payment amount must match the order total",
      retryable: false,
    });
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(batch).not.toHaveBeenCalled();
    expect(mocks.getCurrencyConfig).not.toHaveBeenCalled();
  });

  it("does not report success when the payment plan CAS loses after order and payment updates", async () => {
    const { db, inserts, batch } = createDbMock({
      selectGetResults: [
        { shipmentClaimId: null, shipmentClaimExpiresAt: null },
        null,
        createPaymentOrder({
          totalAmount: 100,
          paidAmount: 0,
          balanceDue: 100,
          paymentStatus: PaymentStatus.UNPAID,
        }),
        {
          status: PaymentPlanStatus.PENDING,
          depositAmount: 50,
          balanceDue: 50,
        },
      ],
      batchResults: [
        [[{ id: "order_1" }], [{ id: "pay_deposit" }], []],
      ],
    });

    const result = await processPaymentConfirmed(db as never, {
      orderId: "order_1",
      paymentGateway: "sslcommerz",
      paymentType: "deposit",
      sslcommerzTranId: "order_1_deposit_ABC12345",
      sslcommerzValId: "val_deposit",
      amount: 50,
    });

    expect(result).toEqual({
      success: false,
      error: "Payment plan changed concurrently; retry required",
    });
    expect(inserts).toHaveLength(1);
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("dedupes exact duplicate SSLCommerz confirmations by val_id", async () => {
    const { db, inserts, updates, batch } = createDbMock({
      selectGetResults: [
        { shipmentClaimId: null, shipmentClaimExpiresAt: null },
        { id: "pay_1", amount: 50, status: PaymentRecordStatus.SUCCEEDED },
      ],
    });

    const result = await processPaymentConfirmed(db as never, {
      orderId: "order_1",
      paymentGateway: "sslcommerz",
      paymentType: "deposit",
      sslcommerzTranId: "order_1",
      sslcommerzValId: "val_deposit",
      sslcommerzBankTranId: "bank_deposit",
      amount: 50,
    });

    expect(result).toEqual({ success: true, alreadyProcessed: true });
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(batch).not.toHaveBeenCalled();
    expect(mocks.getCurrencyConfig).not.toHaveBeenCalled();
  });

  it("does not rewrite duplicate failed gateway attempts", async () => {
    const { db, inserts, updates, batch } = createDbMock({
      selectGetResults: [
        { id: "pay_1", status: PaymentRecordStatus.FAILED, paymentType: "full" },
        {
          paidAmount: 0,
          paymentStatus: PaymentStatus.FAILED,
          shipmentClaimId: null,
          shipmentClaimExpiresAt: null,
        },
      ],
    });

    await processPaymentFailed(db as never, "order_1", "stripe", "pi_1");

    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(batch).not.toHaveBeenCalled();
    expect(mocks.getCurrencyConfig).not.toHaveBeenCalled();
  });

  it("records a new failed attempt and the unpaid order failure in one atomic batch", async () => {
    const { db, operations, inserts, updates, batch } = createDbMock({
      selectGetResults: [
        null,
        {
          paidAmount: 0,
          paymentStatus: PaymentStatus.UNPAID,
          shipmentClaimId: null,
          shipmentClaimExpiresAt: null,
          paymentPlanStatus: null,
        },
      ],
    });

    await processPaymentFailed(db as never, "order_1", "sslcommerz", "tran_1");

    expect(operations).toEqual(["update", "insert"]);
    expect(batch).toHaveBeenCalledTimes(1);
    const batchCalls = (batch as unknown as { mock: { calls: Array<[unknown[]]> } }).mock.calls;
    expect(batchCalls[0]?.[0]).toHaveLength(3);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      orderId: "order_1",
      amount: 0,
      paymentType: "full",
      status: PaymentRecordStatus.FAILED,
      sslcommerzTranId: "tran_1",
    });
    expect(updates).toContainEqual(expect.objectContaining({
      paymentStatus: PaymentStatus.FAILED,
    }));
  });

  it("atomically converges a pending attempt and its unpaid order to failed", async () => {
    const { db, inserts, updates, batch } = createDbMock({
      selectGetResults: [
        { id: "pay_1", status: PaymentRecordStatus.PENDING, paymentType: "deposit" },
        {
          paidAmount: 0,
          paymentStatus: PaymentStatus.UNPAID,
          shipmentClaimId: null,
          shipmentClaimExpiresAt: null,
          paymentPlanStatus: PaymentPlanStatus.PENDING,
        },
      ],
    });

    await processPaymentFailed(db as never, "order_1", "stripe", "pi_1");

    expect(inserts).toHaveLength(0);
    expect(updates).toContainEqual(expect.objectContaining({
      paymentStatus: PaymentStatus.FAILED,
    }));
    expect(updates).toContainEqual(expect.objectContaining({
      status: PaymentRecordStatus.FAILED,
    }));
    expect(batch).toHaveBeenCalledTimes(1);
    const batchCalls = (batch as unknown as { mock: { calls: Array<[unknown[]]> } }).mock.calls;
    expect(batchCalls[0]?.[0]).toHaveLength(3);
  });

  it("does not require order currency repair to finish an existing pending failure", async () => {
    const { db, batch } = createDbMock({
      selectGetResults: [
        { id: "pay_1", status: PaymentRecordStatus.PENDING, paymentType: "full" },
        {
          paidAmount: 0,
          paymentStatus: PaymentStatus.UNPAID,
          shipmentClaimId: null,
          shipmentClaimExpiresAt: null,
          currencyCode: "invalid",
          currencyDecimalPlaces: 2,
          paymentPlanStatus: null,
        },
      ],
    });

    await expect(processPaymentFailed(db as never, "order_1", "stripe", "pi_1"))
      .resolves.toBeUndefined();
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("records a balance failure without downgrading a partially paid order", async () => {
    const { db, inserts, batch } = createDbMock({
      selectGetResults: [
        null,
        {
          paidAmount: 25,
          paymentStatus: PaymentStatus.PARTIAL,
          shipmentClaimId: null,
          shipmentClaimExpiresAt: null,
          paymentPlanStatus: PaymentPlanStatus.DEPOSIT_PAID,
        },
      ],
    });

    await processPaymentFailed(db as never, "order_1", "polar", "checkout_balance");

    expect(inserts).toContainEqual(expect.objectContaining({
      orderId: "order_1",
      paymentType: "balance",
      status: PaymentRecordStatus.FAILED,
      polarCheckoutId: "checkout_balance",
    }));
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("finishes stale failed-attempt bookkeeping when the order is still unpaid", async () => {
    const { db, inserts, updates, batch } = createDbMock({
      selectGetResults: [
        { id: "pay_1", status: PaymentRecordStatus.FAILED, paymentType: "full" },
        {
          paidAmount: 0,
          paymentStatus: PaymentStatus.UNPAID,
          shipmentClaimId: null,
          shipmentClaimExpiresAt: null,
          paymentPlanStatus: null,
        },
      ],
    });

    await processPaymentFailed(db as never, "order_1", "stripe", "pi_1");

    expect(inserts).toHaveLength(0);
    expect(updates).toContainEqual(expect.objectContaining({
      paymentStatus: PaymentStatus.FAILED,
    }));
    expect(batch).toHaveBeenCalledTimes(1);
    const batchCalls = (batch as unknown as { mock: { calls: Array<[unknown[]]> } }).mock.calls;
    expect(batchCalls[0]?.[0]).toHaveLength(2);
  });

  it("does not downgrade a gateway attempt that has already succeeded", async () => {
    const { db, inserts, updates, batch } = createDbMock({
      selectGetResults: [
        { id: "pay_1", status: PaymentRecordStatus.SUCCEEDED, paymentType: "full" },
      ],
    });

    await processPaymentFailed(db as never, "order_1", "stripe", "pi_1");

    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(batch).not.toHaveBeenCalled();
  });

  it("uses the centralized inventory transition for payment cancellation releases", async () => {
    const { db } = createDbMock({
      selectGetResults: [
        { shipmentClaimId: null, shipmentClaimExpiresAt: null },
      ],
    });

    await releaseOrderInventory(db as never, "order_1");

    expect(mocks.applyInventoryForStatusChange).toHaveBeenCalledWith(
      db,
      "order_1",
      OrderStatus.CANCELLED,
    );
  });

  it("returns retryable failure before claiming a confirmed payment while shipment creation is active", async () => {
    const { db, inserts, updates, batch } = createDbMock({
      selectGetResults: [
        { shipmentClaimId: "shp_active", shipmentClaimExpiresAt: new Date(Date.now() + 60_000) },
      ],
    });

    const result = await processPaymentConfirmed(db as never, {
      orderId: "order_1",
      paymentGateway: "stripe",
      paymentType: "full",
      stripePaymentIntentId: "pi_1",
      amount: 100,
    });

    expect(result).toEqual({
      success: false,
      error: "Order has an active shipment creation in progress. Please retry shortly.",
    });
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(batch).not.toHaveBeenCalled();
    expect(mocks.getCurrencyConfig).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "cancelled order",
      order: createPaymentOrder({ status: OrderStatus.CANCELLED }),
      error: "Cannot pay a cancelled order",
    },
    {
      label: "returned order",
      order: createPaymentOrder({ status: OrderStatus.RETURNED }),
      error: "Cannot pay a returned order",
    },
    {
      label: "refunded order",
      order: createPaymentOrder({ status: OrderStatus.REFUNDED }),
      error: "Cannot pay a refunded order",
    },
    {
      label: "partially refunded order",
      order: createPaymentOrder({ status: OrderStatus.PARTIALLY_REFUNDED }),
      error: "Cannot pay a partially refunded order",
    },
    {
      label: "soft-deleted order",
      order: createPaymentOrder({ deletedAt: new Date("2026-01-01T00:00:00Z") }),
      error: "Cannot pay a deleted order",
    },
    {
      label: "refunded payment status",
      order: createPaymentOrder({ paymentStatus: PaymentStatus.REFUNDED }),
      error: "Cannot pay an order whose payment has already been refunded",
    },
  ])("rejects confirmed payment for $label before claiming the payment", async ({ order, error }) => {
    const { db, inserts, updates, batch } = createDbMock({
      selectGetResults: [
        { shipmentClaimId: null, shipmentClaimExpiresAt: null },
        null,
        order,
      ],
    });

    const result = await processPaymentConfirmed(db as never, {
      orderId: "order_1",
      paymentGateway: "stripe",
      paymentType: "full",
      stripePaymentIntentId: "pi_late",
      amount: 100,
    });

    expect(result).toEqual({ success: false, error, retryable: false });
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(batch).not.toHaveBeenCalled();
    expect(mocks.getCurrencyConfig).not.toHaveBeenCalled();
  });

  it("does not promote a pending gateway record after an order becomes terminal", async () => {
    const { db, inserts, updates, batch } = createDbMock({
      selectGetResults: [
        { shipmentClaimId: null, shipmentClaimExpiresAt: null },
        { id: "pay_1", amount: 100, status: PaymentRecordStatus.PENDING },
        createPaymentOrder({ status: OrderStatus.CANCELLED }),
      ],
    });

    const result = await processPaymentConfirmed(db as never, {
      orderId: "order_1",
      paymentGateway: "stripe",
      paymentType: "full",
      stripePaymentIntentId: "pi_late",
      amount: 100,
    });

    expect(result).toEqual({
      success: false,
      error: "Cannot pay a cancelled order",
      retryable: false,
    });
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(batch).not.toHaveBeenCalled();
    expect(mocks.getCurrencyConfig).not.toHaveBeenCalled();
  });

  it("throws before recording failed payment state while shipment creation is active", async () => {
    const { db, inserts, updates } = createDbMock({
      selectGetResults: [
        null,
        {
          paidAmount: 0,
          paymentStatus: PaymentStatus.UNPAID,
          shipmentClaimId: "shp_active",
          shipmentClaimExpiresAt: new Date(Date.now() + 60_000),
        },
      ],
    });

    await expect(processPaymentFailed(db as never, "order_1", "stripe", "pi_1"))
      .rejects.toThrow("active shipment creation");

    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(mocks.getCurrencyConfig).not.toHaveBeenCalled();
  });

  it("throws before releasing cancellation inventory while shipment creation is active", async () => {
    const { db } = createDbMock({
      selectGetResults: [
        { shipmentClaimId: "shp_active", shipmentClaimExpiresAt: new Date(Date.now() + 60_000) },
      ],
    });

    await expect(releaseOrderInventory(db as never, "order_1"))
      .rejects.toThrow("active shipment creation");

    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });

  it("applies a JPY full payment at the immutable zero-decimal precision", async () => {
    const { db, inserts, updates } = createDbMock({
      selectGetResults: [
        {
          id: "order_jpy",
          shipmentClaimId: null,
          shipmentClaimExpiresAt: null,
          currencyCode: "JPY",
          currencyDecimalPlaces: 0,
        },
        createPaymentOrder({
          id: "order_jpy",
          totalAmount: 100.49,
          balanceDue: 100.49,
          currencyCode: "JPY",
          currencyDecimalPlaces: 0,
        }),
      ],
      batchResults: [[[{ id: "order_jpy" }], [{ id: "pay_jpy" }]]],
    });

    await expect(processPaymentConfirmed(db as never, {
      orderId: "order_jpy",
      paymentGateway: "stripe",
      paymentType: "full",
      amount: 100.49,
      metadata: { currency: "jpy" },
    })).resolves.toEqual({ success: true });

    expect(inserts).toContainEqual(expect.objectContaining({ amount: 100, currency: "JPY" }));
    expect(updates).toContainEqual(expect.objectContaining({
      paidAmount: 100,
      balanceDue: 0,
      paymentStatus: PaymentStatus.PAID,
    }));
  });

  it("applies a KWD deposit and balance at three-decimal precision", async () => {
    const { db, updates } = createDbMock({
      selectGetResults: [
        {
          id: "order_kwd",
          shipmentClaimId: null,
          shipmentClaimExpiresAt: null,
          currencyCode: "KWD",
          currencyDecimalPlaces: 3,
        },
        createPaymentOrder({
          id: "order_kwd",
          totalAmount: 2.469,
          balanceDue: 2.469,
          currencyCode: "KWD",
          currencyDecimalPlaces: 3,
        }),
        {
          status: PaymentPlanStatus.PENDING,
          depositAmount: 1.235,
          balanceDue: 1.234,
        },
      ],
      batchResults: [[[{ id: "order_kwd" }], [{ id: "pay_kwd" }], [{ id: "plan_kwd" }]]],
    });

    await expect(processPaymentConfirmed(db as never, {
      orderId: "order_kwd",
      paymentGateway: "stripe",
      paymentType: "deposit",
      amount: 1.2346,
      metadata: { currency: "KWD" },
    })).resolves.toEqual({ success: true });

    expect(updates).toContainEqual(expect.objectContaining({
      paidAmount: 1.235,
      balanceDue: 1.234,
      paymentStatus: PaymentStatus.PARTIAL,
    }));
  });

  it("fails closed when provider currency differs from the immutable order snapshot", async () => {
    const { db, batch } = createDbMock({
      selectGetResults: [{
        id: "order_kwd",
        shipmentClaimId: null,
        shipmentClaimExpiresAt: null,
        currencyCode: "KWD",
        currencyDecimalPlaces: 3,
      }],
    });

    await expect(processPaymentConfirmed(db as never, {
      orderId: "order_kwd",
      paymentGateway: "sslcommerz",
      paymentType: "full",
      amount: 1.235,
      metadata: { currency: "BDT" },
    })).resolves.toMatchObject({ success: false, error: expect.stringContaining("currency does not match") });
    expect(batch).not.toHaveBeenCalled();
  });
});

describe("failed payment database transitions", () => {
  it("durably converges a pending deposit attempt and its unpaid order", async () => {
    const { sqlite, db } = createPaymentDatabase();
    try {
      await insertPaymentTestOrder(db, {
        version: 3,
        currencyCode: "BDT",
        currencyDecimalPlaces: 2,
      });
      await db.insert(paymentPlans).values({
        id: "plan_1",
        orderId: "order_1",
        totalAmount: 100,
        depositAmount: 25,
        balanceDue: 75,
        status: PaymentPlanStatus.PENDING,
      });
      await db.insert(orderPayments).values({
        id: "pay_1",
        orderId: "order_1",
        amount: 0,
        currency: "BDT",
        paymentMethod: "stripe",
        paymentType: "deposit",
        status: PaymentRecordStatus.PENDING,
        stripePaymentIntentId: "pi_deposit",
      });

      await processPaymentFailed(db, "order_1", "stripe", "pi_deposit");

      expect(sqlite.prepare(`
        SELECT payment_status, paid_amount, balance_due, version
        FROM orders
        WHERE id = ?
      `).get("order_1")).toMatchObject({
        payment_status: PaymentStatus.FAILED,
        paid_amount: 0,
        balance_due: 100,
        version: 4,
      });
      expect(sqlite.prepare(`
        SELECT status, payment_type
        FROM order_payments
        WHERE id = ?
      `).get("pay_1")).toMatchObject({
        status: PaymentRecordStatus.FAILED,
        payment_type: "deposit",
      });
    } finally {
      sqlite.close();
    }
  });

  it("records a balance failure without changing partial-payment truth", async () => {
    const { sqlite, db } = createPaymentDatabase();
    try {
      await insertPaymentTestOrder(db, {
        paidAmount: 25,
        balanceDue: 75,
        paymentStatus: PaymentStatus.PARTIAL,
        version: 5,
        currencyCode: "BDT",
        currencyDecimalPlaces: 2,
      });
      await db.insert(paymentPlans).values({
        id: "plan_1",
        orderId: "order_1",
        totalAmount: 100,
        depositAmount: 25,
        balanceDue: 75,
        status: PaymentPlanStatus.DEPOSIT_PAID,
      });

      await processPaymentFailed(db, "order_1", "polar", "checkout_balance");

      expect(sqlite.prepare(`
        SELECT payment_status, paid_amount, balance_due, version
        FROM orders
        WHERE id = ?
      `).get("order_1")).toMatchObject({
        payment_status: PaymentStatus.PARTIAL,
        paid_amount: 25,
        balance_due: 75,
        version: 5,
      });
      expect(sqlite.prepare(`
        SELECT status, payment_type, polar_checkout_id
        FROM order_payments
        WHERE order_id = ?
      `).get("order_1")).toMatchObject({
        status: PaymentRecordStatus.FAILED,
        payment_type: "balance",
        polar_checkout_id: "checkout_balance",
      });
    } finally {
      sqlite.close();
    }
  });

  it("does not let a late failure overwrite success committed before its batch", async () => {
    const { sqlite, db } = createPaymentDatabase((raceDatabase) => {
      raceDatabase.prepare(`
        UPDATE order_payments
        SET status = ?, amount = 100
        WHERE id = ?
      `).run(PaymentRecordStatus.SUCCEEDED, "pay_1");
      raceDatabase.prepare(`
        UPDATE orders
        SET payment_status = ?, paid_amount = 100, balance_due = 0, version = version + 1
        WHERE id = ?
      `).run(PaymentStatus.PAID, "order_1");
    });
    try {
      await insertPaymentTestOrder(db, {
        version: 7,
        currencyCode: "BDT",
        currencyDecimalPlaces: 2,
      });
      await db.insert(orderPayments).values({
        id: "pay_1",
        orderId: "order_1",
        amount: 0,
        currency: "BDT",
        paymentMethod: "stripe",
        paymentType: "full",
        status: PaymentRecordStatus.PENDING,
        stripePaymentIntentId: "pi_race",
      });

      await processPaymentFailed(db, "order_1", "stripe", "pi_race");

      expect(sqlite.prepare(`
        SELECT payment_status, paid_amount, balance_due, version
        FROM orders
        WHERE id = ?
      `).get("order_1")).toMatchObject({
        payment_status: PaymentStatus.PAID,
        paid_amount: 100,
        balance_due: 0,
        version: 8,
      });
      expect(sqlite.prepare(`
        SELECT status, amount
        FROM order_payments
        WHERE id = ?
      `).get("pay_1")).toMatchObject({
        status: PaymentRecordStatus.SUCCEEDED,
        amount: 100,
      });
    } finally {
      sqlite.close();
    }
  });
});
