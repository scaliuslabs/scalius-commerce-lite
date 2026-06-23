// tests/unit/core/payments/refund-validation.test.ts
// Tests refund validation logic from refund-service.ts.
// Covers amount validation, cumulative refunds, and inventory effects.

import { describe, it, expect, vi } from "vitest";

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
  PROCESSING: "processing",
  CONFIRMED: "confirmed",
  SHIPPED: "shipped",
  DELIVERED: "delivered",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  RETURNED: "returned",
  REFUNDED: "refunded",
  PARTIALLY_REFUNDED: "partially_refunded",
} as const;

// ---------------------------------------------------------------------------
// Pure logic extracted from processRefund()
// ---------------------------------------------------------------------------

interface OrderRefundState {
  totalAmount: number;
  paidAmount: number;
  paymentStatus: string;
  paymentMethod: string;
  status: string;
}

interface RefundValidationResult {
  valid: boolean;
  error?: string;
  refundAmount: number;
  isFullRefund: boolean;
  newPaidAmount: number;
  newPaymentStatus: string;
  nextOrderStatus?: string;
  shouldReleaseInventory: boolean;
}

interface RefundClaimState {
  orderVersion: number;
  paidAmount: number;
  paymentStatus: string;
  pendingRefund: boolean;
}

interface RefundClaimResult {
  claimed: boolean;
  shouldCallProvider: boolean;
  shouldCleanupClaim: boolean;
  error?: "pending_refund" | "cas_conflict" | "amount_exceeds_paid";
  nextState: RefundClaimState;
}

interface StatusInventoryState {
  orderVersion: number;
  status: string;
  inventoryRestored: boolean;
}

interface StatusInventoryResult {
  statusChanged: boolean;
  inventoryRestored: boolean;
  nextState: StatusInventoryState;
}

type MockChain = {
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  then: (resolve: (value: unknown) => void, reject?: (reason: unknown) => void) => Promise<void>;
};

const PRE_FULFILLMENT_REFUND_STATUSES = new Set<string>([
  OrderStatus.PENDING,
  OrderStatus.PROCESSING,
  OrderStatus.CONFIRMED,
]);

function getOrderStatusAfterRefund(currentStatus: string, isFullRefund: boolean): string | undefined {
  if (!isFullRefund) {
    return [OrderStatus.DELIVERED, OrderStatus.COMPLETED].includes(currentStatus)
      ? OrderStatus.PARTIALLY_REFUNDED
      : undefined;
  }

  if ([OrderStatus.DELIVERED, OrderStatus.COMPLETED, OrderStatus.RETURNED, OrderStatus.PARTIALLY_REFUNDED].includes(currentStatus)) {
    return OrderStatus.REFUNDED;
  }

  if (PRE_FULFILLMENT_REFUND_STATUSES.has(currentStatus)) {
    return OrderStatus.CANCELLED;
  }

  return undefined;
}

function shouldReleaseInventoryForFullRefund(currentStatus: string, nextStatus: string | undefined): boolean {
  return nextStatus === OrderStatus.CANCELLED && PRE_FULFILLMENT_REFUND_STATUSES.has(currentStatus);
}

