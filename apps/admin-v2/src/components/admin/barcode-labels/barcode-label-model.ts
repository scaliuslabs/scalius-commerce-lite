import type { InventoryLabelVariant } from "~/lib/api-functions/inventory";
import { getBarcodeValidationError } from "@scalius/shared/barcode-identity";

export const MAX_LABEL_SKUS = 150;
export const MAX_LABEL_COPIES = 1_000;

export type BarcodeRenderFormat = "CODE128" | "EAN13" | "UPC" | "EAN8" | "ITF14";

export type BarcodeQuietZoneModules = {
  left: number;
  right: number;
};

/**
 * Clear modules that must stay inside the rendered SVG, not merely in the
 * surrounding label. Extra clear space is harmless; missing it can make an
 * otherwise valid symbol unreliable at a scanner.
 */
export function getBarcodeQuietZoneModules(
  format: BarcodeRenderFormat,
): BarcodeQuietZoneModules {
  if (format === "EAN13") return { left: 11, right: 7 };
  if (format === "EAN8") return { left: 7, right: 7 };
  if (format === "UPC") return { left: 9, right: 9 };
  return { left: 10, right: 10 };
}

export type LabelPreset = {
  id: "a4-cut-3x8" | "a4-compact-4x10" | "a4-adhesive-2x7" | "thermal-50x25" | "thermal-40x30" | "custom";
  name: string;
  detail: string;
  pageWidthMm: number;
  pageHeightMm: number;
  columns: number;
  rows: number;
  marginXmm: number;
  marginYmm: number;
  gapXmm: number;
  gapYmm: number;
  cropMarks: boolean;
  thermal: boolean;
};

export const LABEL_PRESETS: readonly LabelPreset[] = [
  {
    id: "a4-cut-3x8",
    name: "A4 cut sheet",
    detail: "Plain paper · 3 × 8 · 24 labels",
    pageWidthMm: 210,
    pageHeightMm: 297,
    columns: 3,
    rows: 8,
    marginXmm: 8,
    marginYmm: 8,
    gapXmm: 2,
    gapYmm: 2,
    cropMarks: true,
    thermal: false,
  },
  {
    id: "a4-compact-4x10",
    name: "A4 compact",
    detail: "Plain paper · 4 × 10 · 40 labels",
    pageWidthMm: 210,
    pageHeightMm: 297,
    columns: 4,
    rows: 10,
    marginXmm: 7,
    marginYmm: 7,
    gapXmm: 1.5,
    gapYmm: 1,
    cropMarks: true,
    thermal: false,
  },
  {
    id: "a4-adhesive-2x7",
    name: "A4 adhesive",
    detail: "2 × 7 · 14 larger labels",
    pageWidthMm: 210,
    pageHeightMm: 297,
    columns: 2,
    rows: 7,
    marginXmm: 10,
    marginYmm: 10,
    gapXmm: 2,
    gapYmm: 2,
    cropMarks: false,
    thermal: false,
  },
  {
    id: "thermal-50x25",
    name: "Thermal 50 × 25 mm",
    detail: "One label per page",
    pageWidthMm: 50,
    pageHeightMm: 25,
    columns: 1,
    rows: 1,
    marginXmm: 1.5,
    marginYmm: 1.5,
    gapXmm: 0,
    gapYmm: 0,
    cropMarks: false,
    thermal: true,
  },
  {
    id: "thermal-40x30",
    name: "Thermal 40 × 30 mm",
    detail: "One compact label per page",
    pageWidthMm: 40,
    pageHeightMm: 30,
    columns: 1,
    rows: 1,
    marginXmm: 1.5,
    marginYmm: 1.5,
    gapXmm: 0,
    gapYmm: 0,
    cropMarks: false,
    thermal: true,
  },
  {
    id: "custom",
    name: "Custom stock",
    detail: "Set page, grid, margins, and gaps",
    pageWidthMm: 210,
    pageHeightMm: 297,
    columns: 3,
    rows: 8,
    marginXmm: 8,
    marginYmm: 8,
    gapXmm: 2,
    gapYmm: 2,
    cropMarks: true,
    thermal: false,
  },
] as const;

export type LabelPresetId = LabelPreset["id"];

export type BarcodeSymbol = {
  format: BarcodeRenderFormat | null;
  value: string;
  displayValue: string;
  error: string | null;
};

export type LabelContentOptions = {
  showProduct: boolean;
  showVariant: boolean;
  showSku: boolean;
  showPrice: boolean;
};

