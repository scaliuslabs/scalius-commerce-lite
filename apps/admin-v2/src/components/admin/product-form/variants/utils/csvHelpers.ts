// src/components/admin/ProductForm/variants/utils/csvHelpers.ts

import type {
  BulkGeneratedVariant,
  CsvImportResult,
  ProductVariant,
} from "../types";

type BarcodeType = NonNullable<ProductVariant["barcodeType"]>;

const CSV_HEADERS = [
  "SKU",
  "Size",
  "Color",
  "Weight (g)",
  "Barcode",
  "Barcode Type",
  "Price",
  "Stock",
  "Discount Type",
  "Discount Value",
] as const;

const VALID_BARCODE_TYPES = new Set<BarcodeType>([
  "ean13",
  "upc",
  "isbn",
  "gtin",
  "custom",
]);

/**
 * Convert variants to CSV string
 */
export function variantsToCsv(variants: ProductVariant[]): string {
  const rows = variants.map((v) => [
    v.sku,
    v.size || "",
    v.color || "",
    v.weight?.toString() || "",
    v.barcode || "",
    v.barcodeType || "",
    v.price.toString(),
    v.stock.toString(),
    v.discountType,
    v.discountType === "percentage"
      ? v.discountPercentage?.toString() || ""
      : v.discountAmount?.toString() || "",
  ]);

  return [CSV_HEADERS, ...rows]
    .map((row) => row.map(formatCsvCell).join(","))
    .join("\n");
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
export function parseCsvToVariants(
  csvText: string,
  existingSkus: string[] = [],
): CsvImportResult {
  const result: CsvImportResult = {
    success: true,
    imported: 0,
    failed: 0,
    variants: [],
    errors: [],
  };

  try {
    const lines = csvText.trim().split(/\r?\n/);

    if (lines.length === 0 || (lines.length === 1 && lines[0].trim() === "")) {
      result.success = false;
      result.errors.push({ row: 0, error: "CSV file is empty" });
      return result;
    }

    const headers = parseCsvLine(lines[0]).map(normalizeHeader);
    const column = createColumnLookup(headers);

    if (column.sku === -1 || column.price === -1 || column.stock === -1) {
      result.success = false;
      result.errors.push({
        row: 1,
        error: "CSV header must include SKU, Price, and Stock columns",
      });
      return result;
    }

    const seenSkus = new Set<string>();
    const existingSkuSet = new Set(existingSkus);

    lines.slice(1).forEach((line, index) => {
      const rowNumber = index + 2;

      if (!line.trim()) return;

      try {
        const values = parseCsvLine(line);
        const variant = parseVariantRow(values, column, seenSkus, existingSkuSet);

        result.variants.push(variant);
        result.imported++;
      } catch (error: unknown) {
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
  } catch (error: unknown) {
    result.success = false;
    result.errors.push({
      row: 0,
      error: error instanceof Error ? error.message : "Failed to parse CSV",
    });
  }

  return result;
}

function parseVariantRow(
  values: string[],
  column: ReturnType<typeof createColumnLookup>,
  seenSkus: Set<string>,
  existingSkuSet: Set<string>,
): BulkGeneratedVariant {
  const sku = readColumn(values, column.sku).trim();
  if (!sku) {
    throw new Error("SKU is required");
  }
  if (seenSkus.has(sku)) {
    throw new Error(`Duplicate SKU in import: ${sku}`);
  }
  if (existingSkuSet.has(sku)) {
    throw new Error(`SKU already exists: ${sku}`);
  }
  seenSkus.add(sku);

  const price = parseNumber(readColumn(values, column.price), "Invalid price");
  if (price < 0) {
    throw new Error("Invalid price");
  }

  const stock = parseInteger(readColumn(values, column.stock), "Invalid stock");
  if (stock < 0) {
    throw new Error("Invalid stock");
  }

  const weightText = readColumn(values, column.weight);
  const weight = weightText.trim()
    ? parseNumber(weightText, "Invalid weight")
    : null;
  if (weight !== null && weight < 0) {
    throw new Error("Invalid weight");
  }

  const discountType = parseDiscountType(readColumn(values, column.discountType));

  const discountValueText = readColumn(values, column.discountValue);
  const discountValue = discountValueText.trim()
    ? parseNumber(discountValueText, "Invalid discount value")
    : null;
  if (
    discountType === "percentage" &&
    discountValue !== null &&
    (discountValue < 0 || discountValue > 100)
  ) {
    throw new Error("Percentage discount must be between 0 and 100");
  }
  if (discountType === "flat" && discountValue !== null && discountValue < 0) {
    throw new Error("Flat discount cannot be negative");
  }

  const barcode = readColumn(values, column.barcode).trim();
  const barcodeType = parseBarcodeType(readColumn(values, column.barcodeType));
  const size = readColumn(values, column.size).trim() || null;
  const color = readColumn(values, column.color).trim() || null;
  if (!size && !color) {
    throw new Error("Size or Color is required for product options");
  }

  return {
    sku,
    size,
    color,
    weight,
    barcode: barcode || null,
    barcodeType,
    price,
    stock,
    discountType,
    discountPercentage: discountType === "percentage" ? discountValue : null,
    discountAmount: discountType === "flat" ? discountValue : null,
  };
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
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
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
  const exampleRow = [
    "SKU-001",
    "XL",
    "Red",
    "500",
    "5901234123457",
    "ean13",
    "299.99",
    "50",
    "percentage",
    "10",
  ];

  return [CSV_HEADERS, exampleRow]
    .map((row) => row.map(formatCsvCell).join(","))
    .join("\n");
}

function createColumnLookup(headers: string[]) {
  const indexOf = (...names: string[]) =>
    headers.findIndex((header) => names.includes(header));

  return {
    sku: indexOf("sku"),
    size: indexOf("size"),
    color: indexOf("color"),
    weight: indexOf("weightg", "weight"),
    barcode: indexOf("barcode"),
    barcodeType: indexOf("barcodetype"),
    price: indexOf("price"),
    stock: indexOf("stock"),
    discountType: indexOf("discounttype"),
    discountValue: indexOf("discountvalue"),
  };
}

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function readColumn(values: string[], index: number): string {
  return index >= 0 ? (values[index] ?? "") : "";
}

function parseNumber(value: string, message: string): number {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (!trimmed || !Number.isFinite(parsed)) {
    throw new Error(message);
  }
  return parsed;
}

function parseInteger(value: string, message: string): number {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (!trimmed || !Number.isInteger(parsed)) {
    throw new Error(message);
  }
  return parsed;
}

function parseDiscountType(value: string): BulkGeneratedVariant["discountType"] {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return "percentage";
  }
  if (normalized !== "percentage" && normalized !== "flat") {
    throw new Error(`Invalid discount type: ${normalized}`);
  }
  return normalized;
}

function parseBarcodeType(value: string): BarcodeType | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_BARCODE_TYPES.has(normalized as BarcodeType)) {
    throw new Error(`Invalid barcode type: ${normalized}`);
  }
  return normalized as BarcodeType;
}

function formatCsvCell(value: string | number): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}