function validateRefund(
  order: OrderRefundState,
  requestedAmount?: number,
): RefundValidationResult {
  // Guard: no payments to refund
  if (order.paymentStatus === PaymentStatus.UNPAID || order.paymentStatus === PaymentStatus.FAILED) {
    return {
      valid: false,
      error: "Order has no payments to refund",
      refundAmount: 0,
      isFullRefund: false,
      newPaidAmount: order.paidAmount,
      newPaymentStatus: order.paymentStatus,
      shouldReleaseInventory: false,
    };
  }

  // Guard: already fully refunded
  if (order.paymentStatus === PaymentStatus.REFUNDED) {
    return {
      valid: false,
      error: "Order is already fully refunded",
      refundAmount: 0,
      isFullRefund: false,
      newPaidAmount: order.paidAmount,
      newPaymentStatus: order.paymentStatus,
      shouldReleaseInventory: false,
    };
  }

  const refundAmount = requestedAmount ?? order.paidAmount;
  const isFullRefund = refundAmount >= order.paidAmount;

  // Validate: refund amount should not exceed paid amount
  if (refundAmount > order.paidAmount) {
    return {
      valid: false,
      error: `Refund amount (${refundAmount}) exceeds paid amount (${order.paidAmount})`,
      refundAmount,
      isFullRefund: true,
      newPaidAmount: order.paidAmount,
      newPaymentStatus: order.paymentStatus,
      shouldReleaseInventory: false,
    };
  }

  const newPaidAmount = Math.max(0, order.paidAmount - refundAmount);
  const newPaymentStatus = isFullRefund ? PaymentStatus.REFUNDED : PaymentStatus.PARTIAL;
  const nextOrderStatus = getOrderStatusAfterRefund(order.status, isFullRefund);
  const shouldReleaseInventory = isFullRefund && shouldReleaseInventoryForFullRefund(order.status, nextOrderStatus);

  return {
    valid: true,
    refundAmount,
    isFullRefund,
    newPaidAmount,
    newPaymentStatus,
    nextOrderStatus,
    shouldReleaseInventory,
  };
}

function claimRefundBeforeProvider(
  state: RefundClaimState,
  observedVersion: number,
  refundAmount: number,
): RefundClaimResult {
  if (state.pendingRefund) {
    return {
      claimed: false,
      shouldCallProvider: false,
      shouldCleanupClaim: false,
      error: "pending_refund",
      nextState: state,
    };
  }

  if (refundAmount > state.paidAmount) {
    return {
      claimed: false,
      shouldCallProvider: false,
      shouldCleanupClaim: false,
      error: "amount_exceeds_paid",
      nextState: state,
    };
  }

  // Mirrors UPDATE orders ... WHERE version = observedVersion RETURNING id.
  if (state.orderVersion !== observedVersion) {
    return {
      claimed: false,
      shouldCallProvider: false,
      shouldCleanupClaim: true,
      error: "cas_conflict",
      nextState: state,
    };
  }

  const nextPaidAmount = Math.max(0, state.paidAmount - refundAmount);
  return {
    claimed: true,
    shouldCallProvider: true,
    shouldCleanupClaim: false,
    nextState: {
      orderVersion: state.orderVersion + 1,
      paidAmount: nextPaidAmount,
      paymentStatus: nextPaidAmount === 0 ? PaymentStatus.REFUNDED : PaymentStatus.PARTIAL,
      pendingRefund: true,
    },
  };
}

function releaseFailedProviderClaim(
  state: RefundClaimState,
  refundAmount: number,
  originalPaymentStatus: string,
): RefundClaimState {
  return {
    orderVersion: state.orderVersion + 1,
    paidAmount: state.paidAmount + refundAmount,
    paymentStatus: originalPaymentStatus,
    pendingRefund: false,
  };
}

function finalizeSuccessfulProviderClaim(state: RefundClaimState): RefundClaimState {
  return {
    ...state,
    pendingRefund: false,
  };
}

function applyStatusCasBeforeInventory(
  state: StatusInventoryState,
  observedVersion: number,
  nextStatus: string,
  shouldRestoreInventory: boolean,
): StatusInventoryResult {
  if (state.orderVersion !== observedVersion) {
    return {
      statusChanged: false,
      inventoryRestored: false,
      nextState: state,
    };
  }

  return {
    statusChanged: true,
    inventoryRestored: shouldRestoreInventory,
    nextState: {
      orderVersion: state.orderVersion + 1,
      status: nextStatus,
      inventoryRestored: state.inventoryRestored || shouldRestoreInventory,
    },
  };
}

function createChain(result: unknown): MockChain {
  const chain = {} as MockChain;
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.set = vi.fn(() => chain);
  chain.values = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.returning = vi.fn(() => result);
  chain.get = vi.fn(async () => result ?? null);
  chain.then = (resolve, reject) => {
    const value = Array.isArray(result) ? result : result ? [result] : [];
    return Promise.resolve(value).then(resolve, reject);
  };
  return chain;
}

