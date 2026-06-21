import { describe, expect, it } from "vitest";
import { generateVariantCombinations } from "./variantHelpers";
import type { BulkVariantOptions } from "../types";

const baseOptions: BulkVariantOptions = {
  sizes: [],
  colors: [],
  basePrice: 100,
  baseStock: 5,
  baseWeight: null,
  skuTemplate: "{SLUG}-{SIZE}-{COLOR}-{INDEX}",
  discountType: "percentage",
  discountValue: null,
  generateBarcodes: false,
};

describe("variant option helper boundaries", () => {
  it("does not generate no-option SKUs from an empty bulk option set", () => {
    expect(generateVariantCombinations(baseOptions, "shirt")).toEqual([]);
  });

  it("generates customer option SKUs when at least one option axis exists", () => {
    expect(
      generateVariantCombinations(
        {
          ...baseOptions,
          sizes: ["M", "L"],
        },
        "shirt",
      ),
    ).toHaveLength(2);
  });
});
