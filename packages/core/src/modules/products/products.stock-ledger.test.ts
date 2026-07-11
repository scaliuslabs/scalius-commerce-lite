import { beforeEach, describe, expect, it, vi } from "vitest";
import { inventoryMovements, products, productVariants } from "@scalius/database/schema";
import { updateVariant } from "./products.variants";
import { checkAndAlertLowStock } from "../inventory/alerts";

vi.mock("../inventory/alerts", () => ({
  checkAndAlertLowStock: vi.fn(),
}));

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
  expectedAggregateRevision: 1,
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
      run() { return { kind: "guard" as const }; },
      select() {
        selectCount++;
        return {
          from() {
            return {
              where() {
                if (selectCount === 2) {
                  return Promise.resolve([]);
                }

                return {
                  get: async () => (
                    selectCount === 1
                      ? {
                          id: "variant_1",
                          isDefault: false,
                          size: "M",
                          color: "Black",
                          stock: 5,
                          reservedStock: 0,
                          preorderStock: 0,
                          stockVersion: 3,
                          trackInventory: true,
                        }
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
                    return {
                      kind: table === products ? "revision" as const : "update" as const,
                      table,
                      values,
                    };
                  },
                };
              },
            };
          },
        };
      },
      batch: async (statements: unknown[]) => {
        batchCalls.push(statements);
        return statements.map((statement) => {
          const candidate = statement as { kind?: string };
          if (candidate.kind === "guard") return [{ ok: 1 }];
          if (candidate.kind === "insert") return [{ id: "movement_1" }];
          if (candidate.kind === "revision") return [{ aggregateRevision: 2 }];
          return [{ id: "variant_1", stock: 12, ...updateSets[0] }];
        });
      },
    };

    const result = await updateVariant(
      db as never,
      "product_1",
      "variant_1",
      variantInput,
      "admin_1",
    );

    expect(updateSets).toHaveLength(2);
    expect(batchCalls[0]?.[2]).toMatchObject({ kind: "insert", table: inventoryMovements });
    expect(batchCalls[0]?.[3]).toMatchObject({ kind: "update", table: productVariants });
    expect(updateSets[0]).toMatchObject({ stock: 12 });
    expect(result?.stock).toBe(12);
    expect(checkAndAlertLowStock).toHaveBeenCalledWith(db, "variant_1");
  });

});
