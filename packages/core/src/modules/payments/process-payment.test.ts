import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrderStatus, PaymentRecordStatus, PaymentStatus } from "@scalius/database/schema";

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
        { paidAmount: 0, paymentStatus: PaymentStatus.UNPAID },
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
    await releaseOrderInventory({ id: "db" } as never, "order_1");

    expect(mocks.applyInventoryForStatusChange).toHaveBeenCalledWith(
      { id: "db" },
      "order_1",
      OrderStatus.CANCELLED,
    );
  });
});
