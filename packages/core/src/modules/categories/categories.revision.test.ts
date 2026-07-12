import { describe, expect, it } from "vitest";
import { ValidationError } from "@scalius/core/errors";
import {
  CategoryRevisionConflictError,
  CategoryStateConflictError,
  normalizeCategoryRevisionClaims,
  rethrowCategoryRevisionConflict,
} from "./categories.revision";

function revisionReadDb(rows: Array<{ id: string; revision: number; deletedAt: Date | null }>) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({ all: async () => rows }),
      }),
    }),
  };
}

describe("category revision authority", () => {
  it("rejects duplicate and oversized revision claim sets before D1", () => {
    expect(() => normalizeCategoryRevisionClaims([
      { id: "cat_1", expectedRevision: 1 },
      { id: "cat_1", expectedRevision: 2 },
    ], 90)).toThrow(ValidationError);
    expect(() => normalizeCategoryRevisionClaims(
      Array.from({ length: 91 }, (_, index) => ({ id: `cat_${index}`, expectedRevision: 1 })),
      90,
    )).toThrow(ValidationError);
  });

  it("returns authoritative revision conflict details for stale writes", async () => {
    await expect(rethrowCategoryRevisionConflict(
      revisionReadDb([{ id: "cat_1", revision: 7, deletedAt: null }]) as never,
      [{ id: "cat_1", expectedRevision: 6 }],
      new Error("D1_ERROR: malformed JSON"),
      "active",
    )).rejects.toMatchObject({
      code: "CATEGORY_REVISION_CONFLICT",
      details: { categoryId: "cat_1", expectedRevision: 6, currentRevision: 7 },
    } satisfies Partial<CategoryRevisionConflictError>);
  });

  it("distinguishes lifecycle state conflicts from operational failures", async () => {
    await expect(rethrowCategoryRevisionConflict(
      revisionReadDb([{ id: "cat_1", revision: 7, deletedAt: new Date() }]) as never,
      [{ id: "cat_1", expectedRevision: 7 }],
      new Error("D1_ERROR: malformed JSON"),
      "active",
    )).rejects.toBeInstanceOf(CategoryStateConflictError);

    const operational = new Error("D1 network unavailable");
    await expect(rethrowCategoryRevisionConflict(
      revisionReadDb([{ id: "cat_1", revision: 7, deletedAt: null }]) as never,
      [{ id: "cat_1", expectedRevision: 7 }],
      operational,
      "active",
    )).rejects.toBe(operational);
  });
});
