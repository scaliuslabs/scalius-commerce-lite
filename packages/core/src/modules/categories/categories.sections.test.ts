import { DatabaseSync } from "node:sqlite";

import type { Database } from "@scalius/database/client";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterEach, describe, expect, it } from "vitest";

import { getCategorySection } from "./categories.service";

describe("bounded admin category sections", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  function database(): Database {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE categories (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
        description TEXT, content TEXT, image_url TEXT, meta_title TEXT,
        meta_description TEXT, canonical_path TEXT, no_index INTEGER NOT NULL,
        exclude_from_sitemap INTEGER NOT NULL, status TEXT NOT NULL,
        revision INTEGER NOT NULL, deleted_at INTEGER
      );
    `);
    sqlite.prepare(`
      INSERT INTO categories VALUES (?, 'Long category', 'long-category', ?, ?, NULL,
        NULL, NULL, NULL, 0, 0, 'published', 4, NULL)
    `).run("cat_long", "D".repeat(100_000), "C".repeat(100_000));

    return drizzle(async (query, params, method) => {
      const prepared = sqlite!.prepare(query);
      prepared.setReturnArrays(true);
      if (method === "run") {
        prepared.run(...params);
        return { rows: [] };
      }
      if (method === "get") return { rows: prepared.get(...params) as unknown as unknown[] };
      return { rows: prepared.all(...params) as unknown as unknown[][] };
    }) as unknown as Database;
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
