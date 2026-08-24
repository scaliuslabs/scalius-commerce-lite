import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
} from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "@scalius/core/errors";
import type { Database } from "@scalius/database/client";
import { compileSqliteMigrationForProvider } from "@scalius/database/migration-artifacts";
import * as databaseSchema from "@scalius/database/schema";
import {
  codTracking,
  CodStatus,
  orders,
  orderPayments,
  paymentPlans,
  PaymentMethod,
  PaymentPlanStatus,
  PaymentRecordStatus,
  PaymentStatus,
} from "@scalius/database/schema";
import { markCODReturned, recordCODCollection, validateCODCollectionDetails } from "./cod";

function createCodDbMock({
  selectedOrder,
  selectedPayment = null,
  selectedPlan = null,
  selectedTracking = null,
  updateResults = [{ id: "cod_1" }],
}: {
  selectedOrder: Record<string, unknown> | null;
  selectedPayment?: Record<string, unknown> | null;
  selectedPlan?: Record<string, unknown> | null;
  selectedTracking?: Record<string, unknown> | null;
  updateResults?: Array<{ id: string }>;
}) {
  const updates: Array<Record<string, unknown>> = [];
  const inserts: Array<Record<string, unknown>> = [];
  const batches: unknown[][] = [];
  const db = {
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              return {
                get: async () => {
                  if (table === orders) return selectedOrder;
                  if (table === orderPayments) return selectedPayment;
                  if (table === paymentPlans) return selectedPlan;
                  if (table === codTracking) return selectedTracking;
                  return null;
                },
              };
            },
          };
        },
      };
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          updates.push(values);
          return {
            where() {
              return {
                returning: async () => updateResults,
              };
            },
          };
        },
      };
    },
    insert() {
      return {
        values(values: Record<string, unknown>) {
          inserts.push(values);
          const statement = {
            values,
            onConflictDoNothing() {
              return statement;
            },
          };
          return statement;
        },
      };
    },
    batch: vi.fn(async (statements: unknown[]) => {
      batches.push(statements);
      return statements;
    }),
  };

  return { db, batches, inserts, updates };
}

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

function d1Statement(
  sqlite: DatabaseSync,
  query: string,
  values: SQLInputValue[] = [],
): SqliteD1Statement {
  const execute = (): SqliteD1Result => ({
    results: sqlite.prepare(query).all(...values) as Record<string, SQLOutputValue>[],
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
      const row = sqlite.prepare(query).get(...values) as Record<string, SQLOutputValue> | undefined;
      return column ? row?.[column] ?? null : row ?? null;
    },
    execute,
  };
}

