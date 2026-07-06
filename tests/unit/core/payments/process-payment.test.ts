// tests/unit/core/payments/process-payment.test.ts
// Tests the payment processing logic from process-payment.ts.
// Covers idempotency, partial/full payment, status transitions.

import { beforeEach, describe, it, expect, vi } from "vitest";

const settingsMocks = vi.hoisted(() => ({
  getCurrencyConfig: vi.fn(),
}));

vi.mock("../../../../packages/core/src/modules/settings/settings.service", () => ({
  getCurrencyConfig: settingsMocks.getCurrencyConfig,
}));

// ---------------------------------------------------------------------------
// Enums (from src/db/schema/enums.ts)
// ---------------------------------------------------------------------------

const PaymentStatus = {
  UNPAID: "unpaid",
  PARTIAL: "partial",
  PAID: "paid",
  REFUNDED: "refunded",
  FAILED: "failed",
} as const;

const OrderStatus = {
  PENDING: "pending",
  CONFIRMED: "confirmed",
  SHIPPED: "shipped",
  INCOMPLETE: "incomplete",
  CANCELLED: "cancelled",
} as const;

// ---------------------------------------------------------------------------
// Pure logic extracted from processPaymentConfirmed()
// ---------------------------------------------------------------------------

interface OrderPaymentState {
  totalAmount: number;
  paidAmount: number;
  paymentStatus: string;
  status: string;
}

interface PaymentProcessResult {
  shouldProcess: boolean;
  isIdempotent: boolean;
  newPaidAmount: number;
  newBalanceDue: number;
  isFullyPaid: boolean;
  newPaymentStatus: string;
  newOrderStatus: string;
  reason?: string;
}

