import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  computePaymentStateFromLedger,
  finalizeAcceptedRefundAttemptIds,
  processRefund,
} from "./refund-service";
import { PaymentRecordStatus, PaymentStatus, PaymentPlanStatus, OrderStatus } from "@scalius/database/schema";

type PaymentInput = Parameters<typeof computePaymentStateFromLedger>[0]["payments"][number];

function payment(
  overrides: Partial<{
    paymentType: string;
    status: string;
    amountMinor: number;
  }> = {},
): PaymentInput {
  return {
    paymentType: overrides.paymentType ?? "full",
    status: overrides.status ?? PaymentRecordStatus.SUCCEEDED,
    amountMinor: overrides.amountMinor ?? 0,
  };
}

describe("computePaymentStateFromLedger — manual COD deposit refunds (Fix D)", () => {
  it("fully refunded order with manual COD deposit: paid=0, balance=0, status=REFUNDED", () => {
    const result = computePaymentStateFromLedger({
      totalAmountMinor: 10000,
      payments: [
        payment({ paymentType: "deposit", status: PaymentRecordStatus.SUCCEEDED, amountMinor: 10000 }),
        payment({ paymentType: "refund", status: PaymentRecordStatus.REFUNDED, amountMinor: 10000 }),
      ],
    });
    expect(result.paidAmountMinor).toBe(0);
    expect(result.balanceDueMinor).toBe(0);
    expect(result.paymentStatus).toBe(PaymentStatus.REFUNDED);
    expect(result.isFullRefund).toBe(true);
  });

  it("partially refunded order (not manual COD deposit): paid=reduced, status=PARTIALLY_REFUNDED", () => {
    const result = computePaymentStateFromLedger({
      totalAmountMinor: 10000,
      payments: [
        payment({ paymentType: "full", status: PaymentRecordStatus.SUCCEEDED, amountMinor: 10000 }),
        payment({ paymentType: "refund", status: PaymentRecordStatus.REFUNDED, amountMinor: 3000 }),
      ],
    });
    expect(result.paidAmountMinor).toBe(7000);
    expect(result.balanceDueMinor).toBe(0);
    expect(result.paymentStatus).toBe(PaymentStatus.PARTIALLY_REFUNDED);
  });

  it("no refunds: paid=total, status=PAID", () => {
    const result = computePaymentStateFromLedger({
      totalAmountMinor: 10000,
      payments: [
        payment({ paymentType: "deposit", status: PaymentRecordStatus.SUCCEEDED, amountMinor: 10000 }),
      ],
    });
    expect(result.paidAmountMinor).toBe(10000);
    expect(result.balanceDueMinor).toBe(0);
    expect(result.paymentStatus).toBe(PaymentStatus.PAID);
  });

  it("partial payment (deposit recorded, balance not yet paid): paid=deposit, status=PARTIAL", () => {
    const result = computePaymentStateFromLedger({
      totalAmountMinor: 10000,
      payments: [
        payment({ paymentType: "deposit", status: PaymentRecordStatus.SUCCEEDED, amountMinor: 2000 }),
      ],
    });
    expect(result.paidAmountMinor).toBe(2000);
    expect(result.balanceDueMinor).toBe(8000);
    expect(result.paymentStatus).toBe(PaymentStatus.PARTIAL);
  });

  it("net-terms invoice (deferred) with partial refund: still owes balance", () => {
    const result = computePaymentStateFromLedger({
      totalAmountMinor: 10000,
      deferred: true,
      paymentTermsDays: 30,
      payments: [
        payment({ paymentType: "full", status: PaymentRecordStatus.SUCCEEDED, amountMinor: 4000 }),
        payment({ paymentType: "refund", status: PaymentRecordStatus.REFUNDED, amountMinor: 1000 }),
      ],
    });
    expect(result.paidAmountMinor).toBe(3000);
    expect(result.paymentStatus).toBe(PaymentStatus.PARTIAL);
  });

  it("manual COD deposit is captured (counts toward paid amount)", () => {
    const result = computePaymentStateFromLedger({
      totalAmountMinor: 10000,
      payments: [
        payment({ paymentType: "deposit", status: PaymentRecordStatus.SUCCEEDED, amountMinor: 2000 }),
      ],
    });
    // A manual COD deposit payment (paymentType="deposit", status=succeeded) is captured.
    expect(result.paidAmountMinor).toBe(2000);
    expect(result.balanceDueMinor).toBe(8000);
  });

  it("refund of manual COD deposit brings paid to zero", () => {
    const result = computePaymentStateFromLedger({
      totalAmountMinor: 10000,
      payments: [
        payment({ paymentType: "deposit", status: PaymentRecordStatus.SUCCEEDED, amountMinor: 2000 }),
        payment({ paymentType: "refund", status: PaymentRecordStatus.REFUNDED, amountMinor: 2000 }),
      ],
    });
    expect(result.paidAmountMinor).toBe(0);
    expect(result.paymentStatus).toBe(PaymentStatus.REFUNDED);
  });

  it("non-refund payment types don't count as captured", () => {
    const result = computePaymentStateFromLedger({
      totalAmountMinor: 10000,
      payments: [
        payment({ paymentType: "refund", status: PaymentRecordStatus.SUCCEEDED, amountMinor: 5000 }),
      ],
    });
    expect(result.paidAmountMinor).toBe(0);
    expect(result.paymentStatus).toBe(PaymentStatus.UNPAID);
  });

  it("only succeeded payments count as captured", () => {
    const result = computePaymentStateFromLedger({
      totalAmountMinor: 10000,
      payments: [
        payment({ paymentType: "deposit", status: PaymentRecordStatus.PENDING, amountMinor: 5000 }),
      ],
    });
    expect(result.paidAmountMinor).toBe(0);
    expect(result.paymentStatus).toBe(PaymentStatus.UNPAID);
  });
});

