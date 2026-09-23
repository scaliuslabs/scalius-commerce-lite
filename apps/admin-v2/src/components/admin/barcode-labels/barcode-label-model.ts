import type { InventoryLabelVariant } from "~/lib/api-query-options/inventory";
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

/** The two label stocks the dashboard prints: an A4 cut sheet and a 38 × 25 mm thermal roll. */
export const LABEL_PRESETS = [
  {
    id: "a4",
    pageWidthMm: 210,
    pageHeightMm: 297,
    columns: 3,
    rows: 8,
    marginXmm: 8,
    marginYmm: 8,
    gapXmm: 2,
    gapYmm: 2,
    cropMarks: true,
  },
  {
    id: "thermal-38x25",
    pageWidthMm: 38,
    pageHeightMm: 25,
    columns: 1,
    rows: 1,
    marginXmm: 1.5,
    marginYmm: 1.5,
    gapXmm: 0,
    gapYmm: 0,
    cropMarks: false,
  },
] as const;

export type LabelPreset = (typeof LABEL_PRESETS)[number];
export type LabelPresetId = LabelPreset["id"];

export function getLabelPreset(id: LabelPresetId): LabelPreset {
  return LABEL_PRESETS.find((preset) => preset.id === id) ?? LABEL_PRESETS[0];
}

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

export type LabelQuantityShortcut = "one" | "onHand" | "available";

export function getLabelShortcutQuantity(
  variant: Pick<InventoryLabelVariant, "available" | "stock" | "trackInventory">,
  currentQuantity: number,
  mode: LabelQuantityShortcut,
): number {
  if (mode === "one") return 1;
  if (!variant.trackInventory) return Math.max(0, Math.trunc(currentQuantity));
  return Math.max(0, mode === "onHand" ? variant.stock : variant.available);
}

export function getLabelDimensions(preset: LabelPreset) {
  return {
    widthMm: (preset.pageWidthMm - (2 * preset.marginXmm) - ((preset.columns - 1) * preset.gapXmm)) / preset.columns,
    heightMm: (preset.pageHeightMm - (2 * preset.marginYmm) - ((preset.rows - 1) * preset.gapYmm)) / preset.rows,
  };
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

/**
 * Smallest reliable printed width including quiet zones. EAN/UPC use GS1's
 * 80% minimum magnification (0.264 mm modules), which is what 38 × 25 mm
 * retail thermal labels print; Code 128 assumes 0.2 mm modules.
 */
export function estimateBarcodeWidthMm(symbol: BarcodeSymbol): number | null {
  if (!symbol.format) return null;
  if (symbol.format === "EAN13" || symbol.format === "UPC") return 29.9;
  if (symbol.format === "EAN8") return 21.4;
  if (symbol.format === "ITF14") return 48;

  const numericPairs = /^\d+$/.test(symbol.value) && symbol.value.length % 2 === 0;
  const encodedValues = numericPairs ? symbol.value.length / 2 : symbol.value.length;
  const quietZone = getBarcodeQuietZoneModules(symbol.format);
  const modulesIncludingQuietZone = (11 * (encodedValues + 2)) + 13 + quietZone.left + quietZone.right;
  return modulesIncludingQuietZone * 0.2;
}

export type BarcodeFitIssue = "unprintable" | "tooWide";

export function getBarcodeFitIssue(symbol: BarcodeSymbol, preset: LabelPreset): BarcodeFitIssue | null {
  const minimumWidth = estimateBarcodeWidthMm(symbol);
  if (symbol.error || minimumWidth === null) return "unprintable";
  return minimumWidth > getLabelDimensions(preset).widthMm - 4 ? "tooWide" : null;
}

/** The other preset, when every barcode in the job fits it. */
export function findCompatibleLabelPreset(
  symbols: readonly BarcodeSymbol[],
  currentPreset: LabelPreset,
): LabelPreset | null {
  if (symbols.length === 0) return null;
  return LABEL_PRESETS.find((candidate) => (
    candidate.id !== currentPreset.id
    && symbols.every((symbol) => getBarcodeFitIssue(symbol, candidate) === null)
  )) ?? null;
}

export type LabelCopy = {
  key: string;
  variant: InventoryLabelVariant;
  symbol: BarcodeSymbol;
};

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

export function countLabelPages(copyCount: number, preset: LabelPreset): number {
  return Math.ceil(copyCount / (preset.columns * preset.rows));
}