async function importRefundServiceWithMocks(options: {
  applyInventoryForStatusChange: ReturnType<typeof vi.fn>;
  createRefund?: ReturnType<typeof vi.fn>;
}) {
  vi.resetModules();
  vi.doMock("../../../../packages/core/src/modules/inventory/inventory-transitions", () => ({
    applyInventoryForStatusChange: options.applyInventoryForStatusChange,
  }));
  vi.doMock("../../../../packages/core/src/modules/payments/factory", () => ({
    createPaymentProvider: vi.fn(() => ({
      createRefund: options.createRefund ?? vi.fn(),
    })),
  }));
  vi.doMock("../../../../packages/core/src/modules/settings/settings.service", () => ({
    getCurrencyConfig: vi.fn(async () => ({ code: "BDT" })),
  }));

  return import("../../../../packages/core/src/modules/payments/refund-service");
}

function createReturnDbWithLostStatusCas() {
  const order = {
    id: "ord_return_cas",
    status: OrderStatus.DELIVERED,
    paymentStatus: PaymentStatus.PAID,
    version: 4,
  };

  const selectResults = [order, null, null];
  let selectIndex = 0;

  return {
    select: vi.fn(() => createChain(selectResults[selectIndex++])),
    update: vi.fn(() => createChain([])),
  };
}

function createRefundDbWithLostStatusCas() {
  const order = {
    id: "ord_refund_cas",
    totalAmount: 100,
    paidAmount: 100,
    paymentStatus: PaymentStatus.PAID,
    paymentMethod: "cod",
    status: OrderStatus.CONFIRMED,
    version: 7,
  };
  const payment = {
    id: "pay_1",
    orderId: order.id,
    amount: 100,
    paymentMethod: "cod",
    paymentType: "full",
    status: "succeeded",
    metadata: null,
    stripeChargeId: null,
    sslcommerzBankTranId: null,
    polarCheckoutId: null,
  };
  const refundAttempt = {
    id: "rfa_refund_ord_refund_cas_7_1",
    orderId: order.id,
    refundPaymentId: "refund_ord_refund_cas_7_1",
    providerRefundId: "refund_gateway_1",
  };
  const refundPayment = {
    paymentType: "refund",
    status: "refunded",
    amount: 100,
  };
  const selectResults = [order, null, null, [payment], [], [refundAttempt], order, [payment, refundPayment]];
  let selectIndex = 0;
  let updateIndex = 0;

  return {
    select: vi.fn(() => createChain(selectResults[selectIndex++])),
    insert: vi.fn(() => createChain([{ id: "refund_ord_refund_cas_7" }])),
    update: vi.fn(() => {
      updateIndex += 1;
      return createChain(updateIndex === 6 ? [] : [{ id: order.id, version: 9 }]);
    }),
    delete: vi.fn(() => createChain(undefined)),
    batch: vi.fn(async () => [
      [{ id: "refund_ord_refund_cas_7" }],
      [{ id: order.id, version: 8 }],
    ]),
  };
}

function createAlreadyReturnedDb() {
  const order = {
    id: "ord_return_cas",
    status: OrderStatus.RETURNED,
    paymentStatus: PaymentStatus.PAID,
    version: 5,
  };

  const selectResults = [order, null, null];
  let selectIndex = 0;

  return {
    select: vi.fn(() => createChain(selectResults[selectIndex++])),
    update: vi.fn(() => createChain([{ id: order.id }])),
  };
}

function createAlreadyRefundedCancelledDb() {
  const order = {
    id: "ord_refund_cas",
    totalAmount: 100,
    paidAmount: 0,
    paymentStatus: PaymentStatus.REFUNDED,
    paymentMethod: "cod",
    status: OrderStatus.CANCELLED,
    version: 9,
  };

  return {
    select: vi.fn(() => createChain(order)),
    update: vi.fn(() => createChain([{ id: order.id }])),
  };
}

