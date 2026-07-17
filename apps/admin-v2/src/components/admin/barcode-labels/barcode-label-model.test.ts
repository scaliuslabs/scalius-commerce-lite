import { describe, expect, it } from "vitest";
import type { InventoryLabelVariant } from "~/lib/api-functions/inventory";
import {
  buildLabelCopies,
  getBarcodeFitIssue,
  getLabelDimensions,
  getLabelInventorySummary,
  getLabelPreset,
  getLabelPresetIssue,
  isbn10ToBooklandEan13,
  MAX_LABEL_COPIES,
  paginateLabelCopies,
  resolveBarcodeSymbol,
} from "./barcode-label-model";

const variant: InventoryLabelVariant = {
  id: "var_1",
  productId: "prod_1",
  productName: "Kori Studio Trainer",
  sku: "KORI-42-SAND",
  optionLabel: "Size 42 / Color Sand",
  price: 8990,
  stock: 18,
  reservedStock: 1,
  available: 17,
  barcode: "99012345678901",
  barcodeType: "code128",
  trackInventory: true,
};

describe("barcode label symbology", () => {
  it("preserves the saved retail symbology instead of rendering every value as Code 128", () => {
    expect(resolveBarcodeSymbol("5901234123457", "ean13").format).toBe("EAN13");
    expect(resolveBarcodeSymbol("036000291452", "upc").format).toBe("UPC");
    expect(resolveBarcodeSymbol("96385074", "gtin").format).toBe("EAN8");
    expect(resolveBarcodeSymbol("10012345000017", "gtin").format).toBe("ITF14");
  });

  it("converts ISBN-10 to its Bookland EAN-13 symbol without changing the display value", () => {
    expect(isbn10ToBooklandEan13("0306406152")).toBe("9780306406157");
    expect(resolveBarcodeSymbol("0306406152", "isbn")).toMatchObject({
      format: "EAN13",
      value: "9780306406157",
      displayValue: "0306406152",
      error: null,
    });
  });

  it("rejects non-ASCII custom values instead of silently switching to QR", () => {
    expect(resolveBarcodeSymbol("পণ্য-১", "custom")).toMatchObject({
      format: null,
      error: "This value cannot be encoded as a printable Code 128 label.",
    });
  });

  it("warns when a legacy long Code 128 value cannot safely fit thermal stock", () => {
    const symbol = resolveBarcodeSymbol("SCALIUS:C128:zho3a3mYUeiKOnujSUeDk", "code128");
    expect(getBarcodeFitIssue(symbol, getLabelPreset("thermal-50x25"))).toContain("safe width");
    expect(getBarcodeFitIssue(resolveBarcodeSymbol(variant.barcode, variant.barcodeType), getLabelPreset("thermal-50x25"))).toBeNull();
  });
});

describe("barcode label page composition", () => {
  it("keeps quantity shortcuts explainable with their exact inventory source", () => {
    expect(getLabelInventorySummary(variant)).toBe("18 on hand · 17 available");
    expect(getLabelInventorySummary({ ...variant, trackInventory: false })).toBe("Inventory not tracked");
  });

  it("uses physical page dimensions for the A4 cut-sheet grid", () => {
    const dimensions = getLabelDimensions(getLabelPreset("a4-cut-3x8"));
    expect(dimensions.widthMm).toBeCloseTo(63.33, 1);
    expect(dimensions.heightMm).toBeCloseTo(33.38, 1);
  });

  it("expands exact per-SKU quantities and paginates deterministically", () => {
    const copies = buildLabelCopies([variant], { [variant.id]: 25 });
    expect(copies).toHaveLength(25);
    expect(paginateLabelCopies(copies, getLabelPreset("a4-cut-3x8")).map((page) => page.length)).toEqual([24, 1]);
  });

  it("keeps used sheet cells empty before placing the first printable label", () => {
    const copies = buildLabelCopies([variant], { [variant.id]: 23 });
    const pages = paginateLabelCopies(copies, getLabelPreset("a4-cut-3x8"), 3);
    expect(pages).toHaveLength(2);
    expect(pages[0].slice(0, 3)).toEqual([null, null, null]);
    expect(pages[0].filter(Boolean)).toHaveLength(21);
    expect(pages[1].filter(Boolean)).toHaveLength(2);
  });

  it("rejects custom grids whose physical cells are too small to use safely", () => {
    const custom = { ...getLabelPreset("custom"), columns: 10, marginXmm: 20 };
    expect(getLabelPresetIssue(custom)).toContain("at least 20 mm of width");
    expect(getLabelPresetIssue({ ...custom, columns: 3 })).toBeNull();
  });

  it("surfaces one copy beyond the cap so the UI can block an oversized job", () => {
    const copies = buildLabelCopies([variant], { [variant.id]: MAX_LABEL_COPIES });
    expect(copies).toHaveLength(MAX_LABEL_COPIES);
    const second = { ...variant, id: "var_2", barcode: "99012345678902" };
    expect(buildLabelCopies([variant, second], { var_1: MAX_LABEL_COPIES, var_2: 1 })).toHaveLength(MAX_LABEL_COPIES + 1);
  });
});
