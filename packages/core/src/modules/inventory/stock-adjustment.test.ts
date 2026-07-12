import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  inventoryMovements,
  inventoryOperations,
  productVariants,
} from "@scalius/database/schema";
import {
  adjustStock,
  lookupByBarcodeOrSku,
  setStock,
} from "./stock-adjustment";
import { checkAndAlertLowStock } from "./alerts";
import type {
  ProductMediaProjection,
  SkuImageRepresentation,
} from "../products/products.media";

vi.mock("./alerts", () => ({
  checkAndAlertLowStock: vi.fn(),
}));

const mediaMocks = vi.hoisted(() => ({
  loadProductMediaProjections: vi.fn(async () => new Map()),
  resolveSkuImageRepresentation: vi.fn<(
    items: readonly ProductMediaProjection[],
    imageId: string | null,
  ) => SkuImageRepresentation>(() => null),
}));

vi.mock("../products/products.media", () => mediaMocks);

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
        from(table: unknown) {
          return {
            where() {
              return {
                get: async () => table === inventoryOperations ? null : persistedVariant,
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
      return [
        [{ id: "movement_1" }],
        [{ operationKey: "invop_stock_test_000001" }],
        [{ id: variant.id }],
      ];
    },
  };

  return { db, batchCalls };
}

type LookupRow = {
  variantId: string;
  variantImageId: string | null;
  variantSku: string;
  variantLabel: string | null;
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
  variantImageId: null,
  variantSku: "SKU-1",
  variantLabel: "Size: M / Color: Red",
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
}) {
  let selectCount = 0;
  let lookupSelectCount = 0;

  const db = {
    select() {
      selectCount++;
      return {
        from(_table: unknown) {
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

    const result = await setStock(
      db as never,
      "variant_1",
      12,
      "invop_stock_test_000001",
      "Product variant edit",
      "admin_1",
    );

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
    expect(batchCalls[0]?.[2]).toMatchObject({
      kind: "update",
      table: productVariants,
      values: { stock: 12 },
    });
    expect(checkAndAlertLowStock).toHaveBeenCalledWith(db, "variant_1");
  });

  it("rejects an adjustment that would overdraw on-hand stock instead of clamping it", async () => {
    const { db, batchCalls } = createStockDbMock({
      id: "variant_1",
      stock: 2,
      stockVersion: 3,
    });

    await expect(
      adjustStock(
        db as never,
        "variant_1",
        -5,
        "invop_stock_overdraw_01",
        "damaged",
        "admin_1",
      ),
    ).rejects.toThrow(/resulting stock must be greater than or equal to zero/);

    expect(batchCalls).toHaveLength(0);
    expect(checkAndAlertLowStock).not.toHaveBeenCalled();
  });

  it.each([0, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid relative adjustment before reading inventory: %s",
    async (adjustment) => {
      const select = vi.fn();
      const db = { select };

      await expect(
        adjustStock(db as never, "variant_1", adjustment, "invop_stock_invalid_001"),
      ).rejects.toThrow(/adjustment must/);
      expect(select).not.toHaveBeenCalled();
    },
  );

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid absolute stocktake before reading inventory: %s",
    async (newStock) => {
      const select = vi.fn();
      const db = { select };

      await expect(
        setStock(db as never, "variant_1", newStock, "invop_stock_invalid_002"),
      ).rejects.toThrow(/newStock must/);
      expect(select).not.toHaveBeenCalled();
    },
  );
});

describe("scanner barcode identity lookup", () => {
  it("returns the database-enforced normalized barcode identity", async () => {
    mediaMocks.resolveSkuImageRepresentation.mockReturnValueOnce({
      productMediaId: "pmed_main",
      mediaId: "media_main",
      url: "https://cdn.example.com/main.jpg",
      altText: "Main Product",
      source: "featured-image",
    });
    const { db, getSelectCount } = createLookupDbMock({
      barcodeMatches: [lookupRow],
    });

    const result = await lookupByBarcodeOrSku(db as never, "  ABC-123  ");

    expect(getSelectCount()).toBe(1);
    expect(mediaMocks.loadProductMediaProjections).toHaveBeenCalledWith(db, ["product_1"]);
    expect(mediaMocks.resolveSkuImageRepresentation).toHaveBeenCalledWith([], null);
    expect(result).toEqual({
      variant: {
        id: "variant_1",
        sku: "SKU-1",
        optionLabel: "Size: M / Color: Red",
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
        imageMediaId: "media_main",
      },
    });
  });

  it("falls back to the same trimmed case-insensitive SKU identity", async () => {
    const { db, getSelectCount } = createLookupDbMock({
      barcodeMatches: [],
      skuMatch: { ...lookupRow, variantBarcode: null, variantBarcodeType: null },
    });

    const result = await lookupByBarcodeOrSku(db as never, "  sku-1  ");

    expect(getSelectCount()).toBe(2);
    expect(result?.variant.sku).toBe("SKU-1");
    expect(result?.product.imageUrl).toBeNull();
    expect(result?.product.imageMediaId).toBeNull();
  });

  it("does no database work for a blank scanner value", async () => {
    const { db, getSelectCount } = createLookupDbMock({});

    await expect(lookupByBarcodeOrSku(db as never, " \n\t ")).resolves.toBeNull();
    expect(getSelectCount()).toBe(0);
  });
});
