import { describe, expect, it } from "vitest";
import type { ProductVariant } from "../types";
import {
  getVariantManagementMode,
  isSimpleDefaultVariant,
  variantsForOptionMatrix,
} from "./variantMode";

const baseVariant: ProductVariant = {
  id: "var_1",
  size: null,
  color: null,
  weight: null,
  sku: "SIMPLE-prod_1",
  price: 5000,
  stock: 0,
  reservedStock: 0,
  isDefault: true,
  trackInventory: false,
  barcode: null,
  barcodeType: null,
  discountType: "percentage",
  discountPercentage: null,
  discountAmount: null,
  createdAt: new Date("2026-06-21T00:00:00Z"),
  updatedAt: new Date("2026-06-21T00:00:00Z"),
  deletedAt: null,
};

describe("admin variant management mode", () => {
  it("classifies one protected no-option SKU as a simple product", () => {
    const mode = getVariantManagementMode([baseVariant]);

    expect(mode).toMatchObject({ mode: "simple", variant: baseVariant });
    expect(isSimpleDefaultVariant(baseVariant)).toBe(true);
  });

  it("classifies a legacy default SKU with option labels as a simple product", () => {
    const legacyDefaultSku = {
      ...baseVariant,
      size: "Default",
      color: "Default",
    };

    const mode = getVariantManagementMode([legacyDefaultSku]);

    expect(mode).toMatchObject({ mode: "simple", variant: legacyDefaultSku });
    expect(isSimpleDefaultVariant(legacyDefaultSku)).toBe(true);
  });

  it("ignores soft-deleted option rows when classifying a simple product", () => {
    const deletedOption = {
      ...baseVariant,
      id: "var_deleted",
      sku: "DELETED-OPTION",
      isDefault: false,
      size: "XL",
      trackInventory: true,
      deletedAt: new Date("2026-06-22T00:00:00Z"),
    };

    const variants = [baseVariant, deletedOption];
    const mode = getVariantManagementMode(variants);

    expect(mode).toMatchObject({ mode: "simple", variant: baseVariant });
    expect(variantsForOptionMatrix(variants)).toEqual([baseVariant]);
  });

  it("does not reserve a soft-deleted default SKU for optioned products", () => {
    const deletedDefaultSku = {
      ...baseVariant,
      deletedAt: new Date("2026-06-22T00:00:00Z"),
    };
    const optionVariant = {
      ...baseVariant,
      id: "var_red",
      sku: "TEE-RED",
      isDefault: false,
      color: "Red",
      trackInventory: true,
    };

    const mode = getVariantManagementMode([deletedDefaultSku, optionVariant]);

    expect(mode).toMatchObject({
      mode: "optioned",
      variants: [optionVariant],
      hiddenSimpleSku: null,
    });
    expect(variantsForOptionMatrix([deletedDefaultSku, optionVariant])).toEqual([optionVariant]);
  });

  it("treats all-deleted SKU arrays as empty", () => {
    const deletedDefaultSku = {
      ...baseVariant,
      deletedAt: new Date("2026-06-22T00:00:00Z"),
    };

    expect(getVariantManagementMode([deletedDefaultSku])).toMatchObject({ mode: "empty" });
    expect(variantsForOptionMatrix([deletedDefaultSku])).toEqual([]);
  });

  it("keeps one non-default no-option SKU ambiguous instead of normalizing bad data", () => {
    const invalidSimpleSku = {
      ...baseVariant,
      isDefault: false,
    };

    const mode = getVariantManagementMode([invalidSimpleSku]);

    expect(mode).toMatchObject({ mode: "ambiguous", variants: [invalidSimpleSku] });
    expect(isSimpleDefaultVariant(invalidSimpleSku)).toBe(false);
  });

  it("classifies customer option SKUs as optioned and hides the simple SKU from the matrix", () => {
    const optionVariant = {
      ...baseVariant,
      id: "var_red",
      sku: "TEE-RED",
      isDefault: false,
      color: "Red",
      trackInventory: true,
    };

    const mode = getVariantManagementMode([baseVariant, optionVariant]);

    expect(mode).toMatchObject({
      mode: "optioned",
      variants: [optionVariant],
      hiddenSimpleSku: baseVariant,
    });
    expect(variantsForOptionMatrix([baseVariant, optionVariant])).toEqual([optionVariant]);
  });

  it("keeps malformed no-option variant sets in the matrix so they fail visibly", () => {
    const secondNoOption = {
      ...baseVariant,
      id: "var_2",
      sku: "NO-OPTION-2",
      isDefault: false,
    };

    const mode = getVariantManagementMode([baseVariant, secondNoOption]);

    expect(mode).toMatchObject({ mode: "ambiguous" });
    expect(variantsForOptionMatrix([baseVariant, secondNoOption])).toEqual([
      baseVariant,
      secondNoOption,
    ]);
  });

  it("does not hide malformed no-option rows on optioned products", () => {
    const optionVariant = {
      ...baseVariant,
      id: "var_red",
      sku: "TEE-RED",
      isDefault: false,
      color: "Red",
      trackInventory: true,
    };
    const malformedNoOption = {
      ...baseVariant,
      id: "var_no_option",
      sku: "NO-OPTION",
      isDefault: false,
    };

    const mode = getVariantManagementMode([optionVariant, malformedNoOption]);

    expect(mode).toMatchObject({ mode: "ambiguous" });
    expect(variantsForOptionMatrix([optionVariant, malformedNoOption])).toEqual([
      optionVariant,
      malformedNoOption,
    ]);
  });
});
