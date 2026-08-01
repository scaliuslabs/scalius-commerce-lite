import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  compileSqliteDataExportForProvider,
  compileSqliteMigrationForProvider,
  createSqliteDataExportEnvelopeForProvider,
  isFts5MigrationStatement,
  isLegacyNavigationRecursiveBackfill,
} from "../src/migration-artifacts";

const migrationsDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

describe("provider migration artifacts", () => {
  it("keeps D1 migrations byte-identical", async () => {
    const migration = await readFile(
      join(migrationsDirectory, "0000_blushing_jack_power.sql"),
      "utf8",
    );
    expect(compileSqliteMigrationForProvider(migration, "d1")).toBe(migration);
  });

  it("removes only unsupported FTS5 maintenance from Turso MVCC", async () => {
    const baseline = await readFile(
      join(migrationsDirectory, "0000_blushing_jack_power.sql"),
      "utf8",
    );
    const navigation = await readFile(
      join(migrationsDirectory, "0036_absent_living_lightning.sql"),
      "utf8",
    );
    const identity = await readFile(
      join(migrationsDirectory, "0006_outgoing_captain_midlands.sql"),
      "utf8",
    );
    const compiled = [baseline, identity, navigation]
      .map((migration) => compileSqliteMigrationForProvider(migration, "turso"))
      .join("\n");

    expect(compiled).not.toMatch(/CREATE\s+VIRTUAL\s+TABLE/i);
    expect(compiled).not.toMatch(/CREATE\s+TRIGGER[^;]*_fts_/i);
    expect(compiled).not.toMatch(/WITHOUT\s+ROWID/i);
    expect(compiled).not.toMatch(/WITH\s+RECURSIVE/i);
    expect(compiled).toContain("discount_usage_max_uses_guard");
    expect(compiled).toContain("navigation_pages_dependency_update");
    expect(compiled).toContain("CREATE TABLE `orders`");
  });

  it("recognizes only the completed D1 navigation lift as a skippable backfill", () => {
    expect(isLegacyNavigationRecursiveBackfill(`
      WITH RECURSIVE header_items(id) AS (SELECT 1)
      INSERT INTO navigation_menu_items (id) SELECT id FROM header_items
    `)).toBe(true);
    expect(isLegacyNavigationRecursiveBackfill(`
      WITH RECURSIVE required_business_data(id) AS (SELECT 1)
      INSERT INTO orders (id) SELECT id FROM required_business_data
    `)).toBe(false);
  });

  it("recognizes FTS statements with comments and quoted names", () => {
    expect(isFts5MigrationStatement(`
      -- optional search projection
      CREATE VIRTUAL TABLE \`products_fts\` USING fts5(name)
    `)).toBe(true);
    expect(isFts5MigrationStatement(`
      CREATE TRIGGER \`products_fts_after_insert\` AFTER INSERT ON products BEGIN
        SELECT 1;
      END
    `)).toBe(true);
    expect(isFts5MigrationStatement("CREATE TABLE products (id TEXT PRIMARY KEY)"))
      .toBe(false);
  });

  it("wraps Turso data imports atomically while leaving D1 exports intact", () => {
    const exported = "PRAGMA defer_foreign_keys=TRUE;\nINSERT INTO child VALUES(1);\n";

    expect(compileSqliteDataExportForProvider(exported, "d1")).toBe(exported);
    expect(compileSqliteDataExportForProvider(exported, "turso")).toBe([
      "PRAGMA foreign_keys=OFF;",
      "BEGIN;",
      "INSERT INTO child VALUES(1);",
      "COMMIT;",
      "PRAGMA foreign_keys=ON;",
      "",
    ].join("\n"));
    expect(() => compileSqliteDataExportForProvider("   ", "turso"))
      .toThrow(/must not be empty/i);
  });

  it("suspends and restores final Turso triggers inside the import transaction", () => {
    const compiled = compileSqliteDataExportForProvider(
      "INSERT INTO child VALUES(1);\n",
      "turso",
      [{
        name: 'child_"guard',
        sql: "CREATE TRIGGER child_guard BEFORE INSERT ON child BEGIN SELECT 1; END",
      }],
      ["child"],
    );

    expect(compiled).toBe([
      "PRAGMA foreign_keys=OFF;",
      "BEGIN;",
      'DROP TRIGGER IF EXISTS "child_""guard";',
      'DELETE FROM "child";',
      "INSERT INTO child VALUES(1);",
      "CREATE TRIGGER child_guard BEFORE INSERT ON child BEGIN SELECT 1; END;",
      "COMMIT;",
      "PRAGMA foreign_keys=ON;",
      "",
    ].join("\n"));

    expect(createSqliteDataExportEnvelopeForProvider(
      "turso",
      [{
        name: 'child_"guard',
        sql: "CREATE TRIGGER child_guard BEFORE INSERT ON child BEGIN SELECT 1; END",
      }],
      ["child"],
    )).toEqual({
      prefix: [
        "PRAGMA foreign_keys=OFF;",
        "BEGIN;",
        'DROP TRIGGER IF EXISTS "child_""guard";',
        'DELETE FROM "child";',
        "",
      ].join("\n"),
      suffix: [
        "CREATE TRIGGER child_guard BEFORE INSERT ON child BEGIN SELECT 1; END;",
        "COMMIT;",
        "PRAGMA foreign_keys=ON;",
        "",
      ].join("\n"),
    });
  });

  it("rejects malformed or duplicate trigger definitions", () => {
    expect(() => compileSqliteDataExportForProvider(
      "INSERT INTO child VALUES(1);",
      "turso",
      [{ name: "guard", sql: "DROP TABLE child" }],
    )).toThrow(/invalid sql/i);
    expect(() => compileSqliteDataExportForProvider(
      "INSERT INTO child VALUES(1);",
      "turso",
      [
        { name: "guard", sql: "CREATE TRIGGER guard BEFORE INSERT ON child BEGIN SELECT 1; END" },
        { name: "guard", sql: "CREATE TRIGGER guard2 BEFORE INSERT ON child BEGIN SELECT 1; END" },
      ],
    )).toThrow(/duplicated/i);
    expect(() => compileSqliteDataExportForProvider(
      "INSERT INTO child VALUES(1);",
      "turso",
      [],
      ["child", "child"],
    )).toThrow(/duplicated/i);
  });
});
