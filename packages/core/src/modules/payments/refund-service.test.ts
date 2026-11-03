import { describe, expect, it, vi } from "vitest";
import {
  computePaymentStateFromLedger,
  finalizeAcceptedRefundAttemptIds,
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

import { paymentPlans } from "@scalius/database/schema";

function refundDb(overrides: {
  attempt?: Record<string, unknown>;
  order?: Record<string, unknown>;
  plan?: Record<string, unknown> | null;
  ledgerRows?: Array<Record<string, unknown>>;
} = {}): any {
  const attempt = overrides.attempt ?? {
    id: "attempt_1",
    orderId: "order_1",
    refundPaymentId: "payment_1",
    providerRefundId: null,
    amountMinor: 2000,
    currency: "EGP",
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
    __setCalls: setCalls,
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