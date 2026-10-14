import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileSqliteMigrationForProvider } from "../src/migration-artifacts";
import { CURRENT_DATABASE_SCHEMA_MIGRATIONS } from "../src/schema-contract";
import { createMigratedSqlite } from "../src/testing/sqlite-d1";
import { expectSkinsRows, themeSkinsSeed } from "./theme-skins.fixture";

const name = "0153_theme_skins";
const migration = readFileSync(join(import.meta.dirname, `../migrations/${name}.sql`), "utf8");

describe("0153 theme skins", () => {
  it.each(["d1", "turso"] as const)("moves theme slots and manifest slots to skins, keeping every look (%s)", (provider) => {
    const sqlite = createMigratedSqlite({ provider, beforeMigration: "0153_" });
    try {
      sqlite.exec(themeSkinsSeed());
      sqlite.exec(compileSqliteMigrationForProvider(migration, provider));
      const all = (sql: string) => sqlite.prepare(sql).all() as Array<Record<string, unknown>>;
      const one = (sql: string) => String(all(sql)[0]!.value);
      expectSkinsRows({
        published: one("SELECT colors AS value FROM theme_settings"),
        draft: one("SELECT theme AS value FROM theme_settings_drafts"),
        versions: Object.fromEntries(all("SELECT id, theme FROM theme_settings_versions").map((row) => [row.id, String(row.theme)])),
        restore: one("SELECT theme AS value FROM theme_restore_points"),
        manifests: Object.fromEntries(all("SELECT plugin_id, manifest_json FROM plugin_installations").map((row) => [row.plugin_id, String(row.manifest_json)])),
      });
      // The published revision is the version history's key: it stays. The draft and installations advance.
      expect(all("SELECT revision FROM theme_settings")).toEqual([{ revision: 4 }]);
      expect(all("SELECT revision FROM theme_settings_drafts")).toEqual([{ revision: 10 }]);
      expect(all("SELECT plugin_id, revision FROM plugin_installations ORDER BY plugin_id")).toEqual([
        { plugin_id: "acme.plain", revision: 2 },
        { plugin_id: "acme.theme", revision: 4 },
      ]);
      const authority = CURRENT_DATABASE_SCHEMA_MIGRATIONS.find((entry) => entry.version === 153)!;
      expect(all("SELECT name, source_sha256 FROM scalius_schema_migrations WHERE version = 153"))
        .toEqual([{ name, source_sha256: authority.sourceSha256 }]);
    } finally { sqlite.close(); }
  });

  it("is idempotent: a second run changes nothing", () => {
    const sqlite = createMigratedSqlite({ provider: "d1", beforeMigration: "0153_" });
    try {
      sqlite.exec(themeSkinsSeed());
      const statements = migration.split("--> statement-breakpoint").slice(0, -1).join("--> statement-breakpoint");
      sqlite.exec(statements);
      const state = () => ["theme_settings", "theme_settings_drafts", "theme_settings_versions", "theme_restore_points", "plugin_installations"]
        .map((table) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
      const first = state();
      sqlite.exec(statements);
      expect(state()).toEqual(first);
    } finally { sqlite.close(); }
  });
});
