import { beforeEach, describe, expect, it, vi } from "vitest";
import { inventoryMovements, productVariants } from "@scalius/database/schema";
import { bulkUpdateVariants } from "./products.admin";
import { duplicateVariant, updateVariant } from "./products.variants";

const variantInput = {
  size: "M",
  color: "Black",
  weight: null,
  sku: "SKU-001",
  price: 120,
  stock: 12,
  trackInventory: true,
  barcode: null,
  barcodeType: null,
  discountType: "percentage" as const,
  discountPercentage: null,
  discountAmount: null,
};

describe("product variant stock ledger routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("batches single variant stock edits with a movement claim", async () => {
    const updateSets: Record<string, unknown>[] = [];
    const batchCalls: unknown[][] = [];
    let selectCount = 0;
    const db = {
      select() {
        selectCount++;
        return {
          from() {
            return {
              where() {
                return {
                  get: async () => (
                    selectCount === 1
                      ? { id: "variant_1", isDefault: false, stock: 5, stockVersion: 3 }
                      : null
                  ),
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
            updateSets.push(values);
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
      batch: async (statements: unknown[]) => {
        batchCalls.push(statements);
        return [[{ id: "movement_1" }], [{ id: "variant_1", stock: 12, ...updateSets[0] }]];
      },
    };

    const result = await updateVariant(
      db as never,
      "product_1",
      "variant_1",
      variantInput,
      "admin_1",
    );

    expect(updateSets).toHaveLength(1);
    expect(batchCalls[0]?.[0]).toMatchObject({ kind: "insert", table: inventoryMovements });
    expect(batchCalls[0]?.[1]).toMatchObject({ kind: "update", table: productVariants });
    expect(updateSets[0]).toMatchObject({ stock: 12 });
    expect(result?.stock).toBe(12);
  });

  it("batches bulk variant stock edits with movement claims", async () => {
    const batchCalls: unknown[][] = [];
    const db = {
      select() {
        return {
          from() {
            return {
              where: async () => [
                {
                  id: "variant_1",
                  isDefault: false,
                  size: "M",
                  color: "Black",
                  stock: 5,
                  stockVersion: 3,
                },
              ],
            };
          },
        };
      },
      insert(table: unknown) {
        return {
          select() {
            return {
              returning() {
                return { table, kind: "insert" as const };
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
                    return { table, values, kind: "update" as const };
                  },
                };
              },
            };
          },
        };
      },
      batch: async (statements: unknown[]) => {
        batchCalls.push(statements);
        return statements.map((_, index) => [{ id: index === 0 ? "movement_1" : "variant_1" }]);
      },
    };

    await bulkUpdateVariants(
      db as never,
      "product_1",
      [{ id: "variant_1", price: 130, stock: 12 }],
      "admin_1",
    );

    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]?.[0]).toMatchObject({
      table: inventoryMovements,
      kind: "insert",
    });
    expect(batchCalls[0]?.[1]).toMatchObject({
      table: productVariants,
      values: { price: 130, stock: 12 },
    });
  });

  it("duplicates merchandising fields without copying physical stock", async () => {
    let insertedValues: Record<string, unknown> | undefined;
    const db = {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  limit: async () => [{
                    id: "variant_1",
                    productId: "product_1",
                    size: "M",
                    color: "Black",
                    weight: null,
                    sku: "SKU-001",
                    price: 120,
                    stock: 99,
                    isDefault: false,
                    trackInventory: true,
                    barcode: null,
                    barcodeType: null,
                    discountType: "percentage",
                    discountPercentage: 0,
                    discountAmount: 0,
                  }],
                  get: async () => null,
                };
              },
            };
          },
        };
      },
      insert() {
        return {
          values(values: Record<string, unknown>) {
            insertedValues = values;
            return {
              returning: async () => [{ id: values.id, ...values }],
            };
          },
        };
      },
    };

    const result = await duplicateVariant(db as never, "product_1", "variant_1");

    expect(insertedValues).toMatchObject({
      stock: 0,
      reservedStock: 0,
      preorderStock: 0,
      stockVersion: 1,
    });
    expect(result?.stock).toBe(0);
  });
});
