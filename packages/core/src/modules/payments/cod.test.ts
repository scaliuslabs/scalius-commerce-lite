import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "@scalius/core/errors";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
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

/** A migrated D1 whose first batch is preceded by `race` (a competing committed write). */
function createCodIntegrationDatabase(race?: (sqlite: DatabaseSync) => void) {
  let pending = race;
  return createSqliteD1Database({
    beforeBatch(sqlite) {
      const applyRace = pending;
      pending = undefined;
      applyRace?.(sqlite);
    },
  });
}

async function insertAdvancePaymentOrder(db: Database, orderId: string): Promise<void> {
  await db.insert(orders).values({
    id: orderId,
    customerName: "Buyer",
    customerPhone: "+8801711111111",
    shippingAddress: "Dhaka",
    city: "dhaka",
    zone: "zone_1",
    totalAmountMinor: 2500,
    paidAmountMinor: 500,
    balanceDueMinor: 2000,
    paymentMethod: PaymentMethod.SSLCOMMERZ,
    paymentStatus: PaymentStatus.PARTIAL,
    version: 1,
  });
  await db.insert(paymentPlans).values({
    id: `plan_${orderId}`,
    orderId,
    totalAmountMinor: 2500,
    depositAmountMinor: 500,
    balanceDueMinor: 2000,
    status: PaymentPlanStatus.DEPOSIT_PAID,
  });
}

describe("validateCODCollectionDetails", () => {
  const BDT = { currencyCode: "BDT", currencyDecimalPlaces: 2 };
  const order = { totalAmountMinor: 250_000, paidAmountMinor: 0, balanceDueMinor: 250_000, ...BDT };

  it("accepts exact outstanding COD collection amounts", () => {
    expect(
      validateCODCollectionDetails(order, { collectedBy: "Courier A", collectedAmountMinor: 250_000 }),
    ).toEqual({
      collectedBy: "Courier A",
      collectedAmountMinor: 250_000,
      newPaidAmountMinor: 250_000,
      newBalanceDueMinor: 0,
    });
  });

  it("uses the outstanding balance for partially paid COD orders", () => {
    expect(
      validateCODCollectionDetails(
        { totalAmountMinor: 250_000, paidAmountMinor: 50_000, balanceDueMinor: 200_000, ...BDT },
        { collectedBy: "Courier A", collectedAmountMinor: 200_000 },
      ),
    ).toMatchObject({ newPaidAmountMinor: 250_000, newBalanceDueMinor: 0 });
  });

  it("uses computed balance when stored balance due is stale", () => {
    expect(
      validateCODCollectionDetails(
        { totalAmountMinor: 250_000, paidAmountMinor: 0, balanceDueMinor: 0, ...BDT },
        { collectedBy: "Courier A", collectedAmountMinor: 250_000 },
      ),
    ).toMatchObject({ newPaidAmountMinor: 250_000, newBalanceDueMinor: 0 });
  });

  it("rejects missing collectors before any order mutation", () => {
    expect(() =>
      validateCODCollectionDetails(order, { collectedBy: "   ", collectedAmountMinor: 250_000 }),
    ).toThrow(ValidationError);
  });

  it("rejects non-positive or fractional minor amounts", () => {
    for (const collectedAmountMinor of [0, -1, 2500.5, Number.NaN]) {
      expect(() =>
        validateCODCollectionDetails(order, { collectedBy: "Courier A", collectedAmountMinor }),
      ).toThrow(ValidationError);
    }
  });

  it("rejects under-collection and over-collection", () => {
    for (const collectedAmountMinor of [249_999, 250_001]) {
      expect(() =>
        validateCODCollectionDetails(order, { collectedBy: "Courier A", collectedAmountMinor }),
      ).toThrow(ValidationError);
    }
  });

  it("rejects collection when no balance remains", () => {
    expect(() =>
      validateCODCollectionDetails(
        { totalAmountMinor: 250_000, paidAmountMinor: 250_000, balanceDueMinor: 0, ...BDT },
        { collectedBy: "Courier A", collectedAmountMinor: 250_000 },
      ),
    ).toThrow(ValidationError);
  });

  it("rejects an order whose currency snapshot is corrupt", () => {
    expect(() =>
      validateCODCollectionDetails(
        { ...order, currencyDecimalPlaces: 7 },
        { collectedBy: "Courier A", collectedAmountMinor: 250_000 },
      ),
    ).toThrow(ValidationError);
  });
});

