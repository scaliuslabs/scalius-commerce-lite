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
  trackInventory: true,
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
        trackInventory: true,
        discountType: "percentage",
        discountPercentage: 10,
        discountAmount: null,
      },
    ]);
  });

  it("parses the generated template with the same column contract", () => {
    const result = parseCsvToVariants(generateCsvTemplate());

    expect(result.success).toBe(true);
    expect(result.imported).toBe(3);
    expect(result.variants[0]).toMatchObject({
      sku: "SKU-001",
      size: "2KG",
      color: "Red",
      barcode: "5901234123457",
      barcodeType: "ean13",
      price: 299.99,
      stock: 50,
      trackInventory: true,
    });
    expect(result.variants).toEqual([
      expect.objectContaining({ sku: "SKU-001", size: "2KG", color: "Red" }),
      expect.objectContaining({ sku: "SKU-002", size: "XL", color: "Blue" }),
      expect.objectContaining({ sku: "SKU-003", size: "100ml", color: "Pro" }),
    ]);
  });

  it("rejects duplicate imported SKUs and conflicts with existing variants", () => {
    const duplicateRows = [
      "SKU,Option 1,Option 2,Weight (g),Barcode,Barcode Type,Price,Stock,Discount Type,Discount Value",
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
      "SKU,Option 1,Price,Stock,Track Stock,Discount Type,Discount Value",
      "BAD-PRICE,M,12abc,1,yes,percentage,",
      "BAD-STOCK,M,12,1.5,yes,percentage,",
      "BAD-DISCOUNT,M,12,1,yes,seasonal,",
      "BAD-TRACK,M,12,1,maybe,percentage,",
    ].join("\n");
    const result = parseCsvToVariants(invalidRows);

    expect(result.success).toBe(false);
    expect(result.imported).toBe(0);
    expect(result.failed).toBe(4);
    expect(result.errors).toEqual([
      { row: 2, error: "Invalid price" },
      { row: 3, error: "Invalid stock" },
      { row: 4, error: "Invalid discount type: seasonal" },
      { row: 5, error: "Invalid track stock value: maybe" },
    ]);
  });

  it("rejects imported option rows without Option 1 or Option 2", () => {
    const rows = [
      "SKU,Option 1,Option 2,Price,Stock",
      "NO-OPTION,,,12,1",
    ].join("\n");
    const result = parseCsvToVariants(rows);

    expect(result.success).toBe(false);
    expect(result.imported).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors).toEqual([
      { row: 2, error: "Option 1 or Option 2 is required for product options" },
    ]);
  });

  it("exports and imports no-limit stock options", () => {
    const csv = variantsToCsv([{ ...baseVariant, trackInventory: false }]);

    expect(csv.split("\n")[0]).toContain('"Track Stock"');
    expect(csv.split("\n")[1]).toContain('"no"');

    const result = parseCsvToVariants([
      "SKU,Option 1,Option 2,Price,Stock,Track Stock",
      "SKU-002,M,,199,0,no",
      "SKU-003,L,,199,0,unlimited",
    ].join("\n"));

    expect(result.success).toBe(true);
    expect(result.variants).toEqual([
      expect.objectContaining({ sku: "SKU-002", trackInventory: false }),
      expect.objectContaining({ sku: "SKU-003", trackInventory: false }),
    ]);
  });

  it("accepts older size and color headers during import", () => {
    const result = parseCsvToVariants([
      "SKU,Size,Color,Price,Stock",
      "SKU-004,2KG,Blue,199,4",
    ].join("\n"));

    expect(result.success).toBe(true);
    expect(result.variants).toEqual([
      expect.objectContaining({ sku: "SKU-004", size: "2KG", color: "Blue" }),
    ]);
  });
});
