import type { DatabaseSync } from "node:sqlite";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, describe, expect, it } from "vitest";

import { getCollectionSection } from "./collections.service";

describe("bounded admin collection sections", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  function database(): Database {
    const harness = createSqliteD1Database();
    sqlite = harness.sqlite;
    sqlite.prepare(`
      INSERT INTO collections (
        id, name, description, content, presentation, config, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'grid', ?, 10, 20)
    `).run(
      "col_long",
      "Long collection",
      "D".repeat(100_000),
      "C".repeat(100_000),
      JSON.stringify({ source: "manual", productIds: ["prod_1"] }),
    );
    return harness.db;
  }

  it("reports lengths without loading either rich-text field", async () => {
    await expect(getCollectionSection(database(), "col_long", "summary")).resolves.toMatchObject({
      section: "summary",
      collection: {
        id: "col_long",
        descriptionCharacters: 100_000,
        contentCharacters: 100_000,
        version: 1,
      },
    });
  });

  it("reconstructs both 100k fields in bounded chunks", async () => {
    const db = database();
    const first = await getCollectionSection(db, "col_long", "text", {
      field: "description",
      offset: 0,
    });
    const tail = await getCollectionSection(db, "col_long", "text", {
      field: "content",
      offset: 96_000,
    });

    expect(first).toMatchObject({
      section: "text",
      field: "description",
      totalCharacters: 100_000,
      nextOffset: 12_000,
    });
    expect(first && "value" in first ? first.value : "").toHaveLength(12_000);
    expect(tail).toMatchObject({
      section: "text",
      field: "content",
      totalCharacters: 100_000,
      offset: 96_000,
      nextOffset: null,
    });
    expect(tail && "value" in tail ? tail.value : "").toHaveLength(4_000);
  });

  it("fails closed for missing and trashed collections", async () => {
    const db = database();
    await expect(getCollectionSection(db, "missing", "summary")).resolves.toBeNull();
    sqlite!.prepare("UPDATE collections SET deleted_at = 30").run();
    await expect(getCollectionSection(db, "col_long", "summary")).resolves.toBeNull();
  });
});
