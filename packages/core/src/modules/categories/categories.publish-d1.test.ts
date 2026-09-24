import type { DatabaseSync } from "node:sqlite";

import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, describe, expect, it } from "vitest";

import { ValidationError } from "@scalius/core/errors";
import { createCategorySchema } from "./categories.validation";
import { createCategory, updateCategory, updateCategoryStatus } from "./categories.service";

describe("category publication on D1", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  function database() {
    const harness = createSqliteD1Database();
    sqlite = harness.sqlite;
    return harness.db;
  }

  function row(id: string) {
    return sqlite!.prepare("SELECT status, revision FROM categories WHERE id = ?").get(id) as {
      status: string;
      revision: number;
    };
  }

  const fields = {
    name: "Eid panjabi",
    slug: "eid-panjabi",
    description: null,
    metaTitle: null,
    metaDescription: null,
    image: null,
  };

  it("creates a category as draft unless another status is chosen", async () => {
    const db = database();

    const draft = await createCategory(db, createCategorySchema.parse(fields));
    const active = await createCategory(db, createCategorySchema.parse({ ...fields, slug: "eid-sale", status: "published" }));

    expect(draft.status).toBe("draft");
    expect({ ...row(draft.id) }).toEqual({ status: "draft", revision: 1 });
    expect(active).toMatchObject({ revision: 1, status: "published" });
    expect({ ...row(active.id) }).toEqual({ status: "published", revision: 1 });
  });

  it("publishes a category that has no products yet", async () => {
    const db = database();
    const { id } = await createCategory(db, createCategorySchema.parse(fields));

    await expect(updateCategoryStatus(db, id, { expectedRevision: 1, status: "published" }))
      .resolves.toEqual({ revision: 2, status: "published" });
    await expect(updateCategory(db, id, {
      ...createCategorySchema.parse(fields),
      canonicalPath: null,
      expectedRevision: 2,
      status: "published",
    })).resolves.toEqual({ revision: 3, status: "published" });
    expect({ ...row(id) }).toEqual({ status: "published", revision: 3 });
  });

  it("still refuses to unpublish a category an active automatic collection uses", async () => {
    const db = database();
    const { id } = await createCategory(db, createCategorySchema.parse({ ...fields, status: "published" }));
    sqlite!.prepare(`
      INSERT INTO collections (id, name, presentation, config, is_active)
      VALUES ('col_eid', 'Eid picks', 'grid', ?, 1)
    `).run(JSON.stringify({ source: "dynamic", categoryIds: [id], productIds: [] }));

    await expect(updateCategoryStatus(db, id, { expectedRevision: 1, status: "draft" }))
      .rejects.toBeInstanceOf(ValidationError);
    expect({ ...row(id) }).toEqual({ status: "published", revision: 1 });
  });
});
