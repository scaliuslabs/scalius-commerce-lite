import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  inventoryMovements,
  inventoryOperations,
  productVariants,
} from "@scalius/database/schema";
import {
  buildInventoryOperationRequestHash,
  executeInventoryOperation,
  type InventoryOperationInput,
} from "./inventory-operations";
import { checkAndAlertLowStock } from "./alerts";

// The fake databases here carry no projection SQL; catalog-projections.d1.test.ts covers it.
vi.mock("../products/catalog-projections", () => ({ catalogBuyerStateRefreshStatementsForSkus: () => [] }));

vi.mock("./alerts", () => ({
  checkAndAlertLowStock: vi.fn(),
}));

// One location holding all of the SKU's stock; the D1 tests cover levels.
vi.mock("./locations", async (importActual) => ({
  ...(await importActual<typeof import("./locations")>()),
  selectActiveLocationOnHand: vi.fn(() => ({ kind: "select", table: "location" })),
}));

type StoredOperation = { requestHash: string; resultPayload: string };
type Statement = { kind: "insert" | "update" | "select"; table: unknown };

const baseInput: InventoryOperationInput = {
  operationKey: "invop_core_operation_0001",
  operationType: "manual_adjustment",
  variantId: "variant_1",
  pool: "stock",
  mode: "relative",
  delta: 3,
  reason: "received",
  notes: "supplier delivery",
};

