import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collections } from "@scalius/database/schema";
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
    expect(batchCalls[0]).toHaveLength(2);
    expect(batchCalls[0]?.[0]).toMatchObject({
      kind: "update",
      table: collections,
      values: {
        config: JSON.stringify({ categoryIds: ["cat_keep"] }),
      },
    });
    expect(batchCalls[0]?.[1]).toMatchObject({ kind: "delete" });
  });

  it("routes single permanent delete through the bulk cleanup primitive", () => {
    const source = readFileSync(
      new URL("./categories.service.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("await bulkDeleteCategories(db, [id], true)");
  });
});
