import { describe, expect, it } from "vitest";
import { collectionFormSchema } from "./types";

const collectionValues = {
  name: "Summer Edit",
  type: "manual" as const,
  isActive: true,
  canonicalPath: null,
  noIndex: false,
  excludeFromSitemap: false,
  config: {
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
    const result = collectionFormSchema.safeParse({
      ...collectionValues,
      canonicalPath: "/featured/summer",
    });

    expect(result.success).toBe(false);
  });
});
