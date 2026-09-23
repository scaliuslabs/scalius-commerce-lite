import { describe, expect, it } from "vitest";
import { collectionFormSchema } from "./types";

const collectionValues = {
  name: "Summer Edit",
  presentation: "grid" as const,
  isActive: false,
  canonicalPath: null,
  noIndex: false,
  excludeFromSitemap: false,
  config: {
    source: "manual" as const,
    categoryIds: [],
    productIds: [],
    showOnHomepage: false,
    maxProducts: 8,
  },
};

describe("collection form schema", () => {
  it("round-trips a saved main page address it doesn't edit", () => {
    const result = collectionFormSchema.safeParse({
      ...collectionValues,
      canonicalPath: "/collections/col_1",
    });

    expect(result.success && result.data.canonicalPath).toBe("/collections/col_1");
  });

  it("rejects category IDs in manual product membership", () => {
    const result = collectionFormSchema.safeParse({
      ...collectionValues,
      config: { ...collectionValues.config, productIds: ["cat_footwear"] },
    });

    expect(result.success).toBe(false);
  });

  it("needs a product or a category before the collection is active", () => {
    const manual = collectionFormSchema.safeParse({ ...collectionValues, isActive: true });
    const automatic = collectionFormSchema.safeParse({
      ...collectionValues,
      isActive: true,
      config: { ...collectionValues.config, source: "dynamic" },
    });

    expect(manual.error?.issues.map((issue) => issue.path.join("."))).toEqual(["config.productIds"]);
    expect(automatic.error?.issues.map((issue) => issue.path.join("."))).toEqual(["config.categoryIds"]);
  });
});
