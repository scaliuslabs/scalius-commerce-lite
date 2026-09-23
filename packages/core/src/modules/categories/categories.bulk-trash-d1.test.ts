import type { DatabaseSync } from "node:sqlite";

import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, describe, expect, it } from "vitest";

import { ValidationError } from "@scalius/core/errors";
import { bulkDeleteCategories } from "./categories.service";

describe("category bulk trash D1 boundaries", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  function createDatabase({
    beforeCategoryUpdate,
  }: {
    beforeCategoryUpdate?: () => void;
  } = {}) {
    const parameterCounts: number[] = [];
    let injected = false;
    const harness = createSqliteD1Database({
      onQuery(query, values) {
        parameterCounts.push(values.length);
        if (!injected && beforeCategoryUpdate && /^update "categories"/iu.test(query.trim())) {
          injected = true;
          beforeCategoryUpdate();
        }
      },
    });
    sqlite = harness.sqlite;
    return { db: harness.db, parameterCounts };
  }

  function seedCategories(count: number) {
    const insert = sqlite!.prepare(`
      INSERT INTO categories (id, name, slug, status, revision, deleted_at, updated_at)
      VALUES (?, ?, ?, 'published', 1, NULL, 1)
    `);
    for (let index = 0; index < count; index += 1) {
      insert.run(`cat_${index}`, `Category ${index}`, `cat-${index}`);
    }
  }

  function claims(count: number, revision = 1) {
    return Array.from({ length: count }, (_, index) => ({
      id: `cat_${index}`,
      expectedRevision: revision,
    }));
  }

  it("moves a 12-category selection to trash with one bounded atomic update", async () => {
    const { db, parameterCounts } = createDatabase();
    seedCategories(12);

    await bulkDeleteCategories(db, claims(12), false);

    const rows = sqlite!.prepare(`
      SELECT id, status, revision, deleted_at IS NOT NULL AS trashed
      FROM categories
      ORDER BY id
    `).all() as Array<{
      id: string;
      status: string;
      revision: number;
      trashed: number;
    }>;
    expect(rows).toHaveLength(12);
    expect(rows.every((row) => (
      row.status === "draft" && row.revision === 2 && row.trashed === 1
    ))).toBe(true);
    expect(Math.max(...parameterCounts)).toBeLessThanOrEqual(100);
  });

  it("keeps every category active if a product assignment races the update", async () => {
    const { db } = createDatabase({
      beforeCategoryUpdate: () => {
        sqlite!.prepare(`
          INSERT INTO products (id, name, slug, price_minor, category_id)
          VALUES ('prod_race', 'Concurrent product', 'prod-race', 10000, 'cat_1')
        `).run();
      },
    });
    seedCategories(2);

    await expect(bulkDeleteCategories(db, claims(2), false)).rejects.toMatchObject({
      name: ValidationError.name,
      message: expect.stringContaining("still assigned"),
      details: {
        affectedProducts: [{ id: "prod_race", name: "Concurrent product" }],
      },
    });

    const rows = sqlite!.prepare(`
      SELECT status, revision, deleted_at FROM categories ORDER BY id
    `).all() as Array<{ status: string; revision: number; deleted_at: number | null }>;
    expect(rows).toEqual([
      { status: "published", revision: 1, deleted_at: null },
      { status: "published", revision: 1, deleted_at: null },
    ]);
  });

  it("does not trash the fresh rows when one revision claim is stale", async () => {
    const { db } = createDatabase();
    seedCategories(2);
    sqlite!.prepare("UPDATE categories SET revision = 2 WHERE id = 'cat_1'").run();

    await expect(bulkDeleteCategories(db, claims(2), false)).rejects.toMatchObject({
      code: "CATEGORY_REVISION_CONFLICT",
      details: {
        categoryId: "cat_1",
        expectedRevision: 1,
        currentRevision: 2,
      },
    });

    const trashed = sqlite!.prepare(
      "SELECT count(*) AS count FROM categories WHERE deleted_at IS NOT NULL",
    ).get() as { count: number };
    expect(trashed.count).toBe(0);
  });
});