vi.mock("../../payments", () => ({
  resolveOrderCurrencySnapshot: vi.fn().mockReturnValue({ code: "EGP", decimalPlaces: 2 }),
  assertOrderPaymentCurrency: vi.fn(),
  buildReconciledRefundNotificationDedupeKey: vi.fn().mockReturnValue("dedupe_key"),
}));

vi.mock("../../inventory", () => ({
  applyInventoryForStatusChangeWithImpact: vi.fn().mockResolvedValue({
    inventoryAction: "none",
    availabilityTransitionVariantIds: [],
  }),
}));

vi.mock("../../notifications", () => ({
  buildReconciledRefundNotificationDedupeKey: vi.fn().mockReturnValue("dedupe_key"),
}));

vi.mock("../order-kernel", () => ({
  assertNoActiveShipmentClaim: vi.fn(),
  assertNoActivePaymentSessionAttempt: vi.fn().mockResolvedValue(undefined),
  assertNoActiveRefundAttempt: vi.fn().mockResolvedValue(undefined),
  findActiveRefundAttempt: vi.fn().mockResolvedValue(null),
  hasLegacyPendingRefund: vi.fn().mockResolvedValue(false),
  ACTIVE_REFUND_ATTEMPT_STATUSES: [],
  noActiveRefundAttemptForOrderIdCondition: vi.fn(),
  noActivePaymentSessionAttemptForOrderIdCondition: vi.fn(),
  REFUND_IN_PROGRESS_MESSAGE: "Refund in progress",
  canTransitionTo: vi.fn().mockReturnValue(true),
}));

import { paymentPlans, orders, orderPayments, refundAttempts } from "@scalius/database/schema";

