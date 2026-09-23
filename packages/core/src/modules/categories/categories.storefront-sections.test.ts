import type { DatabaseSync } from "node:sqlite";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, describe, expect, it } from "vitest";

import { getPublicCategorySection } from "./categories.storefront";

describe("bounded storefront category sections", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  function database(): Database {
    const harness = createSqliteD1Database();
    sqlite = harness.sqlite;
    sqlite.prepare(`
      INSERT INTO categories (
        id, name, slug, description, content, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'published', 10, 20)
    `).run("cat_long", "Long category", "long-category", "D".repeat(100_000), "C".repeat(100_000));
    return harness.db;
  }

  it("reports rich-text lengths without loading the aggregate", async () => {
    const result = await getPublicCategorySection(database(), "long-category", "summary");
    expect(result).toMatchObject({
      section: "summary",
      category: {
        id: "cat_long",
        descriptionCharacters: 100_000,
        contentCharacters: 100_000,
      },
    });
  });

  it("reconstructs valid 100k fields in bounded 12k chunks", async () => {
    const db = database();
    const first = await getPublicCategorySection(db, "long-category", "text", {
      field: "description",
      offset: 0,
    });
    const tail = await getPublicCategorySection(db, "long-category", "text", {
      field: "content",
      offset: 96_000,
    });

    expect(first).toMatchObject({
      section: "text",
      field: "description",
      totalCharacters: 100_000,
      offset: 0,
      nextOffset: 12_000,
      isNull: false,
    });
    expect(first && "value" in first ? first.value : "").toHaveLength(12_000);
    expect(tail).toMatchObject({
      section: "text",
      field: "content",
      totalCharacters: 100_000,
      offset: 96_000,
      nextOffset: null,
      isNull: false,
    });
    expect(tail && "value" in tail ? tail.value : "").toHaveLength(4_000);
  });

  it("fails closed for unpublished categories", async () => {
    const db = database();
    sqlite!.prepare("UPDATE categories SET status = 'draft'").run();
    await expect(getPublicCategorySection(db, "long-category", "summary")).resolves.toBeNull();
  });
});
