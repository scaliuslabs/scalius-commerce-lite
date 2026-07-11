import { beforeEach, describe, expect, it, vi } from "vitest";
import { inventoryMovements, productVariants } from "@scalius/database/schema";
import { adjustInventory } from "./inventory.service";
import { checkAndAlertLowStock } from "./alerts";

vi.mock("./alerts", () => ({
  checkAndAlertLowStock: vi.fn(),
}));

type MockStatement = {
  kind: "insert" | "update";
  table: unknown;
  values?: Record<string, unknown>;
};

function createInventoryAdjustmentDbMock(variant: {
  id: string;
  stock: number;
  reservedStock?: number;
  preorderStock: number;
  stockVersion: number;
}) {
  const persistedVariant = { reservedStock: 0, ...variant };
  const batchCalls: MockStatement[][] = [];
  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                get: async () => persistedVariant,
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
    batch: async (statements: MockStatement[]) => {
      batchCalls.push(statements);
      return [[{ id: "movement_1" }], [{ id: variant.id }]];
    },
  };

  return { db, batchCalls };
}

describe("adjustInventory stock ledger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records manual stock adjustments in the same batch as the stockVersion update", async () => {
    const { db, batchCalls } = createInventoryAdjustmentDbMock({
      id: "variant_1",
      stock: 9,
      preorderStock: 0,
      stockVersion: 4,
    });

    const result = await adjustInventory(
      db as never,
      "variant_1",
      { delta: -3, reason: "damaged", notes: "warehouse count" },
      "admin_1",
    );

    expect(result).toEqual({
      variantId: "variant_1",
      previousStock: 9,
      newStock: 6,
      delta: -3,
    });
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]?.[0]).toMatchObject({
      kind: "insert",
      table: inventoryMovements,
    });
    expect(batchCalls[0]?.[1]).toMatchObject({
      kind: "update",
      table: productVariants,
      values: { stock: 6 },
    });
    expect(checkAndAlertLowStock).toHaveBeenCalledWith(db, "variant_1");
  });

  it("reconciles low-stock alerts after a positive manual restock", async () => {
    const { db } = createInventoryAdjustmentDbMock({
      id: "variant_1",
      stock: 2,
      preorderStock: 0,
      stockVersion: 4,
    });

    const result = await adjustInventory(
      db as never,
      "variant_1",
      { delta: 8, reason: "received", notes: "supplier delivery" },
      "admin_1",
    );

    expect(result).toMatchObject({ previousStock: 2, newStock: 10, delta: 8 });
    expect(checkAndAlertLowStock).toHaveBeenCalledWith(db, "variant_1");
  });
});
