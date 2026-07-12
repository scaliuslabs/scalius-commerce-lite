import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  inventoryMovements,
  productImages,
  productVariants,
} from "@scalius/database/schema";
import {
  adjustStock,
  lookupByBarcodeOrSku,
  setStock,
} from "./stock-adjustment";
import { checkAndAlertLowStock } from "./alerts";

vi.mock("./alerts", () => ({
  checkAndAlertLowStock: vi.fn(),
}));

type MockStatement = {
  kind: "insert" | "update";
  table: unknown;
  values?: Record<string, unknown>;
};

function createStockDbMock(variant: {
  id: string;
  stock: number;
  reservedStock?: number;
  preorderStock?: number;
  stockVersion: number;
}) {
  const persistedVariant = {
    reservedStock: 0,
    preorderStock: 0,
    ...variant,
  };
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

type LookupRow = {
  variantId: string;
  variantSku: string;
  variantSize: string | null;
  variantColor: string | null;
  variantPrice: number;
  variantStock: number;
  variantReservedStock: number;
  variantBarcode: string | null;
  variantBarcodeType: string | null;
  variantLowStockThreshold: number | null;
  productId: string;
  productName: string;
  productSlug: string;
  productPrice: number;
  productIsActive: boolean;
};

const lookupRow: LookupRow = {
  variantId: "variant_1",
  variantSku: "SKU-1",
  variantSize: "M",
  variantColor: "Red",
  variantPrice: 120,
  variantStock: 8,
  variantReservedStock: 2,
  variantBarcode: "AbC-123",
  variantBarcodeType: "custom",
  variantLowStockThreshold: 3,
  productId: "product_1",
  productName: "Main Product",
  productSlug: "main-product",
  productPrice: 100,
  productIsActive: true,
};

function createLookupDbMock(options: {
  barcodeMatches?: LookupRow[];
  skuMatch?: LookupRow;
  imageUrl?: string | null;
}) {
  let selectCount = 0;
  let lookupSelectCount = 0;

  const db = {
    select() {
      selectCount++;
      return {
        from(table: unknown) {
          if (table === productImages) {
            return {
              where() {
                return {
                  get: async () =>
                    options.imageUrl === undefined
                      ? undefined
                      : { url: options.imageUrl },
                };
              },
            };
          }

          const lookupIndex = ++lookupSelectCount;
          return {
            innerJoin() {
              return {
                where() {
                  if (lookupIndex === 1) {
                    return {
                      get: async () => options.barcodeMatches?.[0],
                    };
                  }
                  return {
                    get: async () => options.skuMatch,
                  };
                },
              };
            },
          };
        },
      };
    },
  };

  return {
    db,
    getSelectCount: () => selectCount,
  };
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
    expect(checkAndAlertLowStock).toHaveBeenCalledWith(db, "variant_1");
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

describe("scanner barcode identity lookup", () => {
  it("returns the database-enforced normalized barcode identity", async () => {
    const { db, getSelectCount } = createLookupDbMock({
      barcodeMatches: [lookupRow],
      imageUrl: "https://cdn.example.com/main.jpg",
    });

    const result = await lookupByBarcodeOrSku(db as never, "  ABC-123  ");

    expect(getSelectCount()).toBe(2);
    expect(result).toEqual({
      variant: {
        id: "variant_1",
        sku: "SKU-1",
        size: "M",
        color: "Red",
        price: 120,
        stock: 8,
        reservedStock: 2,
        available: 6,
        barcode: "AbC-123",
        barcodeType: "custom",
        lowStockThreshold: 3,
      },
      product: {
        id: "product_1",
        name: "Main Product",
        slug: "main-product",
        price: 100,
        isActive: true,
        imageUrl: "https://cdn.example.com/main.jpg",
      },
    });
  });

  it("falls back to the same trimmed case-insensitive SKU identity", async () => {
    const { db, getSelectCount } = createLookupDbMock({
      barcodeMatches: [],
      skuMatch: { ...lookupRow, variantBarcode: null, variantBarcodeType: null },
      imageUrl: null,
    });

    const result = await lookupByBarcodeOrSku(db as never, "  sku-1  ");

    expect(getSelectCount()).toBe(3);
    expect(result?.variant.sku).toBe("SKU-1");
    expect(result?.product.imageUrl).toBeNull();
  });

  it("does no database work for a blank scanner value", async () => {
    const { db, getSelectCount } = createLookupDbMock({});

    await expect(lookupByBarcodeOrSku(db as never, " \n\t ")).resolves.toBeNull();
    expect(getSelectCount()).toBe(0);
  });
});
