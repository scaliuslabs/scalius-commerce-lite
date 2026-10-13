// Migration 0124 (theme builder): restore points. It adds one dashboard-only
// table over a populated store without touching a row anything reads, and
// the table keeps its id shape, reason and revision.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";

const NAME = "0124_theme_restore_points";
const migration = (dir = "") => readFileSync(join(import.meta.dirname, `../migrations/${dir}${NAME}.sql`), "utf8");

describe(`${NAME} files`, () => {
  it("is plain DDL on every provider, remote-D1 and transaction safe", () => {
    expect(migration()).not.toMatch(/^\s*PRAGMA|CREATE TRIGGER/im);
    expect(migration("postgres/")).not.toMatch(/GLOB|PRAGMA|CREATE TRIGGER/i);
  });
});

describe(`${NAME} over a populated store`, () => {
  let db: DatabaseSync | null = null;
  afterEach(() => db?.close());

  it("adds the restore point table and keeps the theme rows", () => {
    db = createMigratedSqlite({ beforeMigration: "0124_" });
    db.exec(`
      INSERT INTO theme_settings (id, colors, revision) VALUES ('default', '{"version":8}', 3);
      INSERT INTO theme_settings_drafts (id, theme, revision, base_published_revision) VALUES ('default', '{"version":8}', 7, 3);
    `);
    db.exec(compiledMigrationSql("d1", "0125_", "0124_"));
    expect(db.prepare("SELECT revision FROM theme_settings_drafts").get()).toEqual({ revision: 7 });
    db.exec("INSERT INTO theme_restore_points (id, theme, draft_revision, reason) VALUES ('themerp_abcd1234', '{}', 7, 'restore')");
    expect(db.prepare("SELECT reason, draft_revision FROM theme_restore_points").get()).toEqual({ reason: "restore", draft_revision: 7 });
    for (const bad of [
      "INSERT INTO theme_restore_points (id, theme, draft_revision, reason) VALUES ('rp_1', '{}', 7, 'restore')",
      "INSERT INTO theme_restore_points (id, theme, draft_revision, reason) VALUES ('themerp_abcd5678', '{}', 7, 'publish')",
      "INSERT INTO theme_restore_points (id, theme, draft_revision, reason) VALUES ('themerp_abcd9012', '{}', 0, 'discard')",
    ]) {
      expect(() => db!.exec(bad), bad).toThrow(/CHECK constraint failed/);
    }
    expect(db.prepare("SELECT name FROM scalius_schema_migrations WHERE version = 124").get()).toEqual({ name: NAME });
  });
});