function computePaymentResult(
  order: OrderPaymentState,
  paymentAmount: number,
  hasDuplicatePaymentRecord: boolean
): PaymentProcessResult {
  // Guard: already fully paid
  if (order.paymentStatus === PaymentStatus.PAID) {
    return {
      shouldProcess: false,
      isIdempotent: true,
      newPaidAmount: order.paidAmount,
      newBalanceDue: 0,
      isFullyPaid: true,
      newPaymentStatus: PaymentStatus.PAID,
      newOrderStatus: order.status,
      reason: "Already fully paid",
    };
  }

  // Duplicate payment record check
  if (hasDuplicatePaymentRecord) {
    return {
      shouldProcess: false,
      isIdempotent: true,
      newPaidAmount: order.paidAmount,
      newBalanceDue: Math.max(0, order.totalAmount - order.paidAmount),
      isFullyPaid: false,
      newPaymentStatus: order.paymentStatus,
      newOrderStatus: order.status,
      reason: "Duplicate payment record",
    };
  }

  const newPaidAmount = order.paidAmount + paymentAmount;
  const newBalanceDue = Math.max(0, order.totalAmount - newPaidAmount);
  const isFullyPaid = newBalanceDue <= 0.01; // Float drift guard

  const newPaymentStatus = isFullyPaid ? PaymentStatus.PAID : PaymentStatus.PARTIAL;
  const newOrderStatus = order.status === OrderStatus.INCOMPLETE
    ? OrderStatus.PENDING
    : order.status;

  return {
    shouldProcess: true,
    isIdempotent: false,
    newPaidAmount,
    newBalanceDue,
    isFullyPaid,
    newPaymentStatus,
    newOrderStatus,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("processPaymentConfirmed logic", () => {
  describe("idempotency", () => {
    it("returns success without mutation when already PAID", () => {
      const order: OrderPaymentState = {
        totalAmount: 2500,
        paidAmount: 2500,
        paymentStatus: PaymentStatus.PAID,
        status: OrderStatus.PENDING,
      };

      const result = computePaymentResult(order, 2500, false);
      expect(result.shouldProcess).toBe(false);
      expect(result.isIdempotent).toBe(true);
      expect(result.newPaidAmount).toBe(2500);
      expect(result.reason).toBe("Already fully paid");
    });

    it("returns success without mutation for duplicate gateway ID", () => {
      const order: OrderPaymentState = {
        totalAmount: 2500,
        paidAmount: 0,
        paymentStatus: PaymentStatus.UNPAID,
        status: OrderStatus.PENDING,
      };

      const result = computePaymentResult(order, 2500, true);
      expect(result.shouldProcess).toBe(false);
      expect(result.isIdempotent).toBe(true);
      expect(result.reason).toBe("Duplicate payment record");
    });
  });

  describe("partial payment", () => {
    it("updates to PARTIAL when payment < totalAmount", () => {
      const order: OrderPaymentState = {
        totalAmount: 2500,
        paidAmount: 0,
        paymentStatus: PaymentStatus.UNPAID,
        status: OrderStatus.PENDING,
      };

      const result = computePaymentResult(order, 1000, false);
      expect(result.shouldProcess).toBe(true);
      expect(result.isFullyPaid).toBe(false);
      expect(result.newPaymentStatus).toBe(PaymentStatus.PARTIAL);
      expect(result.newPaidAmount).toBe(1000);
      expect(result.newBalanceDue).toBe(1500);
    });

    it("accumulates multiple partial payments", () => {
      const order: OrderPaymentState = {
        totalAmount: 2500,
        paidAmount: 1000, // First payment already applied
        paymentStatus: PaymentStatus.PARTIAL,
        status: OrderStatus.PENDING,
      };

      const result = computePaymentResult(order, 500, false);
      expect(result.shouldProcess).toBe(true);
      expect(result.isFullyPaid).toBe(false);
      expect(result.newPaymentStatus).toBe(PaymentStatus.PARTIAL);
      expect(result.newPaidAmount).toBe(1500);
      expect(result.newBalanceDue).toBe(1000);
    });
  });

  describe("full payment", () => {
    it("updates to PAID when payment covers totalAmount", () => {
      const order: OrderPaymentState = {
        totalAmount: 2500,
        paidAmount: 0,
        paymentStatus: PaymentStatus.UNPAID,
        status: OrderStatus.PENDING,
      };

      const result = computePaymentResult(order, 2500, false);
      expect(result.shouldProcess).toBe(true);
      expect(result.isFullyPaid).toBe(true);
      expect(result.newPaymentStatus).toBe(PaymentStatus.PAID);
      expect(result.newPaidAmount).toBe(2500);
      expect(result.newBalanceDue).toBe(0);
    });

    it("updates to PAID when final partial payment completes total", () => {
      const order: OrderPaymentState = {
        totalAmount: 2500,
        paidAmount: 1500,
        paymentStatus: PaymentStatus.PARTIAL,
        status: OrderStatus.PENDING,
      };

      const result = computePaymentResult(order, 1000, false);
      expect(result.shouldProcess).toBe(true);
      expect(result.isFullyPaid).toBe(true);
      expect(result.newPaymentStatus).toBe(PaymentStatus.PAID);
      expect(result.newPaidAmount).toBe(2500);
      expect(result.newBalanceDue).toBe(0);
    });

    it("handles overpayment gracefully (balanceDue never negative)", () => {
      const order: OrderPaymentState = {
        totalAmount: 2500,
        paidAmount: 0,
        paymentStatus: PaymentStatus.UNPAID,
        status: OrderStatus.PENDING,
      };

      const result = computePaymentResult(order, 3000, false);
      expect(result.isFullyPaid).toBe(true);
      expect(result.newBalanceDue).toBe(0); // MAX(0, ...)
      expect(result.newPaidAmount).toBe(3000);
    });
  });

  describe("INCOMPLETE order transitions", () => {
    it("transitions INCOMPLETE to PENDING on payment", () => {
      const order: OrderPaymentState = {
        totalAmount: 2500,
        paidAmount: 0,
        paymentStatus: PaymentStatus.UNPAID,
        status: OrderStatus.INCOMPLETE,
      };

      const result = computePaymentResult(order, 2500, false);
      expect(result.newOrderStatus).toBe(OrderStatus.PENDING);
    });

    it("does NOT change status for non-INCOMPLETE orders", () => {
      const order: OrderPaymentState = {
        totalAmount: 2500,
        paidAmount: 0,
        paymentStatus: PaymentStatus.UNPAID,
        status: OrderStatus.CONFIRMED,
      };

      const result = computePaymentResult(order, 2500, false);
      expect(result.newOrderStatus).toBe(OrderStatus.CONFIRMED);
    });
  });

  describe("float precision edge cases", () => {
    it("treats balance <= 0.01 as fully paid (float drift guard)", () => {
      const order: OrderPaymentState = {
        totalAmount: 99.99,
        paidAmount: 0,
        paymentStatus: PaymentStatus.UNPAID,
        status: OrderStatus.PENDING,
      };

      // Simulate tiny float imprecision
      const result = computePaymentResult(order, 99.985, false);
      expect(result.isFullyPaid).toBe(true);
      expect(result.newPaymentStatus).toBe(PaymentStatus.PAID);
    });
  });
});

function createSelectQuery(value: unknown) {
  const query: Record<string, unknown> = {};
  const returnSelf = () => query;
  query.from = vi.fn(returnSelf);
  query.where = vi.fn(returnSelf);
  query.get = vi.fn(() => Promise.resolve(value));
  return query;
}

function createUpdateQuery(label: string) {
  const statement = { label };
  const query: Record<string, unknown> = {};
  const returnSelf = () => query;
  query.set = vi.fn(returnSelf);
  query.where = vi.fn(returnSelf);
  query.returning = vi.fn(() => statement);
  return query;
}

function createPaymentDb(options: {
  shipmentClaim?: { shipmentClaimId: string | null; shipmentClaimExpiresAt: number | null } | null;
  existingPayment?: { id: string; amount: number; status: string } | null;
  orders: Array<{
    id: string;
    totalAmount: number;
    paidAmount: number;
    balanceDue: number;
    paymentStatus: string;
    status: string;
    inventoryPool: string;
    version: number;
  }>;
  extraSelects?: unknown[];
  batchResults: unknown[];
}) {
  const selectValues: unknown[] = [
    options.shipmentClaim ?? null,
    options.existingPayment ?? null,
    ...options.orders,
    ...(options.extraSelects ?? []),
  ];
  let updateCount = 0;
  const outboxStatement = { label: "meta-purchase-outbox-claim" };
  return {
    select: vi.fn(() => createSelectQuery(selectValues.shift() ?? null)),
    insert: vi.fn(() => ({
      values: vi.fn(() => Promise.resolve(undefined)),
      select: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => outboxStatement),
      })),
    })),
    update: vi.fn(() => {
      updateCount += 1;
      return createUpdateQuery(`update-${updateCount}`);
    }),
    batch: vi.fn(() => Promise.resolve(options.batchResults.shift())),
    outboxStatement,
  };
}