function createAlreadyRefundedCancelledDeductedDb() {
  const order = {
    id: "ord_refund_cas",
    totalAmount: 100,
    paidAmount: 0,
    paymentStatus: PaymentStatus.REFUNDED,
    paymentMethod: "cod",
    status: OrderStatus.CANCELLED,
    inventoryAction: "deducted",
    version: 9,
  };

  return {
    select: vi.fn(() => createChain(order)),
    update: vi.fn(() => createChain([{ id: order.id }])),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("refund validation", () => {
  describe("guard checks", () => {
    it("rejects refund on UNPAID order", () => {
      const result = validateRefund({
        totalAmount: 2500,
        paidAmount: 0,
        paymentStatus: PaymentStatus.UNPAID,
        paymentMethod: "stripe",
        status: OrderStatus.PENDING,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain("no payments to refund");
    });

    it("rejects refund on FAILED payment order", () => {
      const result = validateRefund({
        totalAmount: 2500,
        paidAmount: 0,
        paymentStatus: PaymentStatus.FAILED,
        paymentMethod: "stripe",
        status: OrderStatus.PENDING,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain("no payments to refund");
    });

    it("rejects refund on already REFUNDED order", () => {
      const result = validateRefund({
        totalAmount: 2500,
        paidAmount: 0,
        paymentStatus: PaymentStatus.REFUNDED,
        paymentMethod: "stripe",
        status: OrderStatus.CANCELLED,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain("already fully refunded");
    });
  });

  describe("amount validation", () => {
    it("rejects refund amount exceeding paidAmount", () => {
      const result = validateRefund(
        {
          totalAmount: 2500,
          paidAmount: 1000,
          paymentStatus: PaymentStatus.PARTIAL,
          paymentMethod: "stripe",
          status: OrderStatus.PENDING,
        },
        1500 // More than paidAmount
      );

      expect(result.valid).toBe(false);
      expect(result.error).toContain("exceeds paid amount");
    });

    it("accepts refund equal to paidAmount (full refund)", () => {
      const result = validateRefund(
        {
          totalAmount: 2500,
          paidAmount: 2500,
          paymentStatus: PaymentStatus.PAID,
          paymentMethod: "stripe",
          status: OrderStatus.CONFIRMED,
        },
        2500
      );

      expect(result.valid).toBe(true);
      expect(result.isFullRefund).toBe(true);
      expect(result.newPaidAmount).toBe(0);
      expect(result.newPaymentStatus).toBe(PaymentStatus.REFUNDED);
    });

    it("accepts partial refund within paidAmount", () => {
      const result = validateRefund(
        {
          totalAmount: 2500,
          paidAmount: 2500,
          paymentStatus: PaymentStatus.PAID,
          paymentMethod: "stripe",
          status: OrderStatus.CONFIRMED,
        },
        500
      );

      expect(result.valid).toBe(true);
      expect(result.isFullRefund).toBe(false);
      expect(result.newPaidAmount).toBe(2000);
      expect(result.newPaymentStatus).toBe(PaymentStatus.PARTIAL);
    });

    it("defaults to full refund when no amount specified", () => {
      const result = validateRefund({
        totalAmount: 2500,
        paidAmount: 2500,
        paymentStatus: PaymentStatus.PAID,
        paymentMethod: "stripe",
        status: OrderStatus.CONFIRMED,
      });

      expect(result.valid).toBe(true);
      expect(result.isFullRefund).toBe(true);
      expect(result.refundAmount).toBe(2500);
    });
  });

  describe("inventory release on refund", () => {
    it("cancels and releases reserved inventory on pre-fulfillment full refund", () => {
      const result = validateRefund(
        {
          totalAmount: 2500,
          paidAmount: 2500,
          paymentStatus: PaymentStatus.PAID,
          paymentMethod: "stripe",
          status: OrderStatus.CONFIRMED,
        },
        2500
      );

      expect(result.nextOrderStatus).toBe(OrderStatus.CANCELLED);
      expect(result.shouldReleaseInventory).toBe(true);
    });

    it("does NOT restore inventory when a shipped order is fully refunded", () => {
      const result = validateRefund(
        {
          totalAmount: 2500,
          paidAmount: 2500,
          paymentStatus: PaymentStatus.PAID,
          paymentMethod: "stripe",
          status: OrderStatus.SHIPPED,
        },
        2500
      );

      expect(result.nextOrderStatus).toBeUndefined();
      expect(result.shouldReleaseInventory).toBe(false);
    });

    it("marks delivered full refunds as refunded without direct inventory release", () => {
      const result = validateRefund(
        {
          totalAmount: 2500,
          paidAmount: 2500,
          paymentStatus: PaymentStatus.PAID,
          paymentMethod: "stripe",
          status: OrderStatus.DELIVERED,
        },
        2500
      );

      expect(result.nextOrderStatus).toBe(OrderStatus.REFUNDED);
      expect(result.shouldReleaseInventory).toBe(false);
    });

    it("does NOT release inventory on partial refund", () => {
      const result = validateRefund(
        {
          totalAmount: 2500,
          paidAmount: 2500,
          paymentStatus: PaymentStatus.PAID,
          paymentMethod: "stripe",
          status: OrderStatus.CONFIRMED,
        },
        500
      );

      expect(result.shouldReleaseInventory).toBe(false);
    });
  });

  describe("cumulative refunds", () => {
    it("handles sequential partial refunds correctly", () => {
      let order: OrderRefundState = {
        totalAmount: 3000,
        paidAmount: 3000,
        paymentStatus: PaymentStatus.PAID,
        paymentMethod: "stripe",
        status: OrderStatus.CONFIRMED,
      };

      // First partial refund: 1000
      let result = validateRefund(order, 1000);
      expect(result.valid).toBe(true);
      expect(result.isFullRefund).toBe(false);
      expect(result.newPaidAmount).toBe(2000);
      expect(result.shouldReleaseInventory).toBe(false);

      // Apply the refund
      order = {
        ...order,
        paidAmount: result.newPaidAmount,
        paymentStatus: result.newPaymentStatus,
      };

      // Second partial refund: 1000
      result = validateRefund(order, 1000);
      expect(result.valid).toBe(true);
      expect(result.isFullRefund).toBe(false);
      expect(result.newPaidAmount).toBe(1000);
      expect(result.shouldReleaseInventory).toBe(false);

      // Apply the refund
      order = {
        ...order,
        paidAmount: result.newPaidAmount,
        paymentStatus: result.newPaymentStatus,
      };

      // Third refund: remaining 1000 (full refund)
      result = validateRefund(order, 1000);
      expect(result.valid).toBe(true);
      expect(result.isFullRefund).toBe(true);
      expect(result.newPaidAmount).toBe(0);
      expect(result.newPaymentStatus).toBe(PaymentStatus.REFUNDED);
      expect(result.shouldReleaseInventory).toBe(true);
    });

    it("rejects cumulative refund exceeding paid amount", () => {
      const order: OrderRefundState = {
        totalAmount: 3000,
        paidAmount: 1000, // After previous refunds
        paymentStatus: PaymentStatus.PARTIAL,
        paymentMethod: "stripe",
        status: OrderStatus.CONFIRMED,
      };

      const result = validateRefund(order, 1500);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("exceeds paid amount");
    });
  });

  describe("concurrency claim before provider dispatch", () => {
    it("does not call the provider when the order-version CAS loses", () => {
      const state: RefundClaimState = {
        orderVersion: 8,
        paidAmount: 100,
        paymentStatus: PaymentStatus.PAID,
        pendingRefund: false,
      };

      const result = claimRefundBeforeProvider(state, 7, 100);

      expect(result.claimed).toBe(false);
      expect(result.shouldCallProvider).toBe(false);
      expect(result.shouldCleanupClaim).toBe(true);
      expect(result.error).toBe("cas_conflict");
      expect(result.nextState).toEqual(state);
    });

    it("blocks a second refund while the first refund claim is pending", () => {
      const first = claimRefundBeforeProvider({
        orderVersion: 7,
        paidAmount: 100,
        paymentStatus: PaymentStatus.PAID,
        pendingRefund: false,
      }, 7, 100);

      expect(first.shouldCallProvider).toBe(true);

      const second = claimRefundBeforeProvider(first.nextState, 8, 100);

      expect(second.claimed).toBe(false);
      expect(second.shouldCallProvider).toBe(false);
      expect(second.error).toBe("pending_refund");
    });

    it("reserves refundable amount before provider dispatch", () => {
      const result = claimRefundBeforeProvider({
        orderVersion: 3,
        paidAmount: 100,
        paymentStatus: PaymentStatus.PAID,
        pendingRefund: false,
      }, 3, 40);

      expect(result.claimed).toBe(true);
      expect(result.shouldCallProvider).toBe(true);
      expect(result.nextState).toMatchObject({
        orderVersion: 4,
        paidAmount: 60,
        paymentStatus: PaymentStatus.PARTIAL,
        pendingRefund: true,
      });
    });

    it("releases the local claim when provider refund fails", () => {
      const claimed = claimRefundBeforeProvider({
        orderVersion: 3,
        paidAmount: 100,
        paymentStatus: PaymentStatus.PAID,
        pendingRefund: false,
      }, 3, 40);

      const released = releaseFailedProviderClaim(claimed.nextState, 40, PaymentStatus.PAID);

      expect(released).toEqual({
        orderVersion: 5,
        paidAmount: 100,
        paymentStatus: PaymentStatus.PAID,
        pendingRefund: false,
      });
    });

    it("keeps the reserved amount after provider refund succeeds", () => {
      const claimed = claimRefundBeforeProvider({
        orderVersion: 3,
        paidAmount: 100,
        paymentStatus: PaymentStatus.PAID,
        pendingRefund: false,
      }, 3, 100);

      const finalized = finalizeSuccessfulProviderClaim(claimed.nextState);

      expect(finalized).toMatchObject({
        orderVersion: 4,
        paidAmount: 0,
        paymentStatus: PaymentStatus.REFUNDED,
        pendingRefund: false,
      });
    });
  });

  describe("status CAS before inventory restoration", () => {
    it("does not restore inventory for a pre-fulfillment full refund when status CAS loses", () => {
      const state: StatusInventoryState = {
        orderVersion: 11,
        status: OrderStatus.CONFIRMED,
        inventoryRestored: false,
      };

      const nextStatus = getOrderStatusAfterRefund(state.status, true);
      const result = applyStatusCasBeforeInventory(
        state,
        10,
        nextStatus ?? state.status,
        shouldReleaseInventoryForFullRefund(state.status, nextStatus),
      );

      expect(nextStatus).toBe(OrderStatus.CANCELLED);
      expect(result.statusChanged).toBe(false);
      expect(result.inventoryRestored).toBe(false);
      expect(result.nextState).toEqual(state);
    });

    it("restores inventory for a pre-fulfillment full refund only after status CAS wins", () => {
      const state: StatusInventoryState = {
        orderVersion: 10,
        status: OrderStatus.CONFIRMED,
        inventoryRestored: false,
      };

      const nextStatus = getOrderStatusAfterRefund(state.status, true);
      const result = applyStatusCasBeforeInventory(
        state,
        10,
        nextStatus ?? state.status,
        shouldReleaseInventoryForFullRefund(state.status, nextStatus),
      );

      expect(result.statusChanged).toBe(true);
      expect(result.inventoryRestored).toBe(true);
      expect(result.nextState).toMatchObject({
        orderVersion: 11,
        status: OrderStatus.CANCELLED,
        inventoryRestored: true,
      });
    });

    it("does not restore inventory for a return when status CAS loses", () => {
      const state: StatusInventoryState = {
        orderVersion: 6,
        status: OrderStatus.DELIVERED,
        inventoryRestored: false,
      };

      const result = applyStatusCasBeforeInventory(
        state,
        5,
        OrderStatus.RETURNED,
        true,
      );

      expect(result.statusChanged).toBe(false);
      expect(result.inventoryRestored).toBe(false);
      expect(result.nextState).toEqual(state);
    });
  });

  describe("processRefund/processReturn inventory atomicity", () => {
    it("does not call return inventory restoration when the RETURNED status CAS loses", async () => {
      const applyInventoryForStatusChange = vi.fn();
      const { processReturn } = await importRefundServiceWithMocks({
        applyInventoryForStatusChange,
      });
      const db = createReturnDbWithLostStatusCas();

      await expect(processReturn(db as never, undefined, {
        orderId: "ord_return_cas",
        reason: "Customer returned package",
        autoRefund: false,
      })).rejects.toThrow("Order was modified by another request");

      expect(applyInventoryForStatusChange).not.toHaveBeenCalled();
    });

    it("does not call refund inventory release when the cancellation status CAS loses", async () => {
      const applyInventoryForStatusChange = vi.fn();
      const createRefund = vi.fn(async () => ({ refundId: "refund_gateway_1" }));
      const { processRefund } = await importRefundServiceWithMocks({
        applyInventoryForStatusChange,
        createRefund,
      });
      const db = createRefundDbWithLostStatusCas();

      await expect(processRefund(db as never, undefined, {
        orderId: "ord_refund_cas",
        reason: "Customer cancelled before fulfillment",
        gateway: "cod",
      })).rejects.toThrow("Refund payment was accepted, but local order reconciliation lost a concurrent update.");

      expect(createRefund).toHaveBeenCalledOnce();
      expect(applyInventoryForStatusChange).not.toHaveBeenCalled();
    });

    it("reconciles return inventory when retry sees the order already returned", async () => {
      const applyInventoryForStatusChange = vi.fn();
      const { processReturn } = await importRefundServiceWithMocks({
        applyInventoryForStatusChange,
      });
      const db = createAlreadyReturnedDb();

      await expect(processReturn(db as never, undefined, {
        orderId: "ord_return_cas",
        reason: "Customer returned package",
        autoRefund: false,
      })).resolves.toEqual({});

      expect(db.update).not.toHaveBeenCalled();
      expect(applyInventoryForStatusChange).toHaveBeenCalledWith(
        db,
        "ord_return_cas",
        OrderStatus.RETURNED,
      );
    });

    it("reconciles pre-fulfillment refund inventory when retry sees the order already cancelled and refunded", async () => {
      const applyInventoryForStatusChange = vi.fn();
      const createRefund = vi.fn();
      const { processRefund } = await importRefundServiceWithMocks({
        applyInventoryForStatusChange,
        createRefund,
      });
      const db = createAlreadyRefundedCancelledDb();

      await expect(processRefund(db as never, undefined, {
        orderId: "ord_refund_cas",
        reason: "Customer cancelled before fulfillment",
        gateway: "cod",
      })).resolves.toMatchObject({
        success: true,
        amount: 0,
        isFullRefund: true,
      });

      expect(createRefund).not.toHaveBeenCalled();
      expect(applyInventoryForStatusChange).toHaveBeenCalledWith(
        db,
        "ord_refund_cas",
        OrderStatus.CANCELLED,
      );
    });

    it("does not auto-restore deducted inventory for an already-cancelled fulfilled refund retry", async () => {
      const applyInventoryForStatusChange = vi.fn();
      const createRefund = vi.fn();
      const { processRefund } = await importRefundServiceWithMocks({
        applyInventoryForStatusChange,
        createRefund,
      });
      const db = createAlreadyRefundedCancelledDeductedDb();

      await expect(processRefund(db as never, undefined, {
        orderId: "ord_refund_cas",
        reason: "Customer cancelled after fulfillment",
        gateway: "cod",
      })).rejects.toThrow("Order is already fully refunded");

      expect(createRefund).not.toHaveBeenCalled();
      expect(applyInventoryForStatusChange).not.toHaveBeenCalled();
    });
  });
});
