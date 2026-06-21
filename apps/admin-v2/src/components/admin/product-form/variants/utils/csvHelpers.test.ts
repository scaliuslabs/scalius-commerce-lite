import { describe, expect, it } from "vitest";
import {
  generateCsvTemplate,
  parseCsvToVariants,
  variantsToCsv,
} from "./csvHelpers";
import type { ProductVariant } from "../types";

const baseVariant: ProductVariant = {
  id: "variant_1",
  sku: "SKU-001",
  size: "XL",
  color: "Red",
  weight: 500,
  barcode: "5901234123457",
  barcodeType: "ean13",
  price: 299.99,
  stock: 50,
  reservedStock: 0,
  discountType: "percentage",
  discountPercentage: 10,
  discountAmount: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  deletedAt: null,
};

describe("variant CSV helpers", () => {
  it("round-trips exported barcode-aware variants into bulk import payloads", () => {
    const csv = variantsToCsv([baseVariant]);
    const result = parseCsvToVariants(csv);

    expect(result).toMatchObject({
      success: true,
      imported: 1,
      failed: 0,
    });
    expect(result.variants).toEqual([
      {
        sku: "SKU-001",
        size: "XL",
        color: "Red",
        weight: 500,
        barcode: "5901234123457",
        barcodeType: "ean13",
        price: 299.99,
        stock: 50,
        discountType: "percentage",
        discountPercentage: 10,
        discountAmount: null,
      },
    ]);
  });

  it("parses the generated template with the same column contract", () => {
    const result = parseCsvToVariants(generateCsvTemplate());

    expect(result.success).toBe(true);
    expect(result.variants[0]).toMatchObject({
      sku: "SKU-001",
      barcode: "5901234123457",
      barcodeType: "ean13",
      price: 299.99,
      stock: 50,
    });
  });

  it("rejects duplicate imported SKUs and conflicts with existing variants", () => {
    const duplicateRows = [
      "SKU,Size,Color,Weight (g),Barcode,Barcode Type,Price,Stock,Discount Type,Discount Value",
      "SKU-001,XL,Red,500,,custom,10,1,percentage,",
      "SKU-001,L,Blue,500,,custom,10,1,percentage,",
    ].join("\n");
    const duplicateResult = parseCsvToVariants(duplicateRows);

    expect(duplicateResult.success).toBe(false);
    expect(duplicateResult.errors).toContainEqual({
      row: 3,
      error: "Duplicate SKU in import: SKU-001",
    });

    const conflictResult = parseCsvToVariants(duplicateRows, ["SKU-001"]);
    expect(conflictResult.success).toBe(false);
    expect(conflictResult.errors[0]).toEqual({
      row: 2,
      error: "SKU already exists: SKU-001",
    });
  });

  it("rejects malformed numeric fields and unknown discount types", () => {
    const invalidRows = [
      "SKU,Price,Stock,Discount Type,Discount Value",
      "BAD-PRICE,12abc,1,percentage,",
      "BAD-STOCK,12,1.5,percentage,",
      "BAD-DISCOUNT,12,1,seasonal,",
    ].join("\n");
    const result = parseCsvToVariants(invalidRows);

    expect(result.success).toBe(false);
    expect(result.imported).toBe(0);
    expect(result.failed).toBe(3);
    expect(result.errors).toEqual([
      { row: 2, error: "Invalid price" },
      { row: 3, error: "Invalid stock" },
      { row: 4, error: "Invalid discount type: seasonal" },
    ]);
  });

  it("rejects imported option rows without size or color", () => {
    const rows = [
      "SKU,Size,Color,Price,Stock",
      "NO-OPTION,,,12,1",
    ].join("\n");
    const result = parseCsvToVariants(rows);

    expect(result.success).toBe(false);
    expect(result.imported).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors).toEqual([
      { row: 2, error: "Size or Color is required for product options" },
    ]);
  });
});
