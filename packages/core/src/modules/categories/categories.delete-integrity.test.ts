import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { categories, collections, products } from "@scalius/database/schema";
import { ConflictError, ValidationError } from "@scalius/core/errors";
import { bulkDeleteCategories, restoreCategories } from "./categories.service";

describe("category permanent delete integrity", () => {
  it("preserves non-target membership while batching collection cleanup with delete", async () => {
    const batchCalls: unknown[][] = [];
    const db = {
      select() {
        return {
          from(table: unknown) {
            return {
              kind: "guard",
              all: async () => table === collections ? [
                {
                  id: "col_1",
                  name: "Seasonal",
                  isActive: false,
                  deletedAt: null,
                  config: JSON.stringify({
                    source: "dynamic",
                    categoryIds: ["cat_delete", "cat_keep"],
                  }),
                },
              ] : [],
              where() {
                if (table === products) {
                  return { limit: () => ({ all: async () => [] }) };
                }
                if (table === categories) {
                  return { all: async () => [{ id: "cat_delete", deletedAt: new Date(), revision: 1 }] };
                }
                if (table === collections) {
                  return { all: async () => [{
                    id: "col_1",
                    name: "Seasonal",
                    isActive: false,
                    deletedAt: null,
                    config: JSON.stringify({
                      source: "dynamic",
                      categoryIds: ["cat_delete", "cat_keep"],
                    }),
                  }] };
                }
                return { all: async () => [] };
              },
            };
          },
        };
      },
      update(table: unknown) {
        return {
          set(values: Record<string, unknown>) {
            return {
              where() {
                return { kind: "update", table, values };
              },
            };
          },
        };
      },
      run() {
        return { kind: "guard" };
      },
      delete(table: unknown) {
        return {
          where() {
            return {
              returning() {
                return { kind: "delete", table };
              },
            };
          },
        };
      },
      async batch(statements: unknown[]) {
        batchCalls.push(statements);
        return statements.map((statement, index) =>
          index === statements.length - 1 ? [{ id: "cat_delete" }] : [],
        );
      },
    };

    await bulkDeleteCategories(db as never, [{ id: "cat_delete", expectedRevision: 1 }], true);

    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toHaveLength(5);
    expect(batchCalls[0]?.[0]).toMatchObject({ kind: "guard" });
    expect(batchCalls[0]?.[2]).toMatchObject({
      kind: "update",
      table: products,
    });
    expect(batchCalls[0]?.[3]).toMatchObject({
      kind: "update",
      table: collections,
      values: {
        config: JSON.stringify({
          source: "dynamic",
          categoryIds: ["cat_keep"],
        }),
      },
    });
    expect(batchCalls[0]?.[4]).toMatchObject({ kind: "delete" });
  });

  it("routes single permanent delete through the bulk cleanup primitive", () => {
    const source = readFileSync(
      new URL("./categories.service.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("await bulkDeleteCategories(db, [{ id, expectedRevision }], true)");
  });

  it("routes single soft delete through the same atomic bulk guard", () => {
    const source = readFileSync(
      new URL("./categories.service.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("await bulkDeleteCategories(db, [{ id, expectedRevision }], false)");
    expect(source).toContain("categoryDeleteUsageGuard(db, claims)");
  });

  it("fails closed when a product is assigned after the initial usage read", async () => {
    const db = {
      select() {
        return {
          from(table: unknown) {
            return {
              kind: "guard",
              all: async () => [],
              where() {
                if (table === products) {
                  return { limit: () => ({ all: async () => [] }) };
                }
                if (table === categories) {
                  return { all: async () => [{ id: "cat_delete", deletedAt: new Date(), revision: 1 }] };
                }
                return { all: async () => [] };
              },
            };
          },
        };
      },
      run() {
        return { kind: "guard" };
      },
      update() {
        return { set: () => ({ where: () => ({ kind: "update" }) }) };
      },
      delete() {
        return { where: () => ({ returning: () => ({ kind: "delete" }) }) };
      },
      async batch() {
        throw new Error("D1_ERROR: malformed JSON");
      },
    };

    await expect(
      bulkDeleteCategories(db as never, [{ id: "cat_delete", expectedRevision: 1 }], true),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("requires trash before permanent deletion", async () => {
    const db = {
      select() {
        return {
          from(table: unknown) {
            return {
              where() {
                if (table === products) {
                  return { limit: () => ({ all: async () => [] }) };
                }
                return { all: async () => [{ id: "cat_active", deletedAt: null }] };
              },
            };
          },
        };
      },
      update() {
        return { set: () => ({ where: () => ({ kind: "update" }) }) };
      },
      run() {
        return { kind: "guard" };
      },
    };

    await expect(
      bulkDeleteCategories(db as never, [{ id: "cat_active", expectedRevision: 1 }], true),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("does not orphan an active dynamic collection", async () => {
    const db = {
      select() {
        return {
          from(table: unknown) {
            return {
              where() {
                if (table === products) {
                  return { limit: () => ({ all: async () => [] }) };
                }
                if (table === categories) {
                  return { all: async () => [{ id: "cat_delete", deletedAt: new Date(), revision: 1 }] };
                }
                if (table === collections) {
                  return { all: async () => [{
                    id: "col_1",
                    name: "Featured shoes",
                    isActive: true,
                    deletedAt: null,
                    config: JSON.stringify({ source: "dynamic", categoryIds: ["cat_delete"] }),
                  }] };
                }
                return { all: async () => [] };
              },
              all: async () => table === collections ? [{
                id: "col_1",
                name: "Featured shoes",
                isActive: true,
                deletedAt: null,
                config: JSON.stringify({ source: "dynamic", categoryIds: ["cat_delete"] }),
              }] : [],
            };
          },
        };
      },
      update() {
        return { set: () => ({ where: () => ({ kind: "update" }) }) };
      },
      run() {
        return { kind: "guard" };
      },
    };

    await expect(
      bulkDeleteCategories(db as never, [{ id: "cat_delete", expectedRevision: 1 }], true),
    ).rejects.toThrow("without a source");
  });

  it("caps restore sets before constructing a D1 query", async () => {
    const claims = Array.from({ length: 91 }, (_, index) => ({
      id: `cat_${index}`,
      expectedRevision: 1,
    }));
    await expect(restoreCategories({} as never, claims))
      .rejects.toBeInstanceOf(ValidationError);
  });
});
