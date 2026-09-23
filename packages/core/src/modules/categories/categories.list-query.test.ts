import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";
import { listCategories, listCategoryAgentSummaries } from "./categories.service";
import { getPublicCategorySummaries } from "./categories.storefront";

function setup() {
  const harness = createSqliteD1Database();
  harness.sqlite.exec(`
    INSERT INTO categories (id, name, slug, status, description, content) VALUES
      ('cat_a', 'A', 'a', 'published', '${"d".repeat(500)}', '${"c".repeat(300)}'),
      ('cat_b', 'B', 'b', 'draft', NULL, NULL);
    INSERT INTO products (id, name, price, slug, category_id, is_active, deleted_at) VALUES
      ('p_active', 'Active', 10, 'active', 'cat_a', 1, NULL),
      ('p_inactive', 'Inactive', 10, 'inactive', 'cat_a', 0, NULL),
      ('p_trashed', 'Trashed', 10, 'trashed', 'cat_a', 1, 1700000000);
  `);
  return harness;
}

describe("category list projections", () => {
  it("counts assigned non-trashed products, active or not, per category row", async () => {
    const { db } = setup();

    const { categories } = await listCategories(db, { page: 1, limit: 10, sort: "name", order: "asc" });
    expect(categories.map(({ id, productCount }) => ({ id, productCount }))).toEqual([
      { id: "cat_a", productCount: 2 },
      { id: "cat_b", productCount: 0 },
    ]);
  });

  it("returns compact agent summaries without rich text or image fields", async () => {
    const { db } = setup();

    const { categories } = await listCategoryAgentSummaries(db, { limit: 50 });
    const summary = categories.find((category) => category.id === "cat_a");
    expect(summary).toMatchObject({ status: "published", productCount: 2 });
    expect(summary).not.toHaveProperty("description");
    expect(summary).not.toHaveProperty("content");
    expect(summary).not.toHaveProperty("imageUrl");
  });

  it("paginates public summaries with text lengths instead of rich text", async () => {
    const { db } = setup();

    const result = await getPublicCategorySummaries(db, { page: 1, limit: 20 });
    expect(result.pagination).toEqual({ total: 1, page: 1, limit: 20, totalPages: 1 });
    expect(result.categories).toEqual([expect.objectContaining({
      id: "cat_a",
      descriptionCharacters: 500,
      contentCharacters: 300,
    })]);
    expect(result.categories[0]).not.toHaveProperty("description");
    expect(result.categories[0]).not.toHaveProperty("content");
  });
});