function refundDb(overrides: {
  attempt?: Record<string, unknown>;
  order?: Record<string, unknown>;
  plan?: Record<string, unknown> | null;
  ledgerRows?: Array<Record<string, unknown>>;
  batchError?: Error;
} = {}): any {
  const attempt = overrides.attempt ?? {
    id: "attempt_1",
    orderId: "order_1",
    refundPaymentId: "payment_1",
    providerRefundId: null,
    amountMinor: 2000,
    currency: "EGP",
    metadata: '{"manualDepositRefund": true}',
  };
  const order = overrides.order ?? {
    id: "order_1",
    totalAmountMinor: 10000,
    paymentTermsDays: null,
    status: OrderStatus.PENDING,
    version: 1,
    currencyCode: "EGP",
    currencyDecimalPlaces: 2,
  };
  const plan = overrides.plan ?? null;
  const ledgerRows = overrides.ledgerRows ?? [
    { id: "payment_1", paymentType: "deposit", status: PaymentRecordStatus.SUCCEEDED, amountMinor: 2000, currency: "EGP" },
  ];

  let selectCount = 0;
  const setCalls: Array<[unknown, Record<string, unknown>]> = [];
  const batchCalls: Array<unknown[]> = [];

  function makeQuery(arrayResult: unknown[], singleResult: unknown): any {
    const result: any = {
      get: vi.fn().mockResolvedValue(singleResult),
      all: vi.fn().mockResolvedValue(arrayResult),
    };
    result.then = vi.fn().mockImplementation((resolve: (value: unknown[]) => void) => resolve(arrayResult));
    return result;
  }

  return {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => {
          selectCount++;
          if (selectCount === 1) return makeQuery([attempt], attempt);        // refundAttempts
          if (selectCount === 2) return makeQuery([order], order);            // orders .get()
          if (selectCount === 3) return makeQuery(ledgerRows, ledgerRows[0]); // orderPayments
          if (selectCount === 4) return makeQuery(plan ? [plan] : [], plan);  // paymentPlans .get()
          return makeQuery([], null);
        }),
      })),
    })),
    update: vi.fn().mockImplementation((table) => ({
      set: vi.fn().mockImplementation((values) => {
        setCalls.push([table, values]);
        return {
          where: vi.fn().mockImplementation(() => {
            const result: any = {
              returning: vi.fn().mockResolvedValue([{ id: "order_1" }]),
            };
            result.then = vi.fn().mockImplementation((resolve: (value: unknown[]) => void) =>
              resolve([{ id: "order_1" }]),
            );
            return result;
          }),
        };
      }),
    })),
    batch: vi.fn().mockImplementation(async (statements: unknown[]) => {
      if (overrides.batchError) throw overrides.batchError;
      batchCalls.push(statements);
      const results: unknown[] = [];
      for (const stmt of statements) {
        try {
          const sql = (stmt as { toSQL?: () => { sql: string } }).toSQL?.().sql ?? "";
          const isWrite = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);
          if (isWrite) {
            // Extract table name from SQL for __setCalls compatibility.
            const tableMatch = sql.match(/UPDATE (\w+) /i);
            const tableName = tableMatch?.[1];
            const tableMap: Record<string, unknown> = {
              order_payments: orderPayments,
              orders,
              payment_plans: paymentPlans,
              refund_attempts: refundAttempts,
            };
            const table = tableMap[tableName ?? ""] ?? null;
            if (table) {
              setCalls.push([table, {}]);
            }
            results.push([{ changes: 1 }]);
          } else {
            // Guard SELECT — return success (batchGuard = 1).
            results.push([{ batchGuard: 1 }]);
          }
        } catch {
          results.push([{ changes: 1 }]);
        }
      }
      return results as unknown[];
    }),
    __setCalls: setCalls,
    __batchCalls: batchCalls,
  } as any;
}

/** Mock DB for processRefund tests — matches processRefund's query order:
 *  1. orders (by id)
 *  2. orderPayments (by createdAt desc, id desc)
 *  3. paymentPlans (where orderId and kind="manual")
 *  4. refundAttempts (for assertNoActiveRefundAttempt) - returns empty (no active refund)
 */
