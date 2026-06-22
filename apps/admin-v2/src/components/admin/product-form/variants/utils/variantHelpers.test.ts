import { describe, expect, it } from "vitest";
import {
  generateVariantCombinations,
  getAvailableStock,
  getStockStatus,
  getVariantStats,
} from "./variantHelpers";
import type { BulkVariantOptions, ProductVariant } from "../types";

const baseOptions: BulkVariantOptions = {
  sizes: [],
  colors: [],
  basePrice: 100,
  baseStock: 5,
  trackInventory: true,
  baseWeight: null,
  skuTemplate: "{SLUG}-{OPTION1}-{OPTION2}-{INDEX}",
  discountType: "percentage",
  discountValue: null,
  generateBarcodes: false,
};

describe("variant option helper boundaries", () => {
  it("does not generate no-option SKUs from an empty bulk option set", () => {
    expect(generateVariantCombinations(baseOptions, "shirt")).toEqual([]);
  });

  it("generates customer option SKUs when at least one option axis exists", () => {
    const generated = generateVariantCombinations(
      {
        ...baseOptions,
        sizes: ["M", "L"],
      },
      "shirt",
    );

    expect(generated).toHaveLength(2);
    expect(generated[0].trackInventory).toBe(true);
  });

  it("preserves no-limit inventory intent when bulk generating options", () => {
    const generated = generateVariantCombinations(
      {
        ...baseOptions,
        sizes: ["M"],
        trackInventory: false,
      },
      "shirt",
    );

    expect(generated[0]).toMatchObject({
      stock: 5,
      trackInventory: false,
    });
  });

  it("treats over-reserved tracked stock as sold out instead of low stock", () => {
    const variant: ProductVariant = {
      id: "var_over_reserved",
      sku: "SKU-OVER",
      size: "M",
      color: "Black",
      weight: null,
      price: 100,
      stock: 1,
      reservedStock: 3,
      trackInventory: true,
      isDefault: false,
      barcode: null,
      barcodeType: null,
      discountType: "percentage",
      discountPercentage: null,
      discountAmount: null,
      createdAt: new Date("2026-06-22T00:00:00Z"),
      updatedAt: new Date("2026-06-22T00:00:00Z"),
      deletedAt: null,
    };

    expect(getAvailableStock(variant)).toBe(0);
    expect(getStockStatus(-2)).toBe("out-of-stock");
    expect(getVariantStats([variant])).toMatchObject({
      totalStock: 0,
      totalValue: 0,
      lowStockCount: 0,
      outOfStockCount: 1,
    });
  });
});
