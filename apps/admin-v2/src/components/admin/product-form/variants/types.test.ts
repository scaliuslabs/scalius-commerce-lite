import { describe, expect, it } from "vitest";

import { variantFormSchema, variantOptionFormSchema } from "./types";

const baseValues = {
  size: "",
  color: "",
  weight: null,
  sku: "SKU-1",
  barcode: null,
  barcodeType: null,
  price: 100,
  stock: 0,
  trackInventory: false,
  discountType: "percentage" as const,
  discountPercentage: null,
  discountAmount: null,
};

describe("variant form schemas", () => {
  it("keeps the base SKU schema usable for simple products without options", () => {
    expect(variantFormSchema.safeParse(baseValues).success).toBe(true);
  });

  it("requires option rows to provide Option 1, Option 2, or both", () => {
    const result = variantOptionFormSchema.safeParse(baseValues);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors).toMatchObject({
        size: ["Add Option 1, Option 2, or both."],
        color: ["Add Option 1, Option 2, or both."],
      });
    }
  });

  it("rejects incomplete and invalid barcode identities before save", () => {
    const missingType = variantFormSchema.safeParse({
      ...baseValues,
      barcode: "5901234123457",
    });
    expect(missingType.success).toBe(false);

    const badChecksum = variantFormSchema.safeParse({
      ...baseValues,
      barcode: "5901234123458",
      barcodeType: "ean13",
    });
    expect(badChecksum.success).toBe(false);

    expect(variantFormSchema.safeParse({
      ...baseValues,
      barcode: " 5901234123457 ",
      barcodeType: "ean13",
    }).success).toBe(true);
  });
});