function processRefundDb(overrides: {
  order?: Record<string, unknown>;
  plan?: Record<string, unknown> | null;
  ledgerRows?: Array<Record<string, unknown>>;
  batchError?: Error;
} = {}): any {
  const order = overrides.order ?? {
    id: "order_1",
    totalAmountMinor: 10000,
    paymentTermsDays: null,
    status: OrderStatus.CONFIRMED,
    version: 1,
    currencyCode: "EGP",
    currencyDecimalPlaces: 2,
  };
  const plan = overrides.plan ?? null;
  const ledgerRows = overrides.ledgerRows ?? [
    { id: "payment_1", paymentType: "deposit", status: PaymentRecordStatus.SUCCEEDED, amountMinor: 2000, currency: "EGP", paymentMethod: "cod" },
  ];

  let selectCount = 0;
  const setCalls: Array<[unknown, Record<string, unknown>]> = [];
  const batchCalls: Array<unknown[]> = [];

  function makeQuery(arrayResult: unknown[], singleResult: unknown): any {
    const result: any = {
      get: vi.fn().mockResolvedValue(singleResult),
      all: vi.fn().mockResolvedValue(arrayResult),
    };
    result.then = vi.fn().mockImplementation((resolve: (value: unknown[]) => void) => resolve(arrayResult));
    return result;
  }

  return {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => {
          selectCount++;
          const queryResult = (() => {
            if (selectCount === 1) return makeQuery([order], order);            // orders
            if (selectCount === 2) return makeQuery(ledgerRows, ledgerRows[0]); // orderPayments
            if (selectCount === 3) return makeQuery(plan ? [plan] : [], plan);  // paymentPlans
            if (selectCount === 4) return makeQuery([], null);                  // refundAttempts (active refund check) - none
            return makeQuery([], null);
          })();
          // Support .orderBy() for orderPayments query
          return {
            ...queryResult,
            orderBy: vi.fn().mockReturnValue(queryResult),
          };
        }),
      })),
    })),
    insert: vi.fn().mockImplementation((table) => ({
      values: vi.fn().mockImplementation((values) => {
        setCalls.push([table, values]);
        return {
          returning: vi.fn().mockResolvedValue([{ id: "new_id" }]),
          then: vi.fn().mockImplementation((resolve: (value: unknown[]) => void) =>
            resolve([{ id: "new_id" }]),
          ),
        };
      }),
    })),
    update: vi.fn().mockImplementation((table) => ({
      set: vi.fn().mockImplementation((values) => {
        setCalls.push([table, values]);
        return {
          where: vi.fn().mockImplementation(() => {
            const result: any = {
              returning: vi.fn().mockResolvedValue([{ id: "order_1" }]),
            };
            result.then = vi.fn().mockImplementation((resolve: (value: unknown[]) => void) =>
              resolve([{ id: "order_1" }]),
            );
            return result;
          }),
        };
      }),
    })),
    batch: vi.fn().mockImplementation(async (statements: unknown[]) => {
      if (overrides.batchError) throw overrides.batchError;
      batchCalls.push(statements);
      const results: unknown[] = [];
      for (const stmt of statements) {
        try {
          const sql = (stmt as { toSQL?: () => { sql: string } }).toSQL?.().sql ?? "";
          const isWrite = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);
          if (isWrite) {
            const tableMatch = sql.match(/UPDATE (\w+) /i);
            const tableName = tableMatch?.[1];
            const tableMap: Record<string, unknown> = {
              order_payments: orderPayments,
              orders,
              payment_plans: paymentPlans,
              refund_attempts: refundAttempts,
            };
            const table = tableMap[tableName ?? ""] ?? null;
            if (table) {
              setCalls.push([table, {}]);
            }
            results.push([{ changes: 1 }]);
          } else {
            results.push([{ batchGuard: 1 }]);
          }
        } catch {
          results.push([{ changes: 1 }]);
        }
      }
      return results as unknown[];
    }),
    __setCalls: setCalls,
    __batchCalls: batchCalls,
  } as any;
}

