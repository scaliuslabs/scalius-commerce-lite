import { describe, expect, it } from "vitest";
import { buildDuplicateVariantDraft } from "./duplicateVariantDraft";
import type { ProductVariant } from "../types";

describe("buildDuplicateVariantDraft", () => {
  it("copies merchandising fields but clears persisted identity and stock", () => {
    const draft = buildDuplicateVariantDraft(variant());

    expect(draft).toMatchObject({
      size: "M",
      color: "",
      weight: 0.5,
      price: 1200,
      discountType: "flat",
      discountAmount: 100,
      sku: "",
      barcode: null,
      barcodeType: null,
      stock: 0,
    });
  });

  it("clears the only populated option axis so an exact duplicate cannot submit", () => {
    expect(
      buildDuplicateVariantDraft(variant({ color: null })).size,
    ).toBe("");
    expect(
      buildDuplicateVariantDraft(variant({ size: null })).color,
    ).toBe("");
  });
});

function variant(overrides: Partial<ProductVariant> = {}): ProductVariant {
  return {
    id: "variant_1",
    size: "M",
    color: "Blue",
    weight: 0.5,
    sku: "TEE-M-BLUE",
    price: 1200,
    stock: 9,
    reservedStock: 2,
    trackInventory: true,
    barcode: "1234567890123",
    barcodeType: "ean13",
    discountType: "flat",
    discountPercentage: null,
    discountAmount: 100,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    deletedAt: null,
    ...overrides,
  };
}