export const DEFAULT_LABEL_CONTENT: LabelContentOptions = {
  showProduct: true,
  showVariant: true,
  showSku: true,
  showPrice: true,
};

export const MAX_LABEL_ALIGNMENT_MM = 5;

export type LabelPrintAlignment = {
  xMm: number;
  yMm: number;
};

export const DEFAULT_LABEL_PRINT_ALIGNMENT: LabelPrintAlignment = {
  xMm: 0,
  yMm: 0,
};

export function clampLabelAlignmentMm(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-MAX_LABEL_ALIGNMENT_MM, Math.min(MAX_LABEL_ALIGNMENT_MM, value));
}

export function formatLabelPrintAlignment(alignment: LabelPrintAlignment): string {
  if (alignment.xMm === 0 && alignment.yMm === 0) return "Default";
  const horizontal = alignment.xMm === 0
    ? null
    : `${Math.abs(alignment.xMm)} mm ${alignment.xMm > 0 ? "right" : "left"}`;
  const vertical = alignment.yMm === 0
    ? null
    : `${Math.abs(alignment.yMm)} mm ${alignment.yMm > 0 ? "down" : "up"}`;
  return [horizontal, vertical].filter(Boolean).join(" · ");
}

export function getLabelPrintGridPosition(
  preset: Pick<LabelPreset, "marginXmm" | "marginYmm">,
  alignment: LabelPrintAlignment,
): { leftMm: number; topMm: number } {
  return {
    leftMm: preset.marginXmm + clampLabelAlignmentMm(alignment.xMm),
    topMm: preset.marginYmm + clampLabelAlignmentMm(alignment.yMm),
  };
}

export function formatLabelCount(count: number): string {
  return `${count} ${count === 1 ? "label" : "labels"}`;
}

export function formatPageCount(count: number): string {
  return `${count} ${count === 1 ? "page" : "pages"}`;
}

export function clampLabelPreviewPageIndex(index: number, pageCount: number): number {
  const lastPageIndex = Math.max(0, Math.trunc(pageCount) - 1);
  return Math.max(0, Math.min(Math.trunc(index) || 0, lastPageIndex));
}

export function getLabelPreset(id: LabelPresetId): LabelPreset {
  return LABEL_PRESETS.find((preset) => preset.id === id) ?? LABEL_PRESETS[0];
}

export function getLabelInventorySummary(
  variant: Pick<InventoryLabelVariant, "available" | "stock" | "trackInventory">,
): string {
  return variant.trackInventory
    ? `${variant.stock} on hand · ${variant.available} available`
    : "Inventory not tracked";
}

export type LabelQuantityShortcut = "one" | "onHand" | "available";

export type LabelOrder = "selected" | "product" | "sku";

export function getLabelShortcutQuantity(
  variant: Pick<InventoryLabelVariant, "available" | "stock" | "trackInventory">,
  currentQuantity: number,
  mode: LabelQuantityShortcut,
): number {
  if (mode === "one") return 1;
  if (!variant.trackInventory) return Math.max(0, Math.trunc(currentQuantity));
  return Math.max(0, mode === "onHand" ? variant.stock : variant.available);
}

function compareLabelText(left: string | null | undefined, right: string | null | undefined): number {
  return (left ?? "").localeCompare(right ?? "", "en", {
    numeric: true,
    sensitivity: "base",
  });
}

/**
 * Printing order is a job concern, not catalog identity. Never mutate the API
 * projection or the URL selection order while arranging physical labels.
 */
export function orderLabelVariants(
  variants: readonly InventoryLabelVariant[],
  order: LabelOrder,
): InventoryLabelVariant[] {
  const ordered = [...variants];
  if (order === "selected") return ordered;

  return ordered.sort((left, right) => {
    const primary = order === "product"
      ? compareLabelText(left.productName, right.productName)
      : compareLabelText(left.sku, right.sku);
    if (primary !== 0) return primary;

    const secondary = order === "product"
      ? compareLabelText(left.optionLabel, right.optionLabel)
      : compareLabelText(left.productName, right.productName);
    if (secondary !== 0) return secondary;

    const tertiary = compareLabelText(left.sku, right.sku);
    return tertiary !== 0 ? tertiary : compareLabelText(left.id, right.id);
  });
}

export function getNonPrintingLabelVariantIds(
  variants: readonly Pick<InventoryLabelVariant, "id">[],
  quantities: Readonly<Record<string, number>>,
): string[] {
  return variants
    .filter((variant) => Math.max(0, Math.trunc(quantities[variant.id] ?? 1)) === 0)
    .map((variant) => variant.id);
}