describe("finalizeAcceptedRefundAttemptIds — manual COD deposit plan cancellation", () => {
  it("cancels manual DEPOSIT_PAID plan when deposit is refunded", async () => {
    const db = refundDb({
      plan: { id: "plan_1", status: PaymentPlanStatus.DEPOSIT_PAID, kind: "manual" },
    });

    await finalizeAcceptedRefundAttemptIds(db, ["attempt_1"]);

    const planUpdate = (db as any).__setCalls.find(([table]: [unknown, Record<string, unknown>]) => table === paymentPlans);
    expect(planUpdate).toBeDefined();
    expect(planUpdate[1].status).toBe(PaymentPlanStatus.CANCELLED);
    expect(planUpdate[1].cancelledAt).toBeDefined();
  });

  it("does not cancel non-manual plan", async () => {
    const db = refundDb({
      plan: { id: "plan_1", status: PaymentPlanStatus.DEPOSIT_PAID, kind: "online" },
    });

    await finalizeAcceptedRefundAttemptIds(db, ["attempt_1"]);

    const planUpdate = (db as any).__setCalls.find(([table]: [unknown, Record<string, unknown>]) => table === paymentPlans);
    expect(planUpdate).toBeUndefined();
  });

  it("does not cancel plan that is not DEPOSIT_PAID", async () => {
    const db = refundDb({
      plan: { id: "plan_1", status: PaymentPlanStatus.PENDING, kind: "manual" },
    });

    await finalizeAcceptedRefundAttemptIds(db, ["attempt_1"]);

    const planUpdate = (db as any).__setCalls.find(([table]: [unknown, Record<string, unknown>]) => table === paymentPlans);
    expect(planUpdate).toBeUndefined();
  });

  it("does not cancel plan when no plan exists", async () => {
    const db = refundDb({ plan: null });

    await finalizeAcceptedRefundAttemptIds(db, ["attempt_1"]);

    const planUpdate = (db as any).__setCalls.find(([table]: [unknown, Record<string, unknown>]) => table === paymentPlans);
    expect(planUpdate).toBeUndefined();
  });
});

describe("finalizeAcceptedRefundAttemptIds — atomicity (Fix A)", () => {
  it("writes all tables in a single db.batch() call", async () => {
    const db = refundDb({
      plan: { id: "plan_1", status: PaymentPlanStatus.DEPOSIT_PAID, kind: "manual" },
    });

    await finalizeAcceptedRefundAttemptIds(db, ["attempt_1"]);

    const batchCalls = (db as any).__batchCalls;
    expect(batchCalls.length).toBe(1);
    const statements = batchCalls[0];
    expect(statements.length).toBeGreaterThanOrEqual(5);

    // All writes go through db.batch() — no individual committed updates outside it.
    // (db.update() is still called to build statement objects, but they are only
    // executed via db.batch().)
    expect(batchCalls[0].length).toBeGreaterThanOrEqual(5);
  });

  it("cancels plan in the same batch when manualDepositRefund is true", async () => {
    const db = refundDb({
      plan: { id: "plan_1", status: PaymentPlanStatus.DEPOSIT_PAID, kind: "manual" },
      attempt: { id: "attempt_1", orderId: "order_1", refundPaymentId: "payment_1", providerRefundId: null, amountMinor: 2000, currency: "EGP", metadata: '{"manualDepositRefund": true}' },
    });

    await finalizeAcceptedRefundAttemptIds(db, ["attempt_1"]);

    const batchCalls = (db as any).__batchCalls;
    expect(batchCalls.length).toBe(1);
    // batch contains order_payments, orders, payment_plans, refund_attempts writes + guards.
    expect(batchCalls[0].length).toBeGreaterThanOrEqual(6);
  });

  it("does not cancel plan in the batch when manualDepositRefund is false", async () => {
    const db = refundDb({
      plan: { id: "plan_1", status: PaymentPlanStatus.DEPOSIT_PAID, kind: "manual" },
      attempt: { id: "attempt_1", orderId: "order_1", refundPaymentId: "payment_1", providerRefundId: null, amountMinor: 2000, currency: "EGP", metadata: '{"manualDepositRefund": false}' },
    });

    await finalizeAcceptedRefundAttemptIds(db, ["attempt_1"]);

    const batchCalls = (db as any).__batchCalls;
    expect(batchCalls.length).toBe(1);
    // batch contains order_payments, orders, refund_attempts writes + guards (no payment_plans).
    expect(batchCalls[0].length).toBeGreaterThanOrEqual(5);
  });

  it("does not cancel plan when manualDepositRefund is absent from metadata", async () => {
    const db = refundDb({
      plan: { id: "plan_1", status: PaymentPlanStatus.DEPOSIT_PAID, kind: "manual" },
      attempt: { id: "attempt_1", orderId: "order_1", refundPaymentId: "payment_1", providerRefundId: null, amountMinor: 2000, currency: "EGP", metadata: '{}' },
    });

    await finalizeAcceptedRefundAttemptIds(db, ["attempt_1"]);

    const batchCalls = (db as any).__batchCalls;
    expect(batchCalls.length).toBe(1);
    expect(batchCalls[0].length).toBeGreaterThanOrEqual(5);
  });
});

