import { beforeEach, describe, expect, it, vi } from "vitest";
import { inventoryMovements, productVariants } from "@scalius/database/schema";
import { adjustStock, setStock } from "./stock-adjustment";
import { checkAndAlertLowStock } from "./alerts";

vi.mock("./alerts", () => ({
  checkAndAlertLowStock: vi.fn(),
}));

type MockStatement = {
  kind: "insert" | "update";
  table: unknown;
  values?: Record<string, unknown>;
};

function createStockDbMock(variant: { id: string; stock: number; stockVersion: number }) {
  const batchCalls: MockStatement[][] = [];
  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                get: async () => variant,
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

describe("stock adjustment ledger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets stock through a batched movement claim and stockVersion update", async () => {
    const { db, batchCalls } = createStockDbMock({
      id: "variant_1",
      stock: 5,
      stockVersion: 3,
    });

    const result = await setStock(db as never, "variant_1", 12, "Product variant edit", "admin_1");

    expect(result).toEqual({
      variantId: "variant_1",
      previousStock: 5,
      newStock: 12,
      delta: 7,
    });
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]?.[0]).toMatchObject({
      kind: "insert",
      table: inventoryMovements,
    });
    expect(batchCalls[0]?.[1]).toMatchObject({
      kind: "update",
      table: productVariants,
      values: { stock: 12 },
    });
  });

  it("records the effective delta when a negative adjustment clamps at zero", async () => {
    const { db, batchCalls } = createStockDbMock({
      id: "variant_1",
      stock: 2,
      stockVersion: 3,
    });

    const result = await adjustStock(db as never, "variant_1", -5, "damaged", "admin_1");

    expect(result).toMatchObject({
      previousStock: 2,
      newStock: 0,
      delta: -2,
    });
    expect(batchCalls[0]?.[1]).toMatchObject({
      kind: "update",
      values: { stock: 0 },
    });
    expect(checkAndAlertLowStock).toHaveBeenCalledWith(db, "variant_1");
  });
});