function createOperationDb(options: {
  operation?: StoredOperation | null;
  batchResults?: unknown[][][];
  batchError?: Error;
  operationAfterBatchError?: StoredOperation;
} = {}) {
  let operation = options.operation ?? null;
  const batches: Statement[][] = [];
  const results = [...(options.batchResults ?? [
    [
      [{ id: "movement_1" }],
      [{ operationKey: baseInput.operationKey }],
      [{ id: "variant_1" }],
    ],
  ])];
  const variant = {
    id: "variant_1",
    stock: 5,
    reservedStock: 1,
    preorderStock: 0,
    stockVersion: 7,
  };

  const db = {
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              return {
                kind: "select" as const,
                table,
                get: async () => table === inventoryOperations ? operation : variant,
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        select() {
          return {
            returning() {
              return { kind: "insert" as const, table };
            },
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set() {
          return {
            where() {
              return {
                returning() {
                  return { kind: "update" as const, table };
                },
              };
            },
          };
        },
      };
    },
    async batch(statements: Statement[]) {
      // The operation's read batch (its key, the SKU, the location): answered from the fake rows, not counted as a write.
      if (statements.every((statement) => statement.kind === "select")) {
        return statements.map((statement) => statement.table === inventoryOperations
          ? (operation ? [operation] : [])
          : statement.table === productVariants
            ? [variant]
            : [{ id: "loc_default", name: "Main location", status: "active", onHand: 5 }]);
      }
      batches.push(statements);
      if (options.batchError) {
        operation = options.operationAfterBatchError ?? operation;
        throw options.batchError;
      }
      return results.shift() ?? [];
    },
  };

  return { db, batches, setOperation: (value: StoredOperation | null) => { operation = value; } };
}

describe("merchant inventory operation idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("commits movement, operation result, and stockVersion CAS in one batch", async () => {
    const { db, batches } = createOperationDb();

    await expect(executeInventoryOperation(db as never, baseInput, "admin_1"))
      .resolves.toEqual({
        variantId: "variant_1",
        previousStock: 5,
        newStock: 8,
        delta: 3,
        locationId: "loc_default",
        locationPreviousStock: 5,
        locationNewStock: 8,
      });

    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([
      expect.objectContaining({ kind: "insert", table: inventoryMovements }),
      expect.objectContaining({ kind: "insert", table: inventoryOperations }),
      expect.objectContaining({ kind: "update", table: productVariants }),
      // The guard that the SKU is not digital (its stock is its licence keys).
      expect.anything(),
    ]);
    expect(checkAndAlertLowStock).toHaveBeenCalledWith(db, "variant_1");
  });

  it("carries readAfter reads at the end of the commit batch and keeps their rows", async () => {
    const readAfter = { statements: [{ kind: "select", table: "after" }] as never[], rows: undefined as unknown[] | undefined };
    const { db, batches } = createOperationDb({
      batchResults: [[
        [{ id: "movement_1" }],
        [{ operationKey: baseInput.operationKey }],
        [{ id: "variant_1" }],
        [],
        [{ id: "variant_1", stock: 8 }],
      ]],
    });

    await executeInventoryOperation(db as never, baseInput, "admin_1", { readAfter });

    expect(batches[0]?.at(-1)).toEqual({ kind: "select", table: "after" });
    expect(readAfter.rows).toEqual([[{ id: "variant_1", stock: 8 }]]);
  });

  it("returns the exact committed result without another batch on replay", async () => {
    const requestHash = await buildInventoryOperationRequestHash(baseInput);
    const committedResult = {
      variantId: "variant_1",
      previousStock: 5,
      newStock: 8,
      delta: 3,
    };
    const { db, batches } = createOperationDb({
      operation: {
        requestHash,
        resultPayload: JSON.stringify(committedResult),
      },
    });

    await expect(executeInventoryOperation(db as never, baseInput, "admin_2"))
      .resolves.toEqual(committedResult);
    expect(batches).toHaveLength(0);
  });

  it("fails closed when the same operation key carries a changed payload", async () => {
    const requestHash = await buildInventoryOperationRequestHash(baseInput);
    const { db, batches } = createOperationDb({
      operation: {
        requestHash,
        resultPayload: JSON.stringify({
          variantId: "variant_1",
          previousStock: 5,
          newStock: 8,
          delta: 3,
        }),
      },
    });

    await expect(executeInventoryOperation(db as never, {
      ...baseInput,
      delta: 4,
    })).rejects.toThrow(/already used for a different request/i);
    expect(batches).toHaveLength(0);
  });

  it("resolves a unique-key race by replaying the winner", async () => {
    const requestHash = await buildInventoryOperationRequestHash(baseInput);
    const committedResult = {
      variantId: "variant_1",
      previousStock: 5,
      newStock: 8,
      delta: 3,
    };
    const { db, batches } = createOperationDb({
      batchError: new Error("UNIQUE constraint failed: inventory_operations.operation_key"),
      operationAfterBatchError: {
        requestHash,
        resultPayload: JSON.stringify(committedResult),
      },
    });

    await expect(executeInventoryOperation(db as never, baseInput))
      .resolves.toEqual(committedResult);
    expect(batches).toHaveLength(1);
  });

  it("retries a stockVersion race without leaving a standalone operation", async () => {
    const { db, batches } = createOperationDb({
      batchResults: [
        [[], [], []],
        [
          [{ id: "movement_1" }],
          [{ operationKey: baseInput.operationKey }],
          [{ id: "variant_1" }],
        ],
      ],
    });

    await expect(executeInventoryOperation(db as never, baseInput))
      .resolves.toMatchObject({ newStock: 8, delta: 3 });
    expect(batches).toHaveLength(2);
  });

  it("persists a no-op stocktake replay result without inventing a movement", async () => {
    const stocktake: InventoryOperationInput = {
      operationKey: "invop_core_stocktake_0001",
      operationType: "stocktake",
      variantId: "variant_1",
      pool: "stock",
      mode: "stocktake",
      newStock: 5,
      reason: "cycle count",
    };
    const { db, batches } = createOperationDb({
      batchResults: [[[{ operationKey: stocktake.operationKey }]]],
    });

    await expect(executeInventoryOperation(db as never, stocktake))
      .resolves.toEqual({
        variantId: "variant_1",
        previousStock: 5,
        newStock: 5,
        delta: 0,
        locationId: "loc_default",
        locationPreviousStock: 5,
        locationNewStock: 5,
      });
    expect(batches[0]).toEqual([
      expect.objectContaining({ kind: "insert", table: inventoryOperations }),
    ]);
  });

  it("refuses a location for preorder stock, which is held nowhere", async () => {
    const { db, batches } = createOperationDb();
    await expect(executeInventoryOperation(db as never, {
      ...baseInput,
      pool: "preorderStock",
      locationId: "loc_other",
    })).rejects.toThrow(/isn't held at a location/);
    expect(batches).toHaveLength(0);
  });

  it("includes mode, variant, quantity, reason, notes, pool, and location in the canonical hash", async () => {
    const original = await buildInventoryOperationRequestHash(baseInput);
    await expect(buildInventoryOperationRequestHash({
      ...baseInput,
      operationKey: "invop_core_operation_9999",
    })).resolves.toBe(original);
    for (const changed of [
      { ...baseInput, variantId: "variant_2" },
      { ...baseInput, delta: 4 },
      { ...baseInput, reason: "correction" },
      { ...baseInput, notes: "different note" },
      { ...baseInput, pool: "preorderStock" as const },
      { ...baseInput, locationId: "loc_other" },
      {
        operationKey: baseInput.operationKey,
        operationType: "stocktake" as const,
        variantId: baseInput.variantId,
        pool: "stock" as const,
        mode: "stocktake" as const,
        newStock: 8,
        reason: baseInput.reason,
        notes: baseInput.notes,
      },
    ]) {
      await expect(buildInventoryOperationRequestHash(changed))
        .resolves.not.toBe(original);
    }
  });
});
