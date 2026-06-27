import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "@scalius/core/errors";
import { codTracking, orders, orderPayments } from "@scalius/database/schema";
import { markCODReturned, recordCODCollection, validateCODCollectionDetails } from "./cod";

function createCodDbMock({
  selectedOrder,
  selectedPayment = null,
  selectedTracking = null,
  updateResults = [{ id: "cod_1" }],
}: {
  selectedOrder: Record<string, unknown> | null;
  selectedPayment?: Record<string, unknown> | null;
  selectedTracking?: Record<string, unknown> | null;
  updateResults?: Array<{ id: string }>;
}) {
  const updates: Array<Record<string, unknown>> = [];
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
        values(values: unknown) {
          return values;
        },
      };
    },
    batch: vi.fn(async (statements: unknown[]) => {
      batches.push(statements);
      return statements;
    }),
  };

  return { db, batches, updates };
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
});

describe("recordCODCollection", () => {
  it("fails closed when a new COD collection has no tracking row", async () => {
    const { db, batches } = createCodDbMock({
      selectedOrder: {
        id: "order_1",
        totalAmount: 100,
        paidAmount: 0,
        balanceDue: 100,
      },
      selectedTracking: null,
    });

    await expect(recordCODCollection(db as never, {
      orderId: "order_1",
      collectedBy: "Courier A",
      collectedAmount: 100,
    })).rejects.toThrow("COD tracking record is missing");

    expect(batches).toHaveLength(0);
  });

  it("does not treat existing COD payment as idempotent without collected tracking", async () => {
    const { db, batches } = createCodDbMock({
      selectedOrder: {
        id: "order_1",
        totalAmount: 100,
        paidAmount: 100,
        balanceDue: 0,
      },
      selectedPayment: {
        id: "pay_1",
        amount: 100,
      },
      selectedTracking: null,
    });

    await expect(recordCODCollection(db as never, {
      orderId: "order_1",
      collectedBy: "Courier A",
      collectedAmount: 100,
    })).rejects.toThrow("collected tracking is missing");

    expect(batches).toHaveLength(0);
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
