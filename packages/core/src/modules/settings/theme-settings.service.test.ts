import { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getThemeSettings, saveThemeSettings } from "./site-settings.service";

describe("versioned storefront theme settings", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE settings (
        id TEXT PRIMARY KEY NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        UNIQUE (key, category)
      );
      CREATE TABLE theme_settings (
        id TEXT PRIMARY KEY NOT NULL DEFAULT 'default',
        colors TEXT NOT NULL DEFAULT '{}',
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (id = 'default')
      );
    `);
    db = drizzle(async (query, params, method) => {
      const statement = sqlite.prepare(query);
      statement.setReturnArrays(true);
      if (method === "run") {
        statement.run(...params);
        return { rows: [] };
      }
      if (method === "get") {
        return { rows: statement.get(...params) as unknown as unknown[] };
      }
      return { rows: statement.all(...params) as unknown as unknown[][] };
    }) as unknown as Database;
  });

  afterEach(() => sqlite.close());

  it("reads and sanitizes the legacy color row before the first versioned publish", async () => {
    sqlite.prepare(`
      INSERT INTO settings (id, key, value, type, category, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "legacy_theme",
      "storefront_colors",
      JSON.stringify({ primary: " #2563eb ", unsafe: "url(evil)" }),
      "string",
      "theme",
      1,
    );

    await expect(getThemeSettings(db)).resolves.toEqual({
      colors: { primary: "#2563eb" },
      revision: 0,
    });
  });

  it("claims revision one exactly once when publishing a legacy draft", async () => {
    const first = await saveThemeSettings(db, { primary: "#047857" }, 0);
    expect(first).toEqual({ colors: { primary: "#047857" }, revision: 1 });

    await expect(
      saveThemeSettings(db, { primary: "#be123c" }, 0),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    await expect(getThemeSettings(db)).resolves.toEqual(first);
  });

  it("rejects a stale publish without replacing the current storefront colors", async () => {
    await saveThemeSettings(db, { primary: "#18181b" }, 0);
    const current = await saveThemeSettings(db, { primary: "#2563eb" }, 1);
    expect(current.revision).toBe(2);

    await expect(
      saveThemeSettings(db, { primary: "#be123c" }, 1),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    await expect(getThemeSettings(db)).resolves.toEqual(current);
  });
});
