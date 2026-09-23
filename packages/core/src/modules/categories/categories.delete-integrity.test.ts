import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@scalius/core/errors";
import {
  bulkDeleteCategories,
  restoreCategories,
  updateCategory,
  updateCategoryStatus,
} from "./categories.service";

function setup(race?: (sqlite: DatabaseSync) => void) {
  let pending = race;
  const harness = createSqliteD1Database({
    beforeBatch(sqlite) {
      const apply = pending;
      pending = undefined;
      apply?.(sqlite);
    },
  });
  harness.sqlite.exec(`
    INSERT INTO categories (id, name, slug, status, revision, deleted_at) VALUES
      ('cat_delete', 'Delete', 'delete', 'draft', 1, 1700000000),
      ('cat_keep', 'Keep', 'keep', 'published', 1, NULL),
      ('cat_active', 'Active', 'active', 'published', 1, NULL);
  `);
  const collection = (id: string, isActive: boolean, categoryIds: string[]) =>
    harness.sqlite.prepare("INSERT INTO collections (id, name, presentation, config, is_active) VALUES (?, ?, 'grid', ?, ?)")
      .run(id, id, JSON.stringify({ source: "dynamic", categoryIds }), isActive ? 1 : 0);
  const categoryExists = (id: string) =>
    harness.sqlite.prepare("SELECT 1 FROM categories WHERE id = ?").get(id) !== undefined;
  return { ...harness, collection, categoryExists };
}

const deleteClaim = [{ id: "cat_delete", expectedRevision: 1 }];

describe("category permanent delete integrity", () => {
  it("removes only the deleted membership from collections in the same batch as the delete", async () => {
    const { sqlite, db, collection, categoryExists } = setup();
    collection("col_seasonal", false, ["cat_delete", "cat_keep"]);
    sqlite.exec(`INSERT INTO products (id, name, price_minor, slug, category_id, deleted_at)
      VALUES ('prod_trashed', 'Old', 1000, 'old', 'cat_delete', 1700000000)`);

    await bulkDeleteCategories(db, deleteClaim, true);

    expect(categoryExists("cat_delete")).toBe(false);
    expect(sqlite.prepare("SELECT config, version FROM collections WHERE id = 'col_seasonal'").get()).toEqual({
      config: JSON.stringify({ source: "dynamic", categoryIds: ["cat_keep"] }),
      version: 2,
    });
    expect(sqlite.prepare("SELECT aggregate_revision FROM products WHERE id = 'prod_trashed'").get())
      .toEqual({ aggregate_revision: 2 });
  });

  it("fails closed when a product is assigned after the initial usage read", async () => {
    const { db, categoryExists } = setup((sqlite) => {
      sqlite.exec("INSERT INTO products (id, name, price_minor, slug, category_id) VALUES ('prod_new', 'New', 1000, 'new', 'cat_delete')");
    });

    await expect(bulkDeleteCategories(db, deleteClaim, true)).rejects.toBeInstanceOf(ValidationError);
    expect(categoryExists("cat_delete")).toBe(true);
  });

  it("requires trash before permanent deletion", async () => {
    const { db, categoryExists } = setup();

    await expect(bulkDeleteCategories(db, [{ id: "cat_active", expectedRevision: 1 }], true))
      .rejects.toBeInstanceOf(ConflictError);
    expect(categoryExists("cat_active")).toBe(true);
  });

  it("does not orphan an active dynamic collection", async () => {
    const { db, collection, categoryExists } = setup();
    collection("col_featured", true, ["cat_delete"]);

    await expect(bulkDeleteCategories(db, deleteClaim, true)).rejects.toThrow("without a source");
    expect(categoryExists("cat_delete")).toBe(true);
  });

  it("caps restore sets before constructing a D1 query", async () => {
    const claims = Array.from({ length: 91 }, (_, index) => ({
      id: `cat_${index}`,
      expectedRevision: 1,
    }));
    await expect(restoreCategories({} as never, claims))
      .rejects.toBeInstanceOf(ValidationError);
  });

  it("does not churn product composition revisions for category edit, status, trash, or restore writes", async () => {
    const { sqlite, db } = setup();
    sqlite.exec(`INSERT INTO products (id, name, price_minor, slug, category_id) VALUES ('prod_live', 'Live', 1000, 'live', 'cat_keep');
      INSERT INTO products (id, name, price_minor, slug, category_id, deleted_at) VALUES ('prod_old', 'Old', 1000, 'old', 'cat_active', 1700000000);`);

    await updateCategory(db, "cat_keep", {
      name: "Keep renamed", slug: "keep", description: null, metaTitle: null, metaDescription: null,
      canonicalPath: null, noIndex: false, excludeFromSitemap: false, image: null,
      expectedRevision: 1, status: "draft",
    });
    await updateCategoryStatus(db, "cat_keep", { expectedRevision: 2, status: "internal" });
    await bulkDeleteCategories(db, [{ id: "cat_active", expectedRevision: 1 }], false);
    await restoreCategories(db, [{ id: "cat_active", expectedRevision: 2 }]);

    expect(sqlite.prepare("SELECT id, aggregate_revision FROM products ORDER BY id").all()).toEqual([
      { id: "prod_live", aggregate_revision: 1 },
      { id: "prod_old", aggregate_revision: 1 },
    ]);
  });
});