export function getLabelDimensions(preset: LabelPreset) {
  return {
    widthMm: (preset.pageWidthMm - (2 * preset.marginXmm) - ((preset.columns - 1) * preset.gapXmm)) / preset.columns,
    heightMm: (preset.pageHeightMm - (2 * preset.marginYmm) - ((preset.rows - 1) * preset.gapYmm)) / preset.rows,
  };
}

export function getLabelPresetIssue(preset: LabelPreset): string | null {
  if (preset.pageWidthMm < 20 || preset.pageWidthMm > 320) return "Page width must be between 20 and 320 mm.";
  if (preset.pageHeightMm < 15 || preset.pageHeightMm > 450) return "Page height must be between 15 and 450 mm.";
  if (!Number.isInteger(preset.columns) || preset.columns < 1 || preset.columns > 10) return "Columns must be a whole number from 1 to 10.";
  if (!Number.isInteger(preset.rows) || preset.rows < 1 || preset.rows > 20) return "Rows must be a whole number from 1 to 20.";
  if (preset.marginXmm < 0 || preset.marginYmm < 0 || preset.gapXmm < 0 || preset.gapYmm < 0) return "Margins and gaps cannot be negative.";
  const dimensions = getLabelDimensions(preset);
  if (dimensions.widthMm < 20) return "Each label needs at least 20 mm of width. Reduce columns, margins, or horizontal gaps.";
  if (dimensions.heightMm < 15) return "Each label needs at least 15 mm of height. Reduce rows, margins, or vertical gaps.";
  return null;
}

function gtinCheckDigit(inputWithoutCheckDigit: string): string {
  let sum = 0;
  for (let index = inputWithoutCheckDigit.length - 1, weight = 3; index >= 0; index -= 1, weight = weight === 3 ? 1 : 3) {
    sum += Number(inputWithoutCheckDigit[index]) * weight;
  }
  return String((10 - (sum % 10)) % 10);
}

export function isbn10ToBooklandEan13(value: string): string | null {
  const normalized = value.replaceAll("-", "").toUpperCase();
  if (!/^\d{9}[\dX]$/.test(normalized) || getBarcodeValidationError(normalized, "isbn")) return null;
  const base = `978${normalized.slice(0, 9)}`;
  return `${base}${gtinCheckDigit(base)}`;
}

function isPrintableCode128(value: string): boolean {
  return /^[\x20-\x7E]+$/.test(value);
}

export function resolveBarcodeSymbol(
  barcode: string | null,
  barcodeType: string | null,
): BarcodeSymbol {
  const value = barcode?.trim() ?? "";
  if (!value || !barcodeType) {
    return { format: null, value, displayValue: value, error: "This SKU has no printable barcode." };
  }

  const validationError = getBarcodeValidationError(value, barcodeType);
  if (validationError) {
    return { format: null, value, displayValue: value, error: validationError };
  }

  if (barcodeType === "ean13") {
    return { format: "EAN13", value, displayValue: value, error: null };
  }
  if (barcodeType === "upc") {
    return { format: "UPC", value, displayValue: value, error: null };
  }
  if (barcodeType === "gtin") {
    const formats: Record<number, BarcodeRenderFormat> = { 8: "EAN8", 12: "UPC", 13: "EAN13", 14: "ITF14" };
    return { format: formats[value.length]!, value, displayValue: value, error: null };
  }
  if (barcodeType === "isbn") {
    const compact = value.replaceAll("-", "").toUpperCase();
    if (compact.length === 13) {
      return { format: "EAN13", value: compact, displayValue: value, error: null };
    }
    const bookland = isbn10ToBooklandEan13(compact);
    return bookland
      ? { format: "EAN13", value: bookland, displayValue: value, error: null }
      : { format: null, value, displayValue: value, error: "ISBN labels require a valid ISBN-10 or ISBN-13." };
  }
  if (barcodeType === "code128" || barcodeType === "custom") {
    return isPrintableCode128(value)
      ? { format: "CODE128", value, displayValue: value, error: null }
      : { format: null, value, displayValue: value, error: "This value cannot be encoded as a printable Code 128 label." };
  }
  return { format: null, value, displayValue: value, error: "This barcode type is not supported for printing." };
}

