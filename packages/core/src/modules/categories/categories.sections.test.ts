import type { DatabaseSync } from "node:sqlite";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, describe, expect, it } from "vitest";

import { getCategorySection } from "./categories.service";

describe("bounded admin category sections", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  function database(): Database {
    const harness = createSqliteD1Database();
    sqlite = harness.sqlite;
    sqlite.prepare(`
      INSERT INTO categories (id, name, slug, description, content, status, revision)
      VALUES (?, 'Long category', 'long-category', ?, ?, 'published', 4)
    `).run("cat_long", "D".repeat(100_000), "C".repeat(100_000));
    return harness.db;
  }

  it("reads lengths and reconstructs both 100k fields in bounded chunks", async () => {
    const db = database();
    await expect(getCategorySection(db, "cat_long", "summary")).resolves.toMatchObject({
      category: { revision: 4, descriptionCharacters: 100_000, contentCharacters: 100_000 },
    });
    const first = await getCategorySection(db, "cat_long", "text", { field: "description", offset: 0 });
    const tail = await getCategorySection(db, "cat_long", "text", { field: "content", offset: 96_000 });
    expect(first).toMatchObject({ totalCharacters: 100_000, nextOffset: 12_000 });
    expect(first && "value" in first ? first.value : "").toHaveLength(12_000);
    expect(tail).toMatchObject({ totalCharacters: 100_000, nextOffset: null });
    expect(tail && "value" in tail ? tail.value : "").toHaveLength(4_000);
  });

  it("fails closed for missing and trashed categories", async () => {
    const db = database();
    await expect(getCategorySection(db, "missing", "summary")).resolves.toBeNull();
    sqlite!.prepare("UPDATE categories SET deleted_at = 1").run();
    await expect(getCategorySection(db, "cat_long", "summary")).resolves.toBeNull();
  });
});