async function loadProcessPaymentConfirmed() {
  const module = await import("../../../../packages/core/src/modules/payments/process-payment");
  return module.processPaymentConfirmed;
}

beforeEach(() => {
  vi.clearAllMocks();
  settingsMocks.getCurrencyConfig.mockResolvedValue({ code: "BDT" });
});

describe("processPaymentConfirmed atomic persistence", () => {
  it("applies order, payment, and deposit plan writes in one guarded batch", async () => {
    const db = createPaymentDb({
      orders: [{
        id: "ord_test",
        totalAmount: 2500,
        paidAmount: 0,
        balanceDue: 2500,
        paymentStatus: PaymentStatus.UNPAID,
        status: OrderStatus.PENDING,
        inventoryPool: "regular",
        version: 1,
      }],
      extraSelects: [{
        status: "pending",
        depositAmount: 1000,
        balanceDue: 1500,
      }],
      batchResults: [[[{ id: "ord_test" }], [{ id: "pay_test" }], [{ id: "plan_test" }]]],
    });
    const processPaymentConfirmed = await loadProcessPaymentConfirmed();

    const result = await processPaymentConfirmed(db as never, {
      orderId: "ord_test",
      amount: 1000,
      paymentGateway: "stripe",
      paymentType: "deposit",
      stripePaymentIntentId: "pi_test",
    });

    expect(result).toEqual({ success: true });
    expect(db.batch).toHaveBeenCalledOnce();
    expect(vi.mocked(db.batch).mock.calls[0]?.[0]).toHaveLength(4);
    expect(vi.mocked(db.batch).mock.calls[0]?.[0]).toContain(db.outboxStatement);
  });

  it("retries the guarded batch when both order and payment guards lose the race", async () => {
    const db = createPaymentDb({
      orders: [
        {
          id: "ord_test",
          totalAmount: 2500,
          paidAmount: 0,
          balanceDue: 2500,
          paymentStatus: PaymentStatus.UNPAID,
          status: OrderStatus.PENDING,
          inventoryPool: "regular",
          version: 1,
        },
        {
          id: "ord_test",
          totalAmount: 2500,
          paidAmount: 0,
          balanceDue: 2500,
          paymentStatus: PaymentStatus.UNPAID,
          status: OrderStatus.PENDING,
          inventoryPool: "regular",
          version: 2,
        },
      ],
      batchResults: [
        [[], []],
        [[{ id: "ord_test" }], [{ id: "pay_test" }]],
      ],
    });
    const processPaymentConfirmed = await loadProcessPaymentConfirmed();

    const result = await processPaymentConfirmed(db as never, {
      orderId: "ord_test",
      amount: 2500,
      paymentGateway: "stripe",
      paymentType: "full",
      stripePaymentIntentId: "pi_test",
    });

    expect(result).toEqual({ success: true });
    expect(db.batch).toHaveBeenCalledTimes(2);
  });

  it("does not treat a split order/payment batch result as successful", async () => {
    const db = createPaymentDb({
      orders: [{
        id: "ord_test",
        totalAmount: 2500,
        paidAmount: 0,
        balanceDue: 2500,
        paymentStatus: PaymentStatus.UNPAID,
        status: OrderStatus.PENDING,
        inventoryPool: "regular",
        version: 1,
      }],
      batchResults: [[[{ id: "ord_test" }], []]],
    });
    const processPaymentConfirmed = await loadProcessPaymentConfirmed();

    const result = await processPaymentConfirmed(db as never, {
      orderId: "ord_test",
      amount: 2500,
      paymentGateway: "stripe",
      paymentType: "full",
      stripePaymentIntentId: "pi_test",
    });

    expect(result).toEqual({
      success: false,
      error: "Payment application changed concurrently; retry required",
    });
  });
});
