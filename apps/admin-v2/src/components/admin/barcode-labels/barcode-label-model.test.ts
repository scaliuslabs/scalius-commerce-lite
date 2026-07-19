import { describe, expect, it } from "vitest";
import type { InventoryLabelVariant } from "~/lib/api-functions/inventory";
import {
  buildLabelCopies,
  buildLabelDataCsv,
  clampLabelAlignmentMm,
  clampLabelPreviewPageIndex,
  findCompatibleLabelPreset,
  formatLabelCount,
  formatPageCount,
  formatLabelPrintAlignment,
  getBarcodeFitIssue,
  getBarcodeQuietZoneModules,
  getLabelDimensions,
  getLabelInventorySummary,
  getNonPrintingLabelVariantIds,
  getLabelPreset,
  getLabelPresetIssue,
  getLabelPrintGridPosition,
  getLabelShortcutQuantity,
  isbn10ToBooklandEan13,
  MAX_LABEL_COPIES,
  orderLabelVariants,
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
  effectivePrice: 8091,
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

  it("keeps each symbology's scanner quiet zones inside the rendered SVG", () => {
    expect(getBarcodeQuietZoneModules("EAN13")).toEqual({ left: 11, right: 7 });
    expect(getBarcodeQuietZoneModules("EAN8")).toEqual({ left: 7, right: 7 });
    expect(getBarcodeQuietZoneModules("UPC")).toEqual({ left: 9, right: 9 });
    expect(getBarcodeQuietZoneModules("ITF14")).toEqual({ left: 10, right: 10 });
    expect(getBarcodeQuietZoneModules("CODE128")).toEqual({ left: 10, right: 10 });
  });

  it("refuses legacy retail identifiers whose checksum is invalid", () => {
    expect(resolveBarcodeSymbol("5901234123458", "ean13")).toMatchObject({
      format: null,
      error: "EAN-13 must be 13 digits with a valid checksum.",
    });
    expect(resolveBarcodeSymbol("036000291453", "upc")).toMatchObject({
      format: null,
      error: "UPC-A must be 12 digits with a valid checksum.",
    });
    expect(resolveBarcodeSymbol("10012345000018", "gtin")).toMatchObject({
      format: null,
      error: "GTIN must be 8, 12, 13, or 14 digits with a valid checksum.",
    });
    expect(resolveBarcodeSymbol("0306406153", "isbn")).toMatchObject({
      format: null,
      error: "ISBN must be a valid ISBN-10 or ISBN-13.",
    });
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

  it("recommends the first compatible stock without crossing printer media when avoidable", () => {
    const longSymbol = resolveBarcodeSymbol("SCALIUS:C128:zho3a3mYUeiKOnujSUeDk", "code128");
    expect(findCompatibleLabelPreset([longSymbol], getLabelPreset("a4-cut-3x8"))?.id).toBe("a4-wide-cut-2x7");
    expect(findCompatibleLabelPreset([longSymbol], getLabelPreset("thermal-50x25"))?.id).toBe("a4-wide-cut-2x7");

    const wideCut = getLabelPreset("a4-wide-cut-2x7");
    expect(wideCut.detail).toContain("Plain paper");
    expect(wideCut.cropMarks).toBe(true);

    const widerThermalSymbol = resolveBarcodeSymbol("123456789012345678901234", "code128");
    expect(getBarcodeFitIssue(widerThermalSymbol, getLabelPreset("thermal-40x30"))).not.toBeNull();
    expect(findCompatibleLabelPreset([widerThermalSymbol], getLabelPreset("thermal-40x30"))?.id).toBe("thermal-50x25");
  });

  it("recovers a preserved extra-long internal identity without shrinking its symbol", () => {
    const extraLongSymbol = resolveBarcodeSymbol(
      "SCALIUS:C128:default_prod_7ddDd0hhcPEn0crG-icvt",
      "code128",
    );

    expect(getBarcodeFitIssue(extraLongSymbol, getLabelPreset("a4-adhesive-2x7"))).toContain("safe width");
    expect(findCompatibleLabelPreset([extraLongSymbol], getLabelPreset("a4-adhesive-2x7"))?.id)
      .toBe("a4-extra-wide-cut-1x10");
    expect(getBarcodeFitIssue(extraLongSymbol, getLabelPreset("a4-extra-wide-cut-1x10"))).toBeNull();
  });
});

describe("barcode label page composition", () => {
  it("uses correct singular and plural job summaries", () => {
    expect(formatLabelCount(0)).toBe("0 labels");
    expect(formatLabelCount(1)).toBe("1 label");
    expect(formatLabelCount(2)).toBe("2 labels");
    expect(formatPageCount(0)).toBe("0 pages");
    expect(formatPageCount(1)).toBe("1 page");
    expect(formatPageCount(2)).toBe("2 pages");
  });

  it("keeps multi-page preview navigation inside the current job", () => {
    expect(clampLabelPreviewPageIndex(0, 2)).toBe(0);
    expect(clampLabelPreviewPageIndex(1, 2)).toBe(1);
    expect(clampLabelPreviewPageIndex(5, 2)).toBe(1);
    expect(clampLabelPreviewPageIndex(-1, 2)).toBe(0);
    expect(clampLabelPreviewPageIndex(1, 0)).toBe(0);
  });

  it("keeps device alignment correction bounded and readable", () => {
    expect(clampLabelAlignmentMm(Number.NaN)).toBe(0);
    expect(clampLabelAlignmentMm(-7)).toBe(-5);
    expect(clampLabelAlignmentMm(2.5)).toBe(2.5);
    expect(clampLabelAlignmentMm(8)).toBe(5);
    expect(formatLabelPrintAlignment({ xMm: 0, yMm: 0 })).toBe("Default");
    expect(formatLabelPrintAlignment({ xMm: 1.5, yMm: -0.5 })).toBe("1.5 mm right · 0.5 mm up");
    expect(getLabelPrintGridPosition(getLabelPreset("a4-cut-3x8"), { xMm: 1.5, yMm: -0.5 })).toEqual({
      leftMm: 9.5,
      topMm: 7.5,
    });
  });

  it("keeps quantity shortcuts explainable with their exact inventory source", () => {
    expect(getLabelInventorySummary(variant)).toBe("18 on hand · 17 available");
    expect(getLabelInventorySummary({ ...variant, trackInventory: false })).toBe("Inventory not tracked");
    expect(getLabelShortcutQuantity(variant, 3, "onHand")).toBe(18);
    expect(getLabelShortcutQuantity(variant, 3, "available")).toBe(17);
    expect(getLabelShortcutQuantity({ ...variant, trackInventory: false }, 3, "onHand")).toBe(3);
    expect(getLabelShortcutQuantity({ ...variant, trackInventory: false }, 3, "available")).toBe(3);
    expect(getLabelShortcutQuantity({ ...variant, trackInventory: false }, 3, "one")).toBe(1);
  });

  it("arranges physical output without changing the selected SKU identities", () => {
    const alpha = {
      ...variant,
      id: "var_2",
      productName: "Aster Studio Clogs",
      optionLabel: "Size 41",
      sku: "ASTER-41",
    };
    const kori40 = {
      ...variant,
      id: "var_3",
      optionLabel: "Size 40",
      sku: "KORI-40-SAND",
    };
    const selected = [variant, alpha, kori40];

    expect(orderLabelVariants(selected, "selected").map((item) => item.id)).toEqual(["var_1", "var_2", "var_3"]);
    expect(orderLabelVariants(selected, "product").map((item) => item.id)).toEqual(["var_2", "var_3", "var_1"]);
    expect(orderLabelVariants(selected, "sku").map((item) => item.id)).toEqual(["var_2", "var_3", "var_1"]);
    expect(selected.map((item) => item.id)).toEqual(["var_1", "var_2", "var_3"]);
  });

  it("finds zero-count rows without treating a fresh selection as zero", () => {
    const second = { ...variant, id: "var_2" };
    expect(getNonPrintingLabelVariantIds([variant, second], { var_1: 0 })).toEqual(["var_1"]);
    expect(getNonPrintingLabelVariantIds([variant, second], { var_1: -4, var_2: 2 })).toEqual(["var_1"]);
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

  it("exports one formula-safe UTF-8 row per physical label in reviewed order", () => {
    const risky = {
      ...variant,
      id: "var_2",
      productName: "=HYPERLINK(\"https://invalid.example\")",
      optionLabel: "বাংলা / Sand",
      sku: "+FORMULA",
      barcode: "12345678901234",
    };
    const copies = buildLabelCopies([variant, risky], { var_1: 2, var_2: 1 });
    const csv = buildLabelDataCsv(copies, (price) => `৳${price}`);
    const lines = csv.slice(1).split("\r\n");

    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain('"1","Kori Studio Trainer"');
    expect(lines[2]).toContain('"2","Kori Studio Trainer"');
    expect(lines[3]).toContain('"3","\'=HYPERLINK(""https://invalid.example"")"');
    expect(lines[3]).toContain('"বাংলা / Sand","\'+FORMULA"');
    expect(lines[3]).toContain('"CODE128","12345678901234"');
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
