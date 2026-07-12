import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import * as schema from "@scalius/database/schema";
import { listCategories } from "./categories.service";

describe("category list product counts", () => {
  it("correlates the product count to the outer category row", async () => {
    const queries: string[] = [];
    const d1 = {
      prepare(query: string) {
        queries.push(query);
        const statement = {
          bind: () => statement,
          all: async () => ({ results: [] }),
          raw: async () => [],
          first: async () => null,
        };
        return statement;
      },
      batch: async () => [
        { results: [{ count: 0 }], success: true },
        { results: [], success: true },
      ],
    };
    const db = drizzle(d1 as unknown as D1Database, { schema });

    await listCategories(db, { page: 1, limit: 10 });

    expect(queries).toHaveLength(3);
    expect(queries[2]).toContain(
      '"products"."category_id" = "categories"."id"',
    );
    expect(queries[2]).toContain('FROM "products"');
    expect(queries[2]).not.toContain('FROM "category_assigned_product"');
  });
});