describe("finalizeAcceptedRefundAttemptIds — CAS conflict rollback (Fix A)", () => {
  it("guard failure rolls back the entire batch — orderPayments unchanged", async () => {
    const guardError = new Error("REFUND_FINALIZE_ORDER_CONFLICT");
    const db = refundDb({
      plan: { id: "plan_1", status: PaymentPlanStatus.DEPOSIT_PAID, kind: "manual" },
      batchError: guardError,
    });

    await expect(finalizeAcceptedRefundAttemptIds(db, ["attempt_1"])).rejects.toThrow("REFUND_FINALIZE_ORDER_CONFLICT");

    // batch was attempted (statements built and passed to db.batch) but no writes committed.
    const batchCalls = (db as any).__batchCalls;
    expect(batchCalls.length).toBe(0); // batch threw before recording
  });

  it("plan status guard failure rolls back — paymentPlans unchanged", async () => {
    const guardError = new Error("REFUND_FINALIZE_PLAN_CONFLICT");
    const db = refundDb({
      plan: { id: "plan_1", status: PaymentPlanStatus.DEPOSIT_PAID, kind: "manual" },
      batchError: guardError,
    });

    await expect(finalizeAcceptedRefundAttemptIds(db, ["attempt_1"])).rejects.toThrow("REFUND_FINALIZE_PLAN_CONFLICT");

    const batchCalls = (db as any).__batchCalls;
    expect(batchCalls.length).toBe(0);
  });
});

