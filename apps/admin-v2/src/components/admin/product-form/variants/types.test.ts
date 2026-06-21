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

  it("requires option rows to provide a size, color, or both", () => {
    const result = variantOptionFormSchema.safeParse(baseValues);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors).toMatchObject({
        size: ["Add a size, color, or both."],
        color: ["Add a size, color, or both."],
      });
    }
  });
});
