import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrderStatus, PaymentPlanStatus, PaymentRecordStatus, PaymentStatus } from "@scalius/database/schema";

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
        values: async (values: Record<string, unknown>) => {
          operations.push("insert");
          inserts.push(values);
          if (insertError) throw insertError;
        },
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

  return { db, operations, inserts, updates, batch };
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
    const { db, inserts, updates, batch } = createDbMock({
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
  });

  it("applies SSLCommerz balance payments with a distinct val_id even when tran_id is reused", async () => {
    const { db, inserts, updates, batch } = createDbMock({
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
  });

  it("applies a deposit payment only when the pending plan matches the incoming amount", async () => {
    const { db, inserts, updates, batch } = createDbMock({
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

    expect(result).toEqual({ success: true });
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(batch).not.toHaveBeenCalled();
    expect(mocks.getCurrencyConfig).not.toHaveBeenCalled();
  });

  it("does not rewrite duplicate failed gateway attempts", async () => {
    const { db, inserts, updates, batch } = createDbMock({
      selectGetResults: [
        { id: "pay_1", status: PaymentRecordStatus.FAILED },
      ],
    });

    await processPaymentFailed(db as never, "order_1", "stripe", "pi_1");

    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(batch).not.toHaveBeenCalled();
    expect(mocks.getCurrencyConfig).not.toHaveBeenCalled();
  });

  it("records a failed attempt before marking the order failed", async () => {
    const { db, operations, inserts, updates } = createDbMock({
      selectGetResults: [
        null,
        { paidAmount: 0, paymentStatus: PaymentStatus.UNPAID, shipmentClaimId: null, shipmentClaimExpiresAt: null },
      ],
    });

    await processPaymentFailed(db as never, "order_1", "sslcommerz", "tran_1");

    expect(operations).toEqual(["insert", "update"]);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      orderId: "order_1",
      amount: 0,
      status: PaymentRecordStatus.FAILED,
      sslcommerzTranId: "tran_1",
    });
    expect(updates).toContainEqual(expect.objectContaining({
      paymentStatus: PaymentStatus.FAILED,
    }));
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
});
