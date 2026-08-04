import { describe, expect, it } from "vitest";
import { inventoryMovements, productVariants } from "@scalius/database/schema";
import { releaseExpiredReservations } from "./expiry";

type ExpiredReservation = {
  variantId: string;
  orderId: string;
  reservationType: "reserved" | "preorder_reserved";
  totalQuantity: number;
  pool?: "regular" | "preorder" | "backorder" | null;
  reservationGeneration?: number | null;
};

type MockStatement =
  | { kind: "insert"; table: unknown; query: unknown }
  | { kind: "update"; table: unknown; values: Record<string, unknown> };

function createDbMock(options: {
  expiredReservations: ExpiredReservation[];
  orderExists?: boolean;
  terminalMovementExists?: boolean;
  reservedQuantity?: number;
  terminalQuantity?: number;
  variant?: {
    stock: number;
    reservedStock: number;
    preorderStock: number;
    trackInventory?: boolean;
    allowPreorder?: boolean;
    lowStockThreshold?: number | null;
  } | null;
  batchError?: Error;
}) {
  const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const inserts: Array<{ table: unknown; query: unknown }> = [];
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
                    having() {
                      return this;
                    },
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
                  if ("reservedQuantity" in projection) {
                    const reservedQuantity = options.reservedQuantity
                      ?? options.expiredReservations[0]?.totalQuantity
                      ?? 0;
                    return {
                      reservedQuantity,
                      terminalQuantity: options.terminalQuantity
                        ?? (options.terminalMovementExists ? reservedQuantity : 0),
                    };
                  }
                  if ("reservedStock" in projection) {
                    return options.variant
                      ? {
                          stockVersion: 1,
                          trackInventory: true,
                          allowPreorder: false,
                          lowStockThreshold: null,
                          ...options.variant,
                        }
                      : null;
                  }
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
              return {
                returning() {
                  return { kind: "update" as const, table, values };
                },
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        select(query: unknown) {
          return {
            returning() {
              return { kind: "insert" as const, table, query };
            },
          };
        },
      };
    },
    batch: async (statements: MockStatement[]) => {
      if (options.batchError) throw options.batchError;
      batchCalls.push(statements);
      for (const statement of statements) {
        if (statement.kind === "insert") {
          inserts.push({ table: statement.table, query: statement.query });
        } else {
          updates.push({ table: statement.table, values: statement.values });
        }
      }
      return statements.map((statement) => [{
        id: statement.kind === "insert" ? "movement_1" : "variant_1",
      }]);
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
    });
  });

  it("reports only releases that cross a buyer-visible availability band", async () => {
    const { db } = createDbMock({
      expiredReservations,
      orderExists: false,
      variant: {
        stock: 2,
        reservedStock: 2,
        preorderStock: 0,
        lowStockThreshold: 5,
      },
    });

    await expect(releaseExpiredReservations(db as never, 30)).resolves.toMatchObject({
      releasedVariantIds: ["variant_1"],
      availabilityTransitionVariantIds: ["variant_1"],
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
    expect(inserts.every((insert) => insert.table === inventoryMovements)).toBe(true);
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

  it("releases only the outstanding quantity after a partial terminal movement", async () => {
    const { db, updates, inserts } = createDbMock({
      expiredReservations: [{
        variantId: "variant_1",
        orderId: "order_1",
        reservationType: "reserved",
        totalQuantity: 3,
      }],
      orderExists: false,
      reservedQuantity: 5,
      terminalQuantity: 2,
      variant: { stock: 10, reservedStock: 3, preorderStock: 0 },
    });

    const result = await releaseExpiredReservations(db as never, 30);

    expect(result).toMatchObject({ found: 1, released: 1, errors: [] });
    expect(updates).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      table: inventoryMovements,
    });
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
