import { describe, expect, it } from "vitest";
import { ConflictError } from "@scalius/core/errors";
import { createCategory, updateCategory } from "./categories.service";

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
});
