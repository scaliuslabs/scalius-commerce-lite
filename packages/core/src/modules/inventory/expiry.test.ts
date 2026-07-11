import { describe, expect, it } from "vitest";
import { inventoryMovements, productVariants } from "@scalius/database/schema";
import { releaseExpiredReservations } from "./expiry";

type ExpiredReservation = {
  variantId: string;
  orderId: string;
  reservationType: "reserved" | "preorder_reserved";
  totalQuantity: number;
};

type MockStatement =
  | { kind: "insert"; table: unknown; values: Record<string, unknown> }
  | { kind: "update"; table: unknown; values: Record<string, unknown> };

function createDbMock(options: {
  expiredReservations: ExpiredReservation[];
  orderExists?: boolean;
  terminalMovementExists?: boolean;
  variant?: { stock: number; reservedStock: number; preorderStock: number } | null;
  batchError?: Error;
}) {
  const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const batchCalls: MockStatement[][] = [];

  const db = {
    select(projection: Record<string, unknown>) {
      return {
        from() {
          return {
            where() {
              return {
                groupBy() {
                  return {
                    orderBy() {
                      return {
                        limit(limit: number) {
                          return {
                            all: async () =>
                              options.expiredReservations.slice(0, limit),
                          };
                        },
                      };
                    },
                  };
                },
                get: async () => {
                  if ("id" in projection) return options.orderExists ? { id: "order_1" } : null;
                  if ("movementId" in projection) {
                    return options.terminalMovementExists ? { movementId: "movement_1" } : null;
                  }
                  if ("reservedStock" in projection) return options.variant ?? null;
                  return null;
                },
              };
            },
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where() {
              return { kind: "update" as const, table, values };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values: (values: Record<string, unknown>) =>
          ({ kind: "insert" as const, table, values }),
      };
    },
    batch: async (statements: MockStatement[]) => {
      if (options.batchError) throw options.batchError;
      batchCalls.push(statements);
      for (const statement of statements) {
        if (statement.kind === "insert") {
          inserts.push({ table: statement.table, values: statement.values });
        } else {
          updates.push({ table: statement.table, values: statement.values });
        }
      }
      return statements.map(() => []);
    },
  };

  return { db, updates, inserts, batchCalls };
}

describe("releaseExpiredReservations", () => {
  const expiredReservations = [
    {
      variantId: "variant_1",
      orderId: "order_1",
      reservationType: "reserved" as const,
      totalQuantity: 2,
    },
  ];

  it("does not release reservations for active live orders", async () => {
    const { db, updates, inserts } = createDbMock({
      expiredReservations,
      orderExists: true,
      variant: { stock: 10, reservedStock: 2, preorderStock: 0 },
    });

    const result = await releaseExpiredReservations(db as never, 30);

    expect(result).toMatchObject({
      found: 1,
      limit: 50,
      hasMore: false,
      released: 0,
      errors: [],
    });
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("releases orphaned reservations whose order row no longer exists", async () => {
    const { db, updates, inserts } = createDbMock({
      expiredReservations,
      orderExists: false,
      variant: { stock: 10, reservedStock: 2, preorderStock: 0 },
    });

    const result = await releaseExpiredReservations(db as never, 30);

    expect(result).toMatchObject({
      found: 1,
      released: 1,
      releasedVariantIds: ["variant_1"],
      errors: [],
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      table: productVariants,
    });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      table: inventoryMovements,
      values: {
        id: "expiry_release:order_1:variant_1",
        variantId: "variant_1",
        orderId: "order_1",
        type: "released",
        quantity: -2,
        previousStock: 10,
        newStock: 10,
      },
    });
  });

  it("restores preorder stock when an orphaned preorder reservation expires", async () => {
    const { db, updates, inserts } = createDbMock({
      expiredReservations: [{
        variantId: "variant_1",
        orderId: "order_1",
        reservationType: "preorder_reserved",
        totalQuantity: 3,
      }],
      orderExists: false,
      variant: { stock: 10, reservedStock: 3, preorderStock: 4 },
    });

    const result = await releaseExpiredReservations(db as never, 30);

    expect(result).toMatchObject({
      found: 1,
      released: 1,
      releasedVariantIds: ["variant_1"],
      errors: [],
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.values).toHaveProperty("preorderStock");
    expect(inserts[0]).toMatchObject({
      table: inventoryMovements,
      values: {
        id: "expiry_release:order_1:variant_1:preorder",
        type: "released",
        quantity: -3,
        previousStock: 4,
        newStock: 7,
      },
    });
  });

  it("separates regular and preorder expiry claims for the same order and variant", async () => {
    const { db, updates, inserts, batchCalls } = createDbMock({
      expiredReservations: [
        {
          variantId: "variant_1",
          orderId: "order_1",
          reservationType: "reserved",
          totalQuantity: 2,
        },
        {
          variantId: "variant_1",
          orderId: "order_1",
          reservationType: "preorder_reserved",
          totalQuantity: 3,
        },
      ],
      orderExists: false,
      variant: { stock: 10, reservedStock: 5, preorderStock: 4 },
    });

    const result = await releaseExpiredReservations(db as never, 30);

    expect(result).toMatchObject({
      found: 2,
      released: 2,
      releasedVariantIds: ["variant_1"],
      errors: [],
    });
    expect(batchCalls).toHaveLength(2);
    expect(updates).toHaveLength(2);
    expect(updates[0]?.values).not.toHaveProperty("preorderStock");
    expect(updates[1]?.values).toHaveProperty("preorderStock");
    expect(inserts.map((insert) => insert.values.id)).toEqual([
      "expiry_release:order_1:variant_1",
      "expiry_release:order_1:variant_1:preorder",
    ]);
  });

  it("skips release when an order appears between candidate selection and release", async () => {
    const { db, updates, inserts } = createDbMock({
      expiredReservations,
      orderExists: true,
      variant: { stock: 10, reservedStock: 2, preorderStock: 0 },
    });

    const result = await releaseExpiredReservations(db as never, 30);

    expect(result).toMatchObject({ found: 1, released: 0, errors: [] });
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("limits each sweep and reports when more expired reservations remain", async () => {
    const { db, updates, inserts, batchCalls } = createDbMock({
      expiredReservations: [
        { variantId: "variant_1", orderId: "order_1", reservationType: "reserved", totalQuantity: 2 },
        { variantId: "variant_2", orderId: "order_2", reservationType: "reserved", totalQuantity: 3 },
        { variantId: "variant_3", orderId: "order_3", reservationType: "reserved", totalQuantity: 4 },
      ],
      orderExists: false,
      variant: { stock: 10, reservedStock: 9, preorderStock: 0 },
    });

    const result = await releaseExpiredReservations(db as never, 30, {
      limit: 2,
    });

    expect(result).toMatchObject({
      found: 2,
      limit: 2,
      hasMore: true,
      released: 2,
      releasedVariantIds: ["variant_1", "variant_2"],
      errors: [],
    });
    expect(batchCalls).toHaveLength(2);
    expect(inserts).toHaveLength(2);
    expect(updates).toHaveLength(2);
  });

  it("skips candidates that were deducted or released after selection", async () => {
    const { db, updates, inserts } = createDbMock({
      expiredReservations,
      orderExists: false,
      terminalMovementExists: true,
      variant: { stock: 10, reservedStock: 2, preorderStock: 0 },
    });

    const result = await releaseExpiredReservations(db as never, 30);

    expect(result).toMatchObject({ found: 1, released: 0, errors: [] });
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("treats a duplicate deterministic expiry release claim as already handled", async () => {
    const { db, updates, inserts } = createDbMock({
      expiredReservations,
      orderExists: false,
      variant: { stock: 10, reservedStock: 2, preorderStock: 0 },
      batchError: new Error(
        "D1_ERROR: UNIQUE constraint failed: inventory_movements.id expiry_release:order_1:variant_1",
      ),
    });

    const result = await releaseExpiredReservations(db as never, 30);

    expect(result).toMatchObject({ found: 1, released: 0, errors: [] });
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });
});
