import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import * as schema from "@scalius/database/schema";
import { listCategories, listCategoryAgentSummaries } from "./categories.service";

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

describe("bounded category agent summaries", () => {
  it("selects only compact fields and preserves status from the database", async () => {
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
        { results: [{ count: 1 }], success: true },
        { results: [{
          id: "cat_1", name: "Category", slug: "category", status: "published",
          revision: 2, productCount: 3, publishReady: 1,
        }], success: true },
      ],
    };
    const db = drizzle(d1 as unknown as D1Database, { schema });

    await expect(listCategoryAgentSummaries(db, { limit: 50 })).resolves.toMatchObject({
      categories: [{ status: "published", productCount: 3, publishReady: true }],
    });
    const listSql = queries.at(-1) ?? "";
    expect(listSql).not.toContain('"description"');
    expect(listSql).not.toContain('"content"');
    expect(listSql).not.toContain('"image_url"');
  });
});
