import { describe, expect, it } from "vitest";

import { brandSlugSchema, isBrandId } from "./catalog-brand";
import {
  categoryDepthFromPath,
  categoryPathIds,
  categoryPlacementProblem,
  templateAssignmentSchema,
} from "./catalog-tree";

describe("category tree", () => {
  it("reads stored id paths root first", () => {
    expect(categoryPathIds("/cat_laptop/cat_gaming/")).toEqual(["cat_laptop", "cat_gaming"]);
    expect(categoryDepthFromPath("/cat_laptop/")).toBe(0);
    expect(categoryDepthFromPath("/a/b/c/d/")).toBe(3);
    for (const bad of ["", "/", "cat/", "/cat", "/a//b/", "/a/b/c/d/e/"]) {
      expect(() => categoryPathIds(bad), bad).toThrow(RangeError);
    }
  });

  it("explains the moves the database refuses", () => {
    expect(categoryPlacementProblem({ parentDepth: null, subtreeHeight: 3, parentIsInSubtree: false })).toBeNull();
    expect(categoryPlacementProblem({ parentDepth: 0, subtreeHeight: 2, parentIsInSubtree: false })).toBeNull();
    expect(categoryPlacementProblem({ parentDepth: 1, subtreeHeight: 2, parentIsInSubtree: false })).toBe("too_deep");
    expect(categoryPlacementProblem({ parentDepth: 3, subtreeHeight: 0, parentIsInSubtree: false })).toBe("too_deep");
    expect(categoryPlacementProblem({ parentDepth: 0, subtreeHeight: 0, parentIsInSubtree: true })).toBe("cycle");
  });

  it("accepts template ids in the database's shape and null for the theme default", () => {
    expect(templateAssignmentSchema.parse(null)).toBeNull();
    expect(templateAssignmentSchema.parse("landing")).toBe("landing");
    for (const bad of ["Landing", "land_ing", "", "-x", "a".repeat(41)]) {
      expect(templateAssignmentSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("allows short brand slugs and prefixed brand ids", () => {
    expect(brandSlugSchema.parse("hp")).toBe("hp");
    expect(brandSlugSchema.safeParse("Asus").success).toBe(false);
    expect(brandSlugSchema.safeParse("as--us").success).toBe(false);
    expect(isBrandId("brd_abc123")).toBe(true);
    expect(isBrandId("brand_abc123")).toBe(false);
  });
});
