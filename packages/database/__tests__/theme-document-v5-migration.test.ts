// Migration 0093 resets stored theme documents to version 5: a published
// version 4 theme is deleted with its drafts, history and preview sessions,
// so the store renders the default theme at revision 0; a store already on
// version 5 keeps everything that is version 5.
import { describe, expect, it } from "vitest";

import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";

const MIGRATION = "0093_theme_document_v5";
const V4 = '{"version":4,"template":"boutique"}';
const V5 = '{"version":5,"template":"boutique"}';

const seed = (published: string) => `
    INSERT INTO theme_settings (id, colors, revision) VALUES ('default', '${published}', 3);
    INSERT INTO theme_settings_drafts (id, theme, revision, base_published_revision) VALUES ('default', '${V5}', 2, 3);
    INSERT INTO theme_settings_versions (id, published_revision, theme, source) VALUES
        ('tv_old', 2, '${V4}', 'draft'), ('tv_new', 3, '${V5}', 'draft');
    INSERT INTO theme_preview_sessions (token_hash, theme, draft_revision, base_published_revision, expires_at) VALUES
        ('hash_old', '${V4}', 1, 2, 9999999999), ('hash_new', '${V5}', 2, 3, 9999999999);
`;

const count = (sqlite: ReturnType<typeof createMigratedSqlite>, table: string) =>
    Number((sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);

describe(MIGRATION, () => {
    it.each(["d1", "turso"] as const)("drops a version 4 store's theme rows on %s", (provider) => {
        const sqlite = createMigratedSqlite({ provider, beforeMigration: "0093_" });
        sqlite.exec(seed(V4));
        sqlite.exec(compiledMigrationSql(provider, "0094_", "0093_"));
        for (const table of ["theme_settings", "theme_settings_drafts", "theme_settings_versions", "theme_preview_sessions"]) {
            expect(count(sqlite, table), table).toBe(0);
        }
        expect(sqlite.prepare("SELECT version, name FROM scalius_schema_migrations ORDER BY version DESC LIMIT 1").get())
            .toEqual({ version: 93, name: MIGRATION });
    });

    it.each(["d1", "turso"] as const)("keeps version 5 rows of a version 5 store on %s", (provider) => {
        const sqlite = createMigratedSqlite({ provider, beforeMigration: "0093_" });
        sqlite.exec(seed(V5));
        sqlite.exec(compiledMigrationSql(provider, "0094_", "0093_"));
        expect(count(sqlite, "theme_settings")).toBe(1);
        expect(count(sqlite, "theme_settings_drafts")).toBe(1);
        expect(sqlite.prepare("SELECT id FROM theme_settings_versions").all()).toEqual([{ id: "tv_new" }]);
        expect(sqlite.prepare("SELECT token_hash FROM theme_preview_sessions").all()).toEqual([{ token_hash: "hash_new" }]);
    });
});