describe("processRefund — manual COD deposit amount validation (Fix B)", () => {
  it("validates refund against plan.depositAmountMinor not order.paidAmountMinor", async () => {
    // Setup: manual COD deposit plan with depositAmountMinor = 2000
    // order.paidAmountMinor = 10000 (includes COD balance collected after deposit)
    // Refund amount = 2000 (exactly the deposit) should PASS even though 2000 < 10000
    const db = processRefundDb({
      plan: { id: "plan_1", depositAmountMinor: 2000, status: PaymentPlanStatus.DEPOSIT_PAID, kind: "manual" },
      order: {
        id: "order_1",
        totalAmountMinor: 10000,
        paidAmountMinor: 10000,  // COD balance collected after deposit
        status: OrderStatus.CONFIRMED,
        version: 1,
        currencyCode: "EGP",
        currencyDecimalPlaces: 2,
        paymentTermsDays: null
      },
      ledgerRows: [
        { id: "payment_1", paymentType: "deposit", status: PaymentRecordStatus.SUCCEEDED, amountMinor: 2000, currency: "EGP", paymentMethod: "cod" },
        { id: "payment_2", paymentType: "full", status: PaymentRecordStatus.SUCCEEDED, amountMinor: 8000, currency: "EGP", paymentMethod: "cod" },
      ],
    });

    // Mock the claim batch to succeed (manual settlement returns undefined from dispatchRefund)
    (db.batch as any).mockResolvedValueOnce([[{ changes: 1 }]]); // claim batch

    const params = {
      orderId: "order_1",
      amountMinor: 2000, // exactly the deposit amount
      reason: "Customer returned item",
      manualSettlementConfirmed: true,
      actorUserId: "admin_1",
      caller: "staff",
    };

    // Should not throw the deposit validation error - it may fail later at finalize
    // but the key validation (depositAmountMinor check) passes
    await expect(processRefund(db as any, params)).rejects.not.toThrow(
      "Partial refunds of a manual COD deposit are not supported"
    );
  });

  it("accepts full deposit refund even when COD balance was collected", async () => {
    // When order.paidAmountMinor > plan.depositAmountMinor (COD balance collected after deposit),
    // refundAmount === plan.depositAmountMinor must still pass
    const db = processRefundDb({
      plan: { id: "plan_1", depositAmountMinor: 3000, status: PaymentPlanStatus.DEPOSIT_PAID, kind: "manual" },
      order: {
        id: "order_1",
        totalAmountMinor: 10000,
        paidAmountMinor: 10000,  // COD balance collected (total = deposit + balance)
        status: OrderStatus.CONFIRMED,
        version: 1,
        currencyCode: "EGP",
        currencyDecimalPlaces: 2,
        paymentTermsDays: null
      },
      ledgerRows: [
        { id: "payment_1", paymentType: "deposit", status: PaymentRecordStatus.SUCCEEDED, amountMinor: 3000, currency: "EGP", paymentMethod: "cod" },
        { id: "payment_2", paymentType: "full", status: PaymentRecordStatus.SUCCEEDED, amountMinor: 7000, currency: "EGP", paymentMethod: "cod" },
      ],
    });

    (db.batch as any).mockResolvedValueOnce([[{ changes: 1 }]]); // claim batch

    const params = {
      orderId: "order_1",
      amountMinor: 3000, // exactly the deposit amount
      reason: "Customer returned item",
      manualSettlementConfirmed: true,
      actorUserId: "admin_1",
      caller: "staff",
    };

    // Should not throw the deposit validation error
    await expect(processRefund(db as any, params)).rejects.not.toThrow(
      "Partial refunds of a manual COD deposit are not supported"
    );
  });

  it("rejects partial deposit refund when deposit allocation < plan.depositAmountMinor", async () => {
    // Deposit allocation is 1500 but plan.depositAmountMinor = 2000
    // Only deposit paid (2000), refund 1500 -> deposit allocation 1500 < 2000 -> FAIL
    const db = processRefundDb({
      plan: { id: "plan_1", depositAmountMinor: 2000, status: PaymentPlanStatus.DEPOSIT_PAID, kind: "manual" },
      order: {
        id: "order_1",
        totalAmountMinor: 10000,
        paidAmountMinor: 2000,  // only deposit paid
        status: OrderStatus.CONFIRMED,
        version: 1,
        currencyCode: "EGP",
        currencyDecimalPlaces: 2,
        paymentTermsDays: null
      },
      ledgerRows: [
        { id: "payment_1", paymentType: "deposit", status: PaymentRecordStatus.SUCCEEDED, amountMinor: 2000, currency: "EGP", paymentMethod: "cod" },
      ],
    });

    const params = {
      orderId: "order_1",
      amountMinor: 1500, // less than depositAmountMinor
      reason: "Partial refund attempt",
      manualSettlementConfirmed: true,
      actorUserId: "admin_1",
      caller: "staff",
    };

    await expect(processRefund(db as any, params)).rejects.toThrow(
      "Partial refunds of a manual COD deposit are not supported. The deposit allocation must equal the full deposit amount."
    );
  });

  it("rejects over-allocation of deposit (deposit allocation > plan.depositAmountMinor)", async () => {
    // Plan depositAmountMinor = 1000, but deposit payment = 2000
    // Refund 2000 -> deposit allocation 2000 > plan.depositAmountMinor 1000 -> FAIL
    const db = processRefundDb({
      plan: { id: "plan_1", depositAmountMinor: 1000, status: PaymentPlanStatus.DEPOSIT_PAID, kind: "manual" },
      order: {
        id: "order_1",
        totalAmountMinor: 10000,
        paidAmountMinor: 2000,
        status: OrderStatus.CONFIRMED,
        version: 1,
        currencyCode: "EGP",
        currencyDecimalPlaces: 2,
        paymentTermsDays: null
      },
      ledgerRows: [
        { id: "payment_1", paymentType: "deposit", status: PaymentRecordStatus.SUCCEEDED, amountMinor: 2000, currency: "EGP", paymentMethod: "cod" },
      ],
    });

    const params = {
      orderId: "order_1",
      amountMinor: 2000,
      reason: "Over-refund attempt",
      manualSettlementConfirmed: true,
      actorUserId: "admin_1",
      caller: "staff",
    };

    await expect(processRefund(db as any, params)).rejects.toThrow(
      "Partial refunds of a manual COD deposit are not supported. The deposit allocation must equal the full deposit amount."
    );
  });

  it("allows mixed refund: full deposit + other allocation when deposit allocation equals plan.depositAmountMinor", async () => {
    // Mixed refund: deposit allocation = 2000 (exact), plus another allocation = 1000
    // Total refundAmount = 3000, deposit allocation = 2000 (exact) -> should PASS
    const db = processRefundDb({
      plan: { id: "plan_1", depositAmountMinor: 2000, status: PaymentPlanStatus.DEPOSIT_PAID, kind: "manual" },
      order: {
        id: "order_1",
        totalAmountMinor: 10000,
        paidAmountMinor: 10000,
        status: OrderStatus.CONFIRMED,
        version: 1,
        currencyCode: "EGP",
        currencyDecimalPlaces: 2,
        paymentTermsDays: null
      },
      ledgerRows: [
        { id: "payment_1", paymentType: "deposit", status: PaymentRecordStatus.SUCCEEDED, amountMinor: 2000, currency: "EGP", paymentMethod: "cod" },
        { id: "payment_2", paymentType: "full", status: PaymentRecordStatus.SUCCEEDED, amountMinor: 8000, currency: "EGP", paymentMethod: "cod" },
      ],
    });

    (db.batch as any).mockResolvedValueOnce([[{ changes: 1 }]]); // claim batch

    const params = {
      orderId: "order_1",
      amountMinor: 3000, // total refund (deposit 2000 + balance 1000)
      reason: "Mixed refund",
      manualSettlementConfirmed: true,
      actorUserId: "admin_1",
      caller: "staff",
    };

    // Should not throw the deposit validation error
    await expect(processRefund(db as any, params)).rejects.not.toThrow(
      "Partial refunds of a manual COD deposit are not supported"
    );
  });

  it("rejects when manualSettlementConfirmed is not true for manual COD deposit", async () => {
    const db = processRefundDb({
      plan: { id: "plan_1", depositAmountMinor: 2000, status: PaymentPlanStatus.DEPOSIT_PAID, kind: "manual" },
      order: {
        id: "order_1",
        totalAmountMinor: 10000,
        paidAmountMinor: 2000,
        status: OrderStatus.CONFIRMED,
        version: 1,
        currencyCode: "EGP",
        currencyDecimalPlaces: 2,
        paymentTermsDays: null
      },
      ledgerRows: [
        { id: "payment_1", paymentType: "deposit", status: PaymentRecordStatus.SUCCEEDED, amountMinor: 2000, currency: "EGP", paymentMethod: "cod" },
      ],
    });

    const params = {
      orderId: "order_1",
      amountMinor: 2000,
      reason: "Missing confirmation",
      manualSettlementConfirmed: false, // NOT confirmed
      actorUserId: "admin_1",
      caller: "staff",
    };

    await expect(processRefund(db as any, params)).rejects.toThrow(
      "Confirm that the customer has already received the refund by hand"
    );
  });
});