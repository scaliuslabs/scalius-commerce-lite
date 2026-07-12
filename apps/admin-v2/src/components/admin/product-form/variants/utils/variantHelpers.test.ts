import { describe, expect, it } from "vitest";
import {
  generateVariantCombinations,
  getBulkVariantDraftKey,
  getAvailableStock,
  getStockStatus,
  getVariantStats,
  normalizeVariantDraftIdentity,
} from "./variantHelpers";
import type { BulkVariantOptions, ProductVariant } from "../types";

const baseOptions: BulkVariantOptions = {
  option1Values: [],
  option2Values: [],
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
        option1Values: ["M", "L"],
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
        option1Values: ["M"],
        trackInventory: false,
      },
      "shirt",
    );

    expect(generated[0]).toMatchObject({
      stock: 5,
      trackInventory: false,
    });
  });

  it("keeps generated identifiers stable when merchandising defaults change", () => {
    const first = generateVariantCombinations(
      {
        ...baseOptions,
        option1Values: ["Small", "Large"],
        option2Values: ["Matte"],
        skuTemplate: "{SLUG}-{RANDOM}-{INDEX}",
        generateBarcodes: true,
        basePrice: 100,
        baseStock: 2,
      },
      "bottle",
      "draft-seed",
    );
    const afterDefaultsChange = generateVariantCombinations(
      {
        ...baseOptions,
        option1Values: ["Small", "Large"],
        option2Values: ["Matte"],
        skuTemplate: "{SLUG}-{RANDOM}-{INDEX}",
        generateBarcodes: true,
        basePrice: 250,
        baseStock: 8,
      },
      "bottle",
      "draft-seed",
    );

    expect(afterDefaultsChange.map(({ sku, barcode }) => ({ sku, barcode }))).toEqual(
      first.map(({ sku, barcode }) => ({ sku, barcode })),
    );
    expect(afterDefaultsChange[0]).toMatchObject({ price: 250, stock: 8 });
  });

  it("normalizes option draft identity without losing display values", () => {
    expect(normalizeVariantDraftIdentity("  RED  ")).toBe("red");
    expect(getBulkVariantDraftKey("Large", " RED ")).toBe(
      getBulkVariantDraftKey(" large ", "red"),
    );
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
