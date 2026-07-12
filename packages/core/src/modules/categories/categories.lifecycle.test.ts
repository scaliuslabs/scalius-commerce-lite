import { describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@scalius/core/errors";
import {
  createCategory,
  updateCategory,
  updateCategoryStatus,
} from "./categories.service";

const input = {
  name: "Summer Shoes",
  description: null,
  slug: "summer-shoes",
  metaTitle: null,
  metaDescription: null,
  canonicalPath: null,
  noIndex: false,
  excludeFromSitemap: false,
  image: null,
};

function categoryLookupDb(row: { id: string; deletedAt: Date | null }) {
  return {
    select() {
      return {
        from() {
          return { where: () => ({ get: async () => row }) };
        },
      };
    },
  };
}

describe("category lifecycle authority", () => {
  it("reserves trashed slugs and names the recovery path", async () => {
    await expect(createCategory(
      categoryLookupDb({ id: "cat_trashed", deletedAt: new Date() }) as never,
      input,
    )).rejects.toThrow("exists in trash");
  });

  it("blocks active edits against a trashed category", async () => {
    await expect(updateCategory(
      categoryLookupDb({ id: "cat_trashed", deletedAt: new Date() }) as never,
      "cat_trashed",
      { ...input, expectedRevision: 1, status: "draft" },
    )).rejects.toBeInstanceOf(ConflictError);
  });

  it("blocks hiding a category referenced by an active dynamic collection", async () => {
    const db = {
      select() {
        const chain = {
          from: () => chain,
          where: () => chain,
          limit: () => chain,
          get: async () => ({ id: "cat_live", revision: 4, deletedAt: null }),
          all: async () => [{ id: "col_live", name: "Homepage picks" }],
        };
        return chain;
      },
    };

    await expect(updateCategoryStatus(db as never, "cat_live", {
      expectedRevision: 4,
      status: "internal",
    })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateCategoryStatus(db as never, "cat_live", {
      expectedRevision: 4,
      status: "draft",
    })).rejects.toThrow(/deactivate those collections/i);
  });
});