function createCodIntegrationDatabase(
  beforeFirstBatch?: (sqlite: DatabaseSync) => void,
): { sqlite: DatabaseSync; db: Database } {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of readdirSync(migrationDirectory).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort()) {
    sqlite.exec(compileSqliteMigrationForProvider(readFileSync(`${migrationDirectory}/${name}`, "utf8"), "d1"));
  }
  let beforeBatch = beforeFirstBatch;
  const binding = {
    prepare: (query: string) => d1Statement(sqlite, query),
    async batch(statements: SqliteD1Statement[]) {
      if (beforeBatch) {
        const applyRace = beforeBatch;
        beforeBatch = undefined;
        applyRace(sqlite);
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
    db: drizzle(binding as unknown as D1Database, { schema: databaseSchema }) as unknown as Database,
  };
}

async function insertAdvancePaymentOrder(db: Database, orderId: string): Promise<void> {
  await db.insert(orders).values({
    id: orderId,
    customerName: "Buyer",
    customerPhone: "+8801711111111",
    shippingAddress: "Dhaka",
    city: "dhaka",
    zone: "zone_1",
    totalAmount: 2500,
    shippingCharge: 0,
    paidAmount: 500,
    balanceDue: 2000,
    paymentMethod: PaymentMethod.SSLCOMMERZ,
    paymentStatus: PaymentStatus.PARTIAL,
    version: 1,
  });
  await db.insert(paymentPlans).values({
    id: `plan_${orderId}`,
    orderId,
    totalAmount: 2500,
    depositAmount: 500,
    balanceDue: 2000,
    status: PaymentPlanStatus.DEPOSIT_PAID,
  });
}

describe("validateCODCollectionDetails", () => {
  const order = {
    totalAmount: 2500,
    paidAmount: 0,
    balanceDue: 2500,
  };

  it("accepts exact outstanding COD collection amounts", () => {
    expect(
      validateCODCollectionDetails(order, {
        collectedBy: "Courier A",
        collectedAmount: 2500,
      }),
    ).toMatchObject({
      collectedBy: "Courier A",
      collectedAmount: 2500,
      expectedAmount: 2500,
      newPaidAmount: 2500,
      newBalanceDue: 0,
    });
  });

  it("uses the outstanding balance for partially paid COD orders", () => {
    expect(
      validateCODCollectionDetails(
        {
          totalAmount: 2500,
          paidAmount: 500,
          balanceDue: 2000,
        },
        {
          collectedBy: "Courier A",
          collectedAmount: 2000,
        },
      ),
    ).toMatchObject({
      expectedAmount: 2000,
      newPaidAmount: 2500,
      newBalanceDue: 0,
    });
  });

  it("uses computed balance when stored balance due is stale", () => {
    expect(
      validateCODCollectionDetails(
        {
          totalAmount: 2500,
          paidAmount: 0,
          balanceDue: 0,
        },
        {
          collectedBy: "Courier A",
          collectedAmount: 2500,
        },
      ),
    ).toMatchObject({
      expectedAmount: 2500,
      newPaidAmount: 2500,
      newBalanceDue: 0,
    });
  });

  it("rejects missing collectors before any order mutation", () => {
    expect(() =>
      validateCODCollectionDetails(order, {
        collectedBy: "   ",
        collectedAmount: 2500,
      }),
    ).toThrow(ValidationError);
  });

  it("rejects non-positive or non-finite collection amounts", () => {
    expect(() =>
      validateCODCollectionDetails(order, {
        collectedBy: "Courier A",
        collectedAmount: 0,
      }),
    ).toThrow(ValidationError);

    expect(() =>
      validateCODCollectionDetails(order, {
        collectedBy: "Courier A",
        collectedAmount: Number.NaN,
      }),
    ).toThrow(ValidationError);
  });

  it("rejects under-collection and over-collection", () => {
    expect(() =>
      validateCODCollectionDetails(order, {
        collectedBy: "Courier A",
        collectedAmount: 2400,
      }),
    ).toThrow(ValidationError);

    expect(() =>
      validateCODCollectionDetails(order, {
        collectedBy: "Courier A",
        collectedAmount: 2600,
      }),
    ).toThrow(ValidationError);
  });

  it("rejects collection when no balance remains", () => {
    expect(() =>
      validateCODCollectionDetails(
        {
          totalAmount: 2500,
          paidAmount: 2500,
          balanceDue: 0,
        },
        {
          collectedBy: "Courier A",
          collectedAmount: 2500,
        },
      ),
    ).toThrow(ValidationError);
  });

  it.each([
    {
      currencyCode: "JPY",
      decimalPlaces: 0,
      totalAmount: 100.49,
      collectedAmount: 100,
      expectedAmount: 100,
    },
    {
      currencyCode: "KWD",
      decimalPlaces: 3,
      totalAmount: 1.2346,
      collectedAmount: 1.235,
      expectedAmount: 1.235,
    },
  ])(
    "validates $currencyCode COD collection at the immutable order precision",
    ({ currencyCode, decimalPlaces, totalAmount, collectedAmount, expectedAmount }) => {
      expect(validateCODCollectionDetails({
        totalAmount,
        paidAmount: 0,
        balanceDue: totalAmount,
        currencyCode,
        currencyDecimalPlaces: decimalPlaces,
      }, {
        collectedBy: "Courier A",
        collectedAmount,
      })).toMatchObject({
        collectedAmount: expectedAmount,
        expectedAmount,
        newPaidAmount: expectedAmount,
        newBalanceDue: 0,
      });
    },
  );
});

describe("recordCODCollection", () => {
  it("creates missing collection tracking in the same batch as a new COD settlement", async () => {
    const { db, batches, inserts } = createCodDbMock({
      selectedOrder: {
        id: "order_1",
        totalAmount: 100,
        paidAmount: 0,
        balanceDue: 100,
        paymentMethod: PaymentMethod.COD,
        paymentStatus: PaymentStatus.UNPAID,
        version: 1,
      },
      selectedTracking: null,
    });

    await expect(recordCODCollection(db as never, {
      orderId: "order_1",
      collectedBy: "Courier A",
      collectedAmount: 100,
    })).resolves.toEqual({ success: true });

    expect(batches).toHaveLength(1);
    expect(inserts).toEqual(expect.arrayContaining([
      expect.objectContaining({ orderId: "order_1", codStatus: CodStatus.PENDING }),
      expect.objectContaining({
        id: "cod_collection:order_1",
        orderId: "order_1",
        paymentType: "full",
        paymentMethod: PaymentMethod.COD,
      }),
    ]));
  });

  it("does not treat existing COD payment as idempotent without collected tracking", async () => {
    const { db, batches } = createCodDbMock({
      selectedOrder: {
        id: "order_1",
        totalAmount: 100,
        paidAmount: 100,
        balanceDue: 0,
        paymentMethod: PaymentMethod.COD,
        paymentStatus: PaymentStatus.PAID,
        version: 2,
      },
      selectedPayment: {
        id: "pay_1",
        amount: 100,
        currency: "BDT",
        paymentType: "full",
        codCollectedBy: "Courier A",
      },
      selectedTracking: null,
    });

    await expect(recordCODCollection(db as never, {
      orderId: "order_1",
      collectedBy: "Courier A",
      collectedAmount: 100,
    })).rejects.toThrow("evidence is incomplete");

    expect(batches).toHaveLength(0);
  });

  it("records KWD COD money and ledger currency from the immutable order snapshot", async () => {
    const { db, inserts } = createCodDbMock({
      selectedOrder: {
        id: "order_kwd",
        totalAmount: 1.235,
        paidAmount: 0,
        balanceDue: 1.235,
        paymentMethod: PaymentMethod.COD,
        paymentStatus: PaymentStatus.UNPAID,
        version: 1,
        currencyCode: "KWD",
        currencyDecimalPlaces: 3,
      },
      selectedTracking: { id: "cod_kwd" },
    });

    await expect(recordCODCollection(db as never, {
      orderId: "order_kwd",
      collectedBy: "Courier A",
      collectedAmount: 1.2346,
    })).resolves.toEqual({ success: true });

    expect(inserts).toContainEqual(expect.objectContaining({
      orderId: "order_kwd",
      amount: 1.235,
      currency: "KWD",
      paymentMethod: "cod",
    }));
  });

  it("fails a duplicate COD replay whose ledger currency differs from the order snapshot", async () => {
    const { db } = createCodDbMock({
      selectedOrder: {
        id: "order_kwd",
        totalAmount: 1.235,
        paidAmount: 1.235,
        balanceDue: 0,
        paymentMethod: PaymentMethod.COD,
        paymentStatus: PaymentStatus.PAID,
        version: 2,
        currencyCode: "KWD",
        currencyDecimalPlaces: 3,
      },
      selectedPayment: {
        id: "pay_wrong",
        amount: 1.235,
        currency: "BDT",
        paymentType: "full",
        codCollectedBy: "Courier A",
      },
      selectedTracking: { id: "cod_kwd" },
    });

    await expect(recordCODCollection(db as never, {
      orderId: "order_kwd",
      collectedBy: "Courier A",
      collectedAmount: 1.235,
    })).rejects.toThrow("currency does not match");
  });

  it("records an exact paid-deposit balance as cash and completes the existing payment plan", async () => {
    const { db, batches, inserts, updates } = createCodDbMock({
      selectedOrder: {
        id: "order_advance",
        totalAmount: 2500,
        paidAmount: 500,
        balanceDue: 2000,
        paymentMethod: PaymentMethod.SSLCOMMERZ,
        paymentStatus: PaymentStatus.PARTIAL,
        version: 4,
        currencyCode: "BDT",
        currencyDecimalPlaces: 2,
      },
      selectedPlan: {
        id: "plan_1",
        status: PaymentPlanStatus.DEPOSIT_PAID,
        balanceDue: 2000,
      },
      selectedTracking: null,
    });

    await expect(recordCODCollection(db as never, {
      orderId: "order_advance",
      collectedBy: "Courier A",
      collectedAmount: 2000,
    })).resolves.toEqual({ success: true });

    expect(batches).toHaveLength(1);
    expect(inserts).toContainEqual(expect.objectContaining({
      id: "cod_collection:order_advance",
      amount: 2000,
      currency: "BDT",
      paymentMethod: PaymentMethod.COD,
      paymentType: "balance",
      status: PaymentRecordStatus.SUCCEEDED,
    }));
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        paymentStatus: PaymentStatus.PAID,
        paidAmount: 2500,
        balanceDue: 0,
        version: 5,
      }),
      expect.objectContaining({
        status: PaymentPlanStatus.COMPLETED,
      }),
    ]));
  });

  it("rejects a cash balance that differs from the paid-deposit plan", async () => {
    const { db, batches } = createCodDbMock({
      selectedOrder: {
        id: "order_advance",
        totalAmount: 2500,
        paidAmount: 500,
        balanceDue: 2000,
        paymentMethod: PaymentMethod.STRIPE,
        paymentStatus: PaymentStatus.PARTIAL,
        version: 4,
      },
      selectedPlan: {
        id: "plan_1",
        status: PaymentPlanStatus.DEPOSIT_PAID,
        balanceDue: 1900,
      },
    });

    await expect(recordCODCollection(db as never, {
      orderId: "order_advance",
      collectedBy: "Courier A",
      collectedAmount: 2000,
    })).rejects.toThrow("remaining balance in the payment plan");
    expect(batches).toHaveLength(0);
  });

  it("treats a fully committed cash-balance replay as idempotent", async () => {
    const { db, batches } = createCodDbMock({
      selectedOrder: {
        id: "order_advance",
        totalAmount: 2500,
        paidAmount: 2500,
        balanceDue: 0,
        paymentMethod: PaymentMethod.SSLCOMMERZ,
        paymentStatus: PaymentStatus.PAID,
        version: 5,
      },
      selectedPlan: {
        id: "plan_1",
        status: PaymentPlanStatus.COMPLETED,
        balanceDue: 2000,
      },
      selectedPayment: {
        id: "cod_collection:order_advance",
        amount: 2000,
        currency: "BDT",
        paymentType: "balance",
        codCollectedBy: "Courier A",
      },
      selectedTracking: {
        id: "cod_1",
        codStatus: CodStatus.COLLECTED,
        collectedBy: "Courier A",
        collectedAmount: 2000,
      },
    });

    await expect(recordCODCollection(db as never, {
      orderId: "order_advance",
      collectedBy: "Courier A",
      collectedAmount: 2000,
    })).resolves.toEqual({ success: true });
    expect(batches).toHaveLength(0);
  });

  it("rolls every settlement write back when a concurrent order update wins first", async () => {
    const { sqlite, db } = createCodIntegrationDatabase((raceDb) => {
      raceDb.prepare("UPDATE orders SET version = version + 1 WHERE id = ?").run("order_race");
    });
    await insertAdvancePaymentOrder(db, "order_race");

    await expect(recordCODCollection(db, {
      orderId: "order_race",
      collectedBy: "Courier A",
      collectedAmount: 2000,
    })).rejects.toThrow("changed while cash collection was being recorded");

    expect(sqlite.prepare(
      "SELECT version, payment_status, paid_amount, balance_due FROM orders WHERE id = ?",
    ).get("order_race")).toMatchObject({
      version: 2,
      payment_status: PaymentStatus.PARTIAL,
      paid_amount: 500,
      balance_due: 2000,
    });
    expect(sqlite.prepare("SELECT count(*) AS count FROM order_payments WHERE order_id = ?").get("order_race"))
      .toMatchObject({ count: 0 });
    expect(sqlite.prepare("SELECT count(*) AS count FROM cod_tracking WHERE order_id = ?").get("order_race"))
      .toMatchObject({ count: 0 });
    expect(sqlite.prepare("SELECT status, balance_paid_at FROM payment_plans WHERE order_id = ?").get("order_race"))
      .toMatchObject({ status: PaymentPlanStatus.DEPOSIT_PAID, balance_paid_at: null });
  });

  it("accepts a concurrent identical settlement without duplicating payment or delivery evidence", async () => {
    const { sqlite, db } = createCodIntegrationDatabase((raceDb) => {
      raceDb.prepare(`
        UPDATE orders
        SET version = 2, payment_status = 'paid', paid_amount = 2500, balance_due = 0
        WHERE id = 'order_concurrent'
      `).run();
      raceDb.prepare(`
        INSERT INTO order_payments (
          id, order_id, amount, currency, payment_method, payment_type, status,
          cod_collected_by, cod_collected_at, created_at, updated_at
        ) VALUES (
          'cod_collection:order_concurrent', 'order_concurrent', 2000, 'BDT',
          'cod', 'balance', 'succeeded', 'Courier A', unixepoch(), unixepoch(), unixepoch()
        )
      `).run();
      raceDb.prepare(`
        INSERT INTO cod_tracking (
          id, order_id, delivery_attempts, cod_status, collected_by,
          collected_amount, collected_at, created_at, updated_at
        ) VALUES (
          'cod_concurrent', 'order_concurrent', 1, 'collected', 'Courier A',
          2000, unixepoch(), unixepoch(), unixepoch()
        )
      `).run();
      raceDb.prepare(`
        UPDATE payment_plans
        SET status = 'completed', balance_paid_at = unixepoch(), updated_at = unixepoch()
        WHERE order_id = 'order_concurrent'
      `).run();
    });
    await insertAdvancePaymentOrder(db, "order_concurrent");

    await expect(recordCODCollection(db, {
      orderId: "order_concurrent",
      collectedBy: "Courier A",
      collectedAmount: 2000,
    })).resolves.toEqual({ success: true });

    expect(sqlite.prepare("SELECT count(*) AS count FROM order_payments WHERE order_id = ?").get("order_concurrent"))
      .toMatchObject({ count: 1 });
    expect(sqlite.prepare("SELECT delivery_attempts FROM cod_tracking WHERE order_id = ?").get("order_concurrent"))
      .toMatchObject({ delivery_attempts: 1 });
  });

  it("rejects a concurrent settlement recorded by a different collector", async () => {
    const { sqlite, db } = createCodIntegrationDatabase((raceDb) => {
      raceDb.prepare(`
        UPDATE orders
        SET version = 2, payment_status = 'paid', paid_amount = 2500, balance_due = 0
        WHERE id = 'order_conflicting_collector'
      `).run();
      raceDb.prepare(`
        INSERT INTO order_payments (
          id, order_id, amount, currency, payment_method, payment_type, status,
          cod_collected_by, cod_collected_at, created_at, updated_at
        ) VALUES (
          'cod_collection:order_conflicting_collector', 'order_conflicting_collector',
          2000, 'BDT', 'cod', 'balance', 'succeeded', 'Courier B',
          unixepoch(), unixepoch(), unixepoch()
        )
      `).run();
      raceDb.prepare(`
        INSERT INTO cod_tracking (
          id, order_id, delivery_attempts, cod_status, collected_by,
          collected_amount, collected_at, created_at, updated_at
        ) VALUES (
          'cod_conflicting_collector', 'order_conflicting_collector', 1,
          'collected', 'Courier B', 2000, unixepoch(), unixepoch(), unixepoch()
        )
      `).run();
      raceDb.prepare(`
        UPDATE payment_plans
        SET status = 'completed', balance_paid_at = unixepoch(), updated_at = unixepoch()
        WHERE order_id = 'order_conflicting_collector'
      `).run();
    });
    await insertAdvancePaymentOrder(db, "order_conflicting_collector");

    await expect(recordCODCollection(db, {
      orderId: "order_conflicting_collector",
      collectedBy: "Courier A",
      collectedAmount: 2000,
    })).rejects.toThrow("changed while cash collection was being recorded");

    expect(sqlite.prepare(
      "SELECT cod_collected_by FROM order_payments WHERE order_id = ?",
    ).get("order_conflicting_collector")).toMatchObject({ cod_collected_by: "Courier B" });
    expect(sqlite.prepare(
      "SELECT collected_by, delivery_attempts FROM cod_tracking WHERE order_id = ?",
    ).get("order_conflicting_collector")).toMatchObject({
      collected_by: "Courier B",
      delivery_attempts: 1,
    });
  });
});

describe("markCODReturned", () => {
  it("fails closed when no COD tracking row is updated", async () => {
    const { db, updates } = createCodDbMock({
      selectedOrder: null,
      updateResults: [],
    });

    await expect(markCODReturned(db as never, "order_1")).rejects.toThrow("COD tracking record is missing");

    expect(updates[0]).toMatchObject({ codStatus: "returned" });
  });
});