describe("recordCODCollection", () => {
  it("creates missing collection tracking in the same batch as a new COD settlement", async () => {
    const { db, batches, inserts } = createCodDbMock({
      selectedOrder: {
        id: "order_1",
        totalAmountMinor: 100,
        paidAmountMinor: 0,
        balanceDueMinor: 100,
        paymentMethod: PaymentMethod.COD,
        paymentStatus: PaymentStatus.UNPAID,
        version: 1,
        currencyCode: "BDT",
        currencyDecimalPlaces: 2,
      },
      selectedTracking: null,
    });

    await expect(recordCODCollection(db as never, {
      orderId: "order_1",
      collectedBy: "Courier A",
      collectedAmountMinor: 100,
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
        totalAmountMinor: 100,
        paidAmountMinor: 100,
        balanceDueMinor: 0,
        paymentMethod: PaymentMethod.COD,
        paymentStatus: PaymentStatus.PAID,
        version: 2,
        currencyCode: "BDT",
        currencyDecimalPlaces: 2,
      },
      selectedPayment: {
        id: "pay_1",
        amountMinor: 100,
        currency: "BDT",
        paymentType: "full",
        codCollectedBy: "Courier A",
      },
      selectedTracking: null,
    });

    await expect(recordCODCollection(db as never, {
      orderId: "order_1",
      collectedBy: "Courier A",
      collectedAmountMinor: 100,
    })).rejects.toThrow("evidence is incomplete");

    expect(batches).toHaveLength(0);
  });

  it("records KWD COD money and ledger currency from the immutable order snapshot", async () => {
    const { db, inserts } = createCodDbMock({
      selectedOrder: {
        id: "order_kwd",
        totalAmountMinor: 1235,
        paidAmountMinor: 0,
        balanceDueMinor: 1235,
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
      collectedAmountMinor: 1235,
    })).resolves.toEqual({ success: true });

    expect(inserts).toContainEqual(expect.objectContaining({
      orderId: "order_kwd",
      amountMinor: 1235,
      currency: "KWD",
      paymentMethod: "cod",
    }));
  });

  it("fails a duplicate COD replay whose ledger currency differs from the order snapshot", async () => {
    const { db } = createCodDbMock({
      selectedOrder: {
        id: "order_kwd",
        totalAmountMinor: 1235,
        paidAmountMinor: 1235,
        balanceDueMinor: 0,
        paymentMethod: PaymentMethod.COD,
        paymentStatus: PaymentStatus.PAID,
        version: 2,
        currencyCode: "KWD",
        currencyDecimalPlaces: 3,
      },
      selectedPayment: {
        id: "pay_wrong",
        amountMinor: 1235,
        currency: "BDT",
        paymentType: "full",
        codCollectedBy: "Courier A",
      },
      selectedTracking: { id: "cod_kwd" },
    });

    await expect(recordCODCollection(db as never, {
      orderId: "order_kwd",
      collectedBy: "Courier A",
      collectedAmountMinor: 1235,
    })).rejects.toThrow("currency does not match");
  });

  it("records an exact paid-deposit balance as cash and completes the existing payment plan", async () => {
    const { db, batches, inserts, updates } = createCodDbMock({
      selectedOrder: {
        id: "order_advance",
        totalAmountMinor: 2500,
        paidAmountMinor: 500,
        balanceDueMinor: 2000,
        paymentMethod: PaymentMethod.SSLCOMMERZ,
        paymentStatus: PaymentStatus.PARTIAL,
        version: 4,
        currencyCode: "BDT",
        currencyDecimalPlaces: 2,
      },
      selectedPlan: {
        id: "plan_1",
        status: PaymentPlanStatus.DEPOSIT_PAID,
        balanceDueMinor: 2000,
      },
      selectedTracking: null,
    });

    await expect(recordCODCollection(db as never, {
      orderId: "order_advance",
      collectedBy: "Courier A",
      collectedAmountMinor: 2000,
    })).resolves.toEqual({ success: true });

    expect(batches).toHaveLength(1);
    expect(inserts).toContainEqual(expect.objectContaining({
      id: "cod_collection:order_advance",
      amountMinor: 2000,
      currency: "BDT",
      paymentMethod: PaymentMethod.COD,
      paymentType: "balance",
      status: PaymentRecordStatus.SUCCEEDED,
    }));
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        paymentStatus: PaymentStatus.PAID,
        paidAmountMinor: 2500,
        balanceDueMinor: 0,
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
        totalAmountMinor: 2500,
        paidAmountMinor: 500,
        balanceDueMinor: 2000,
        paymentMethod: PaymentMethod.STRIPE,
        paymentStatus: PaymentStatus.PARTIAL,
        version: 4,
        currencyCode: "BDT",
        currencyDecimalPlaces: 2,
      },
      selectedPlan: {
        id: "plan_1",
        status: PaymentPlanStatus.DEPOSIT_PAID,
        balanceDueMinor: 1900,
      },
    });

    await expect(recordCODCollection(db as never, {
      orderId: "order_advance",
      collectedBy: "Courier A",
      collectedAmountMinor: 2000,
    })).rejects.toThrow("remaining balance in the payment plan");
    expect(batches).toHaveLength(0);
  });

  it("treats a fully committed cash-balance replay as idempotent", async () => {
    const { db, batches } = createCodDbMock({
      selectedOrder: {
        id: "order_advance",
        totalAmountMinor: 2500,
        paidAmountMinor: 2500,
        balanceDueMinor: 0,
        paymentMethod: PaymentMethod.SSLCOMMERZ,
        paymentStatus: PaymentStatus.PAID,
        version: 5,
        currencyCode: "BDT",
        currencyDecimalPlaces: 2,
      },
      selectedPlan: {
        id: "plan_1",
        status: PaymentPlanStatus.COMPLETED,
        balanceDueMinor: 2000,
      },
      selectedPayment: {
        id: "cod_collection:order_advance",
        amountMinor: 2000,
        currency: "BDT",
        paymentType: "balance",
        codCollectedBy: "Courier A",
      },
      selectedTracking: {
        id: "cod_1",
        codStatus: CodStatus.COLLECTED,
        collectedBy: "Courier A",
        collectedAmountMinor: 2000,
      },
    });

    await expect(recordCODCollection(db as never, {
      orderId: "order_advance",
      collectedBy: "Courier A",
      collectedAmountMinor: 2000,
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
      collectedAmountMinor: 2000,
    })).rejects.toThrow("changed while cash collection was being recorded");

    expect(sqlite.prepare(
      "SELECT version, payment_status, paid_amount_minor, balance_due_minor FROM orders WHERE id = ?",
    ).get("order_race")).toMatchObject({
      version: 2,
      payment_status: PaymentStatus.PARTIAL,
      paid_amount_minor: 500,
      balance_due_minor: 2000,
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
        SET version = 2, payment_status = 'paid', paid_amount_minor = 2500, balance_due_minor = 0
        WHERE id = 'order_concurrent'
      `).run();
      raceDb.prepare(`
        INSERT INTO order_payments (
          id, order_id, amount_minor, currency, payment_method, payment_type, status,
          cod_collected_by, cod_collected_at, created_at, updated_at
        ) VALUES (
          'cod_collection:order_concurrent', 'order_concurrent', 2000, 'BDT',
          'cod', 'balance', 'succeeded', 'Courier A', unixepoch(), unixepoch(), unixepoch()
        )
      `).run();
      raceDb.prepare(`
        INSERT INTO cod_tracking (
          id, order_id, delivery_attempts, cod_status, collected_by,
          collected_amount_minor, collected_at, created_at, updated_at
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
      collectedAmountMinor: 2000,
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
        SET version = 2, payment_status = 'paid', paid_amount_minor = 2500, balance_due_minor = 0
        WHERE id = 'order_conflicting_collector'
      `).run();
      raceDb.prepare(`
        INSERT INTO order_payments (
          id, order_id, amount_minor, currency, payment_method, payment_type, status,
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
          collected_amount_minor, collected_at, created_at, updated_at
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
      collectedAmountMinor: 2000,
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