export function estimateBarcodeWidthMm(symbol: BarcodeSymbol): number | null {
  if (!symbol.format) return null;
  if (symbol.format === "EAN13" || symbol.format === "UPC") return 37.3;
  if (symbol.format === "EAN8") return 27;
  if (symbol.format === "ITF14") return 48;

  const numericPairs = /^\d+$/.test(symbol.value) && symbol.value.length % 2 === 0;
  const encodedValues = numericPairs ? symbol.value.length / 2 : symbol.value.length;
  const quietZone = getBarcodeQuietZoneModules(symbol.format);
  const modulesIncludingQuietZone = (11 * (encodedValues + 2)) + 13 + quietZone.left + quietZone.right;
  return modulesIncludingQuietZone * 0.2;
}

export function getBarcodeFitIssue(symbol: BarcodeSymbol, preset: LabelPreset): string | null {
  if (symbol.error) return symbol.error;
  const minimumWidth = estimateBarcodeWidthMm(symbol);
  if (minimumWidth === null) return "This barcode cannot be rendered.";
  const { widthMm } = getLabelDimensions(preset);
  const usableWidth = widthMm - 4;
  if (minimumWidth > usableWidth) {
    return `Barcode needs about ${Math.ceil(minimumWidth)} mm; this label has ${Math.floor(usableWidth)} mm of safe width.`;
  }
  return null;
}

export function findCompatibleLabelPreset(
  symbols: readonly BarcodeSymbol[],
  currentPreset: LabelPreset,
): LabelPreset | null {
  if (symbols.length === 0) return null;
  const candidates = LABEL_PRESETS.filter((candidate) => (
    candidate.id !== "custom"
    && candidate.id !== currentPreset.id
    && symbols.every((symbol) => getBarcodeFitIssue(symbol, candidate) === null)
  ));
  return candidates.find((candidate) => candidate.thermal === currentPreset.thermal)
    ?? candidates[0]
    ?? null;
}

export type LabelCopy = {
  key: string;
  variant: InventoryLabelVariant;
  symbol: BarcodeSymbol;
};

function labelCsvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  // Catalog text is merchant-controlled and CSV files are commonly opened in
  // spreadsheet software before being merged into label-printer templates.
  // Keep the export inert instead of allowing a leading formula character.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * Exports one row per physical label, not one row per SKU. Database-merge
 * tools such as P-touch can therefore print every record once and preserve the
 * exact quantities and job order already reviewed in Scalius.
 */
export function buildLabelDataCsv(
  copies: readonly LabelCopy[],
  formatPrice: (price: number | string) => string,
): string {
  const headers = [
    "Label number",
    "Product",
    "Variant",
    "SKU",
    "Barcode format",
    "Encoded barcode",
    "Printed value",
    "Selling price",
  ];
  const rows = copies.map((copy, index) => [
    index + 1,
    copy.variant.productName,
    copy.variant.optionLabel ?? "",
    copy.variant.sku,
    copy.symbol.format ?? "",
    copy.symbol.value,
    copy.symbol.displayValue,
    formatPrice(copy.variant.effectivePrice),
  ]);

  // The BOM keeps non-Latin product and variant names intact in Excel and in
  // the desktop label applications merchants commonly use as merge sources.
  return `\uFEFF${[
    headers.map(labelCsvCell).join(","),
    ...rows.map((row) => row.map(labelCsvCell).join(",")),
  ].join("\r\n")}`;
}

export function buildLabelCopies(
  variants: readonly InventoryLabelVariant[],
  quantities: Readonly<Record<string, number>>,
): LabelCopy[] {
  const copies: LabelCopy[] = [];
  for (const variant of variants) {
    const quantity = Math.max(0, Math.min(MAX_LABEL_COPIES, Math.trunc(quantities[variant.id] ?? 0)));
    const symbol = resolveBarcodeSymbol(variant.barcode, variant.barcodeType);
    for (let copy = 0; copy < quantity; copy += 1) {
      copies.push({ key: `${variant.id}:${copy}`, variant, symbol });
      if (copies.length > MAX_LABEL_COPIES) return copies;
    }
  }
  return copies;
}

export type LabelPageCell = LabelCopy | null;

export function paginateLabelCopies(
  copies: readonly LabelCopy[],
  preset: LabelPreset,
  startOffset = 0,
): LabelPageCell[][] {
  const perPage = preset.columns * preset.rows;
  if (perPage < 1) return [];
  const safeOffset = Math.max(0, Math.min(perPage - 1, Math.trunc(startOffset)));
  const cells: LabelPageCell[] = [
    ...Array.from({ length: copies.length > 0 ? safeOffset : 0 }, () => null),
    ...copies,
  ];
  const pages: LabelPageCell[][] = [];
  for (let index = 0; index < cells.length; index += perPage) {
    pages.push(cells.slice(index, index + perPage));
  }
  return pages;
}
