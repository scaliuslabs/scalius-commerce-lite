import { describe, expect, it } from "vitest";
import type { InventoryLabelVariant } from "~/lib/api-query-options/inventory";
import {
  buildLabelCopies,
  countLabelPages,
  findCompatibleLabelPreset,
  getBarcodeFitIssue,
  getBarcodeQuietZoneModules,
  getLabelDimensions,
  getLabelPreset,
  getLabelShortcutQuantity,
  isbn10ToBooklandEan13,
  LABEL_PRESETS,
  MAX_LABEL_COPIES,
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

const a4 = getLabelPreset("a4");
const thermal = getLabelPreset("thermal-38x25");

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

  it("refuses retail identifiers whose checksum is invalid", () => {
    expect(resolveBarcodeSymbol("5901234123458", "ean13")).toMatchObject({ format: null });
    expect(resolveBarcodeSymbol("036000291453", "upc")).toMatchObject({ format: null });
    expect(resolveBarcodeSymbol("10012345000018", "gtin")).toMatchObject({ format: null });
    expect(resolveBarcodeSymbol("0306406153", "isbn")).toMatchObject({ format: null });
    expect(getBarcodeFitIssue(resolveBarcodeSymbol("5901234123458", "ean13"), a4)).toBe("unprintable");
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
    expect(resolveBarcodeSymbol("পণ্য-১", "custom").format).toBeNull();
    expect(resolveBarcodeSymbol(null, "code128").format).toBeNull();
  });
});

describe("barcode label presets and fit", () => {
  it("offers exactly the A4 sheet and the 38 × 25 mm thermal roll", () => {
    expect(LABEL_PRESETS.map((preset) => preset.id)).toEqual(["a4", "thermal-38x25"]);
    const sheetLabel = getLabelDimensions(a4);
    expect(sheetLabel.widthMm).toBeCloseTo(63.33, 1);
    expect(sheetLabel.heightMm).toBeCloseTo(33.38, 1);
    expect(getLabelDimensions(thermal)).toEqual({ widthMm: 35, heightMm: 22 });
  });

  it("fits retail EAN-13, UPC and short Code 128 barcodes on 38 × 25 mm thermal labels", () => {
    expect(getBarcodeFitIssue(resolveBarcodeSymbol("5901234123457", "ean13"), thermal)).toBeNull();
    expect(getBarcodeFitIssue(resolveBarcodeSymbol("036000291452", "upc"), thermal)).toBeNull();
    expect(getBarcodeFitIssue(resolveBarcodeSymbol(variant.barcode, variant.barcodeType), thermal)).toBeNull();
  });

  it("flags barcodes too wide for thermal labels and suggests the A4 sheet", () => {
    const itf = resolveBarcodeSymbol("10012345000017", "gtin");
    expect(getBarcodeFitIssue(itf, thermal)).toBe("tooWide");
    expect(getBarcodeFitIssue(itf, a4)).toBeNull();
    expect(findCompatibleLabelPreset([itf], thermal)?.id).toBe("a4");
  });

  it("suggests nothing when a barcode fits neither preset", () => {
    const extraLong = resolveBarcodeSymbol("SCALIUS:C128:default_prod_7ddDd0hhcPEn0crG-icvt", "code128");
    expect(getBarcodeFitIssue(extraLong, a4)).toBe("tooWide");
    expect(findCompatibleLabelPreset([extraLong], a4)).toBeNull();
    expect(findCompatibleLabelPreset([], a4)).toBeNull();
  });
});

describe("barcode label quantities", () => {
  it("fills quantity shortcuts from the variant's own stock", () => {
    expect(getLabelShortcutQuantity(variant, 3, "onHand")).toBe(18);
    expect(getLabelShortcutQuantity(variant, 3, "available")).toBe(17);
    expect(getLabelShortcutQuantity({ ...variant, available: -2 }, 3, "available")).toBe(0);
    expect(getLabelShortcutQuantity({ ...variant, trackInventory: false }, 3, "onHand")).toBe(3);
    expect(getLabelShortcutQuantity({ ...variant, trackInventory: false }, 3, "available")).toBe(3);
    expect(getLabelShortcutQuantity({ ...variant, trackInventory: false }, 3, "one")).toBe(1);
  });

  it("expands exact per-variant quantities and counts printed pages", () => {
    const copies = buildLabelCopies([variant], { [variant.id]: 25 });
    expect(copies).toHaveLength(25);
    expect(countLabelPages(copies.length, a4)).toBe(2);
    expect(countLabelPages(copies.length, thermal)).toBe(25);
    expect(buildLabelCopies([variant], { [variant.id]: -3 })).toHaveLength(0);
  });

  it("surfaces one copy beyond the cap so the UI can block an oversized job", () => {
    expect(buildLabelCopies([variant], { [variant.id]: MAX_LABEL_COPIES })).toHaveLength(MAX_LABEL_COPIES);
    const second = { ...variant, id: "var_2", barcode: "99012345678902" };
    expect(buildLabelCopies([variant, second], { var_1: MAX_LABEL_COPIES, var_2: 1 })).toHaveLength(MAX_LABEL_COPIES + 1);
  });
});
