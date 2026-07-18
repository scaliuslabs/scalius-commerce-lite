import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { calculateInventoryLabelEffectivePrice } from "./inventory.service";

const source = readFileSync(new URL("./inventory.service.ts", import.meta.url), "utf8");

describe("inventory barcode label projection boundaries", () => {
  it("uses one bounded json_each lookup and preserves requested SKU order", () => {
    expect(source).toContain("INVENTORY_LABEL_VARIANT_LIMIT = 150");
    expect(source).toContain("FROM json_each(${variantIdSet})");
    expect(source).toContain("variantIds.flatMap((id)");
    expect(source).toContain("missingVariantIds: variantIds.filter");
  });

  it("projects exact barcode and operational stock facts without mutating inventory", () => {
    expect(source).toContain("barcode: productVariants.barcode");
    expect(source).toContain("barcodeType: productVariants.barcodeType");
    expect(source).toContain("reservedStock: productVariants.reservedStock");
    expect(source).toContain("operationalSkuRowPredicate()");
  });

  it("projects the buyer-effective automatic catalog price without exposing discount internals", () => {
    expect(source).toContain("calculateInventoryLabelEffectivePrice");
    expect(source).toContain("hasVariantDiscount ? facts.variantDiscountType : facts.productDiscountType");
    expect(source).toContain("effectivePrice: calculateInventoryLabelEffectivePrice");

    const base = {
      price: 1_000,
      variantDiscountType: null,
      variantDiscountPercentage: null,
      variantDiscountAmount: null,
      productDiscountType: "percentage",
      productDiscountPercentage: 10,
      productDiscountAmount: null,
    };
    expect(calculateInventoryLabelEffectivePrice(base)).toBe(900);
    expect(calculateInventoryLabelEffectivePrice({
      ...base,
      variantDiscountType: "flat",
      variantDiscountAmount: 250,
    })).toBe(750);
    expect(calculateInventoryLabelEffectivePrice({
      ...base,
      variantDiscountType: "percentage",
      variantDiscountPercentage: 0,
    })).toBe(900);
  });
});
