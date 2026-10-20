// reserveStockBatch: audit grouping and strict, deterministic movement claims.

import { describe, it, expect, vi } from "vitest";
import { groupReservationMovementsForAudit, reserveStockBatch } from "../../../../packages/core/src/modules/inventory/reserve";
import { inventoryMovements, productVariants } from "../../../../packages/database/src/schema";

// Keep the inventory batch observable without reproducing the catalog SQL builder.
// catalog-projections.d1.test.ts verifies the real refresh against migrated SQLite.
vi.mock("../../../../packages/core/src/modules/products/catalog-projections", () => ({
  catalogBuyerStateRefreshStatementsForSkus: (_db: unknown, skuIds: readonly string[]) => [
    { kind: "refreshBuyerState", skuIds },
  ],
}));

interface Variant {
  id: string;
  stock: number;
  reservedStock: number;
  preorderStock: number;
  allowPreorder: boolean;
  allowBackorder: boolean;
  backorderLimit: number;
  version: number;
}

describe("batch reservation audit grouping", () => {
  it("keeps separate movement entries for different orders sharing the same variant", () => {
    const grouped = groupReservationMovementsForAudit([
      { variantId: "var_a", quantity: 2, orderId: "ord_1" },
      { variantId: "var_a", quantity: 3, orderId: "ord_2" },
      { variantId: "var_a", quantity: 1, orderId: "ord_1" },
    ]);

    expect(grouped).toEqual([
      { variantId: "var_a", quantity: 3, orderId: "ord_1" },
      { variantId: "var_a", quantity: 3, orderId: "ord_2" },
    ]);
  });
});

function createReserveStockBatchDb(options: {
  variant?: Variant | null;
  releaseCount?: number;
  batchError?: Error;
  existingMovements?: Array<{
    id: string;
    variantId: string;
    orderId: string | null;
    type: string;
    quantity: number;
  }>;
  insertResults?: Array<Array<{ id: string }>>;
  updateResults?: Array<Array<{ id: string }>>;
} = {}) {
  const batchCalls: unknown[][] = [];
  const variant = options.variant ?? {
    id: "var_a",
    stock: 10,
    reservedStock: 0,
    preorderStock: 0,
    allowPreorder: false,
    allowBackorder: false,
    backorderLimit: 0,
    version: 4,
  };
  const insertResults = [...(options.insertResults ?? [])];
  const updateResults = [...(options.updateResults ?? [])];

  const db = {
    select(projection: Record<string, unknown>) {
      const query = {
        where() {
          return {
            get: async () => {
              if ("count" in projection) return { count: options.releaseCount ?? 0 };
              return null;
            },
            all: async () => {
              if ("stock" in projection) {
                return variant
                  ? [{
                      id: variant.id,
                      stock: variant.stock,
                      reservedStock: variant.reservedStock,
                      preorderStock: variant.preorderStock,
                      allowPreorder: variant.allowPreorder,
                      allowBackorder: variant.allowBackorder,
                      backorderLimit: variant.backorderLimit,
                      trackInventory: true,
                      stockVersion: variant.version,
                    }]
                  : [];
              }
              return options.existingMovements ?? [];
            },
          };
        },
      };
      return {
        from() {
          return {
            ...query,
            ...("batchGuard" in projection ? { kind: "batchGuard" as const } : {}),
            innerJoin() {
              return query;
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        select(statement: unknown) {
          return {
            returning() {
              return { kind: "insertMovement" as const, table, statement };
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
                  return { kind: "updateVariant" as const, table, values };
                },
              };
            },
          };
        },
      };
    },
    delete(table: unknown) {
      return {
        where() {
          return { kind: "deleteMovement" as const, table };
        },
      };
    },
    batch: async (statements: Array<{ kind?: string; table?: unknown }>) => {
      batchCalls.push(statements);
      if (options.batchError) throw options.batchError;
      return statements.map((statement) => {
        if (statement.kind === "insertMovement") {
          return insertResults.shift() ?? [{ id: "movement_1" }];
        }
        if (statement.kind === "updateVariant") {
          return updateResults.shift() ?? [{ id: "var_a" }];
        }
        return [];
      });
    },
  };

  return { db, batchCalls };
}

describe("reserveStockBatch strict movement claims", () => {
  it("writes the reservation movement claim and stock counter update in one batch", async () => {
    const { db, batchCalls } = createReserveStockBatchDb();

    const result = await reserveStockBatch(
      db as never,
      [{ variantId: "var_a", quantity: 2, orderId: "order_1" }],
      "regular",
      { reservationKey: "checkout-ingest:v1" },
    );

    expect(result.success).toBe(true);
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toEqual([
      expect.objectContaining({ kind: "batchGuard" }),
      expect.objectContaining({ kind: "insertMovement", table: inventoryMovements }),
      expect.objectContaining({ kind: "updateVariant", table: productVariants }),
      expect.objectContaining({ kind: "refreshBuyerState", skuIds: ["var_a"] }),
    ]);
  });

  it("treats an exact duplicate deterministic movement claim as idempotent success", async () => {
    const { db, batchCalls } = createReserveStockBatchDb({
      batchError: new Error("D1_ERROR: UNIQUE constraint failed: inventory_movements.id reservation:claim_1"),
      existingMovements: [
        {
          id: "reservation:claim_1",
          variantId: "var_a",
          orderId: "order_1",
          type: "reserved",
          quantity: 2,
        },
      ],
    });

    const result = await reserveStockBatch(
      db as never,
      [{ variantId: "var_a", quantity: 2, orderId: "order_1", movementId: "reservation:claim_1" }],
      "regular",
    );

    expect(result.success).toBe(true);
    expect(batchCalls).toHaveLength(1);
  });

  it("fails closed when a duplicate deterministic claim has different contents", async () => {
    const { db } = createReserveStockBatchDb({
      batchError: new Error("D1_ERROR: UNIQUE constraint failed: inventory_movements.id reservation:claim_1"),
      existingMovements: [
        {
          id: "reservation:claim_1",
          variantId: "var_a",
          orderId: "order_1",
          type: "reserved",
          quantity: 1,
        },
      ],
    });

    const result = await reserveStockBatch(
      db as never,
      [{ variantId: "var_a", quantity: 2, orderId: "order_1", movementId: "reservation:claim_1" }],
      "regular",
    );

    expect(result).toMatchObject({
      success: false,
      manualReconciliationRequired: true,
      error: "Reservation claim mismatch requires manual inventory reconciliation",
    });
  });
});
