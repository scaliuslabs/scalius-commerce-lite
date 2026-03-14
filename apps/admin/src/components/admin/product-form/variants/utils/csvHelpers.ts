// src/components/admin/ProductForm/variants/utils/csvHelpers.ts

import type { ProductVariant, CsvVariantRow, CsvImportResult } from "../types";

/**
 * Convert variants to CSV string
 */
export function variantsToCsv(variants: ProductVariant[]): string {
  const headers = [
    "SKU",
    "Size",
    "Color",
    "Weight (g)",
    "Price",
    "Stock",
    "Discount Type",
    "Discount Value",
  ];

  const rows = variants.map((v) => [
    v.sku,
    v.size || "",
    v.color || "",
    v.weight?.toString() || "",
    v.price.toString(),
    v.stock.toString(),
    v.discountType,
    v.discountType === "percentage"
      ? v.discountPercentage?.toString() || ""
      : v.discountAmount?.toString() || "",
  ]);

  const csvContent = [headers, ...rows]
    .map((row) => row.map((cell) => `"${cell}"`).join(","))
    .join("\n");

  return csvContent;
}

/**
 * Download variants as CSV file
 */
export function downloadCsv(
  csvContent: string,
  filename: string = "variants.csv",
): void {
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);

  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  link.style.visibility = "hidden";

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  URL.revokeObjectURL(url);
}

/**
 * Parse CSV text to variant rows
 */
export function parseCsvToVariants(csvText: string): CsvImportResult {
  const result: CsvImportResult = {
    success: true,
    imported: 0,
    failed: 0,
    errors: [],
  };

  try {
    const lines = csvText.trim().split("\n");

    if (lines.length === 0) {
      result.success = false;
      result.errors.push({ row: 0, error: "CSV file is empty" });
      return result;
    }

    // Skip header row
    const dataLines = lines.slice(1);

    dataLines.forEach((line, index) => {
      const rowNumber = index + 2; // +2 because we skip header and arrays are 0-indexed

      try {
        // Parse CSV row (handle quoted values)
        const values = parseCsvLine(line);

        if (values.length < 5) {
          throw new Error(
            "Missing required columns (SKU, Size, Color, Weight, Price, Stock)",
          );
        }

        const [
          sku,
          size,
          color,
          weightStr,
          priceStr,
          stockStr,
          discountType,
          discountValueStr,
        ] = values;

        // Validate required fields
        if (!sku || sku.trim().length === 0) {
          throw new Error("SKU is required");
        }

        const price = parseFloat(priceStr);
        if (isNaN(price) || price < 0) {
          throw new Error("Invalid price");
        }

        const stock = parseInt(stockStr, 10);
        if (isNaN(stock) || stock < 0) {
          throw new Error("Invalid stock");
        }

        // Parse optional fields
        const weight =
          weightStr && weightStr.trim() ? parseFloat(weightStr) : null;
        if (weight !== null && (isNaN(weight) || weight < 0)) {
          throw new Error("Invalid weight");
        }

        const parsedDiscountType = discountType?.trim().toLowerCase();
        const validDiscountType =
          parsedDiscountType === "percentage" || parsedDiscountType === "flat"
            ? parsedDiscountType
            : "percentage";

        const discountValue =
          discountValueStr && discountValueStr.trim()
            ? parseFloat(discountValueStr)
            : null;

        // Validating row structure (Implicit check)
        ({
          sku: sku.trim(),
          size: size?.trim() || undefined,
          color: color?.trim() || undefined,
          weight: weight !== null ? weight : undefined,
          price,
          stock,
          discountType: validDiscountType,
          discountValue: discountValue !== null ? discountValue : undefined,
        }) satisfies CsvVariantRow;

        result.imported++;
      } catch (error) {
        result.failed++;
        result.errors.push({
          row: rowNumber,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });

    if (result.failed > 0) {
      result.success = false;
    }
  } catch (error) {
    result.success = false;
    result.errors.push({
      row: 0,
      error: error instanceof Error ? error.message : "Failed to parse CSV",
    });
  }

  return result;
}

/**
 * Parse a single CSV line, handling quoted values
 */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current);
  return result;
}

/**
 * Generate CSV template for download
 */
export function generateCsvTemplate(): string {
  const headers = [
    "SKU",
    "Size",
    "Color",
    "Weight (g)",
    "Price",
    "Stock",
    "Discount Type",
    "Discount Value",
  ];

  const exampleRow = [
    "SKU-001",
    "XL",
    "Red",
    "500",
    "299.99",
    "50",
    "percentage",
    "10",
  ];

  return [headers, exampleRow]
    .map((row) => row.map((cell) => `"${cell}"`).join(","))
    .join("\n");
}

/**
 * Validate imported CSV variants
 */
export function validateCsvVariants(
  rows: CsvVariantRow[],
  existingSkus: string[],
): Array<{ row: number; error: string }> {
  const errors: Array<{ row: number; error: string }> = [];
  const seenSkus = new Set<string>();

  rows.forEach((row, index) => {
    // Check for duplicate SKUs within the import
    if (seenSkus.has(row.sku)) {
      errors.push({
        row: index + 2, // +2 for header and 0-index
        error: `Duplicate SKU in import: ${row.sku}`,
      });
    } else {
      seenSkus.add(row.sku);
    }

    // Check for SKU conflicts with existing variants
    if (existingSkus.includes(row.sku)) {
      errors.push({
        row: index + 2,
        error: `SKU already exists: ${row.sku}`,
      });
    }

    // Validate discount values
    if (row.discountType === "percentage" && row.discountValue) {
      if (row.discountValue < 0 || row.discountValue > 100) {
        errors.push({
          row: index + 2,
          error: "Percentage discount must be between 0 and 100",
        });
      }
    }

    if (
      row.discountType === "flat" &&
      row.discountValue &&
      row.discountValue < 0
    ) {
      errors.push({
        row: index + 2,
        error: "Flat discount cannot be negative",
      });
    }
  });

  return errors;
}
