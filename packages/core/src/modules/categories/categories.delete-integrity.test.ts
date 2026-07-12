import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collections, products } from "@scalius/database/schema";
import { ValidationError } from "@scalius/core/errors";
import { bulkDeleteCategories } from "./categories.service";

describe("category permanent delete integrity", () => {
  it("batches collection cleanup with the category delete", async () => {
    let selectCount = 0;
    const batchCalls: unknown[][] = [];
    const db = {
      select() {
        selectCount++;
        return {
          from() {
            return {
              kind: "guard",
              where() {
                if (selectCount === 1) {
                  return { limit: () => ({ all: async () => [] }) };
                }
                return {
                  all: async () => [
                    {
                      id: "col_1",
                      config: JSON.stringify({
                        categoryIds: ["cat_delete", "cat_keep"],
                      }),
                    },
                  ],
                };
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
            return { kind: "delete", table };
          },
        };
      },
      async batch(statements: unknown[]) {
        batchCalls.push(statements);
        return statements.map(() => []);
      },
    };

    await bulkDeleteCategories(db as never, ["cat_delete"], true);

    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toHaveLength(4);
    expect(batchCalls[0]?.[0]).toMatchObject({ kind: "guard" });
    expect(batchCalls[0]?.[1]).toMatchObject({
      kind: "update",
      table: products,
    });
    expect(batchCalls[0]?.[2]).toMatchObject({
      kind: "update",
      table: collections,
      values: {
        config: JSON.stringify({ categoryIds: ["cat_keep"] }),
      },
    });
    expect(batchCalls[0]?.[3]).toMatchObject({ kind: "delete" });
  });

  it("routes single permanent delete through the bulk cleanup primitive", () => {
    const source = readFileSync(
      new URL("./categories.service.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("await bulkDeleteCategories(db, [id], true)");
  });

  it("routes single soft delete through the same atomic bulk guard", () => {
    const source = readFileSync(
      new URL("./categories.service.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("await bulkDeleteCategories(db, [id], false)");
    expect(source).toContain("categoryDeleteUsageGuard(db, uniqueCategoryIds)");
  });

  it("fails closed when a product is assigned after the initial usage read", async () => {
    let selectCount = 0;
    const db = {
      select() {
        selectCount++;
        return {
          from() {
            return {
              kind: "guard",
              where() {
                return selectCount === 1
                  ? { limit: () => ({ all: async () => [] }) }
                  : { all: async () => [] };
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
        return { where: () => ({ kind: "delete" }) };
      },
      async batch() {
        throw new Error("D1_ERROR: malformed JSON");
      },
    };

    await expect(
      bulkDeleteCategories(db as never, ["cat_delete"], true),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
