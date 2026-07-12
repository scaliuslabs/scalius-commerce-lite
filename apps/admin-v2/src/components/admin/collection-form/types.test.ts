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
    maxProducts: 8,
  },
};

describe("collection form canonical validation", () => {
  it("accepts collection routes for collection canonical overrides", () => {
    const result = collectionFormSchema.safeParse({
      ...collectionValues,
      canonicalPath: "/collections/col_1",
    });

    expect(result.success).toBe(true);
  });

  it("rejects non-collection routes for collection canonical overrides", () => {
    for (const canonicalPath of [
      "/featured/summer",
      "/collections/summer-edit",
    ]) {
      const result = collectionFormSchema.safeParse({
        ...collectionValues,
        canonicalPath,
      });

      expect(result.success).toBe(false);
    }
  });
});
