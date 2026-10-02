// Migration 0106 resets stored theme documents to version 6 (the template is
// a label; every behaviour is a stated block, setting or token): a published
// version 5 theme is deleted with its drafts, history and preview sessions,
// so the store renders the default theme at revision 0; a store already on
// version 6 keeps everything that is version 6. Preview sessions hold no
// theme (they follow the saved draft), so they go only with a reset.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { retiredCacheDepFunctionDrops } from "../scripts/cache-dep-triggers";
import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";

const MIGRATION = "0106_theme_document_v6";
const V5 = '{"version":5,"template":"boutique"}';
const V6 = '{"version":6,"template":"boutique"}';

const seed = (published: string) => `
    INSERT INTO theme_settings (id, colors, revision) VALUES ('default', '${published}', 3);
    INSERT INTO theme_settings_drafts (id, theme, revision, base_published_revision) VALUES ('default', '${V6}', 2, 3);
    INSERT INTO theme_settings_versions (id, published_revision, theme, source) VALUES
        ('tv_old', 2, '${V5}', 'draft'), ('tv_new', 3, '${V6}', 'draft');
    INSERT INTO theme_preview_sessions (token_hash, expires_at) VALUES ('hash_one', 9999999999), ('hash_two', 9999999999);
`;

const count = (sqlite: ReturnType<typeof createMigratedSqlite>, table: string) =>
    Number((sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);

describe(MIGRATION, () => {
    it.each(["d1", "turso"] as const)("drops a version 5 store's theme rows on %s", (provider) => {
        const sqlite = createMigratedSqlite({ provider, beforeMigration: "0106_" });
        sqlite.exec(seed(V5));
        sqlite.exec(compiledMigrationSql(provider, "0107_", "0106_"));
        for (const table of ["theme_settings", "theme_settings_drafts", "theme_settings_versions", "theme_preview_sessions"]) {
            expect(count(sqlite, table), table).toBe(0);
        }
        expect(sqlite.prepare("SELECT version, name FROM scalius_schema_migrations ORDER BY version DESC LIMIT 1").get())
            .toEqual({ version: 106, name: MIGRATION });
    });

    it.each(["d1", "turso"] as const)("keeps version 6 rows of a version 6 store on %s", (provider) => {
        const sqlite = createMigratedSqlite({ provider, beforeMigration: "0106_" });
        sqlite.exec(seed(V6));
        sqlite.exec(compiledMigrationSql(provider, "0107_", "0106_"));
        expect(count(sqlite, "theme_settings")).toBe(1);
        expect(count(sqlite, "theme_settings_drafts")).toBe(1);
        expect(sqlite.prepare("SELECT id FROM theme_settings_versions").all()).toEqual([{ id: "tv_new" }]);
        expect(count(sqlite, "theme_preview_sessions")).toBe(2);
    });

    it.each(["d1", "turso"] as const)("drops the hero sliders and the homepage, header and footer documents on %s", (provider) => {
        const sqlite = createMigratedSqlite({ provider, beforeMigration: "0106_" });
        sqlite.exec(`
            INSERT INTO hero_sliders (id, type, images, is_active) VALUES ('hero_desktop', 'desktop', '[]', 1);
            INSERT INTO settings (id, key, value, type, category) VALUES
                ('set_homepage', 'document', '{"categoryRail":{"enabled":true}}', 'json', 'homepage'),
                ('set_header', 'document', '{"logo":{"src":"https://cdn.test/logo.png"}}', 'json', 'header'),
                ('set_footer', 'document', '{"tagline":"Since 1998"}', 'json', 'footer'),
                ('set_business', 'document', '{"companyName":"Acme"}', 'json', 'business');
        `);
        sqlite.exec(compiledMigrationSql(provider, "0107_", "0106_"));
        const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'hero%'").all() as Array<{ name: string }>);
        expect(tables).toEqual([]);
        const triggers = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'cdep_hero%'").all();
        expect(triggers).toEqual([]);
        expect(sqlite.prepare("SELECT category FROM settings ORDER BY category").all()).toEqual([{ category: "business" }]);
    });

    it("keeps its hand-written blocks between the T1 and T2 markers, the same on PostgreSQL plus its trigger functions", () => {
        const dir = join(import.meta.dirname, "..", "migrations");
        const sqlite = readFileSync(join(dir, `${MIGRATION}.sql`), "utf8");
        const postgres = readFileSync(join(dir, "postgres", `${MIGRATION}.sql`), "utf8");
        for (const source of [sqlite, postgres]) {
            expect(source).toMatch(/-- >>> T1 [^\n]+\n[\s\S]+-- <<< T1\n--> statement-breakpoint\n-- >>> T2 [^\n]+\n[\s\S]+-- <<< T2\n--> statement-breakpoint\nINSERT INTO/);
        }
        // PostgreSQL keeps a dropped table's trigger functions; its sidecar drops them too.
        const functionDrops = retiredCacheDepFunctionDrops(MIGRATION);
        expect(functionDrops).toHaveLength(3);
        const pgOnly = `--> statement-breakpoint\n-- PostgreSQL keeps a dropped table's trigger functions: drop the hero sliders' too.\n${functionDrops.join(";\n--> statement-breakpoint\n")};\n`;
        expect(postgres).toContain(pgOnly);
        expect(postgres.replace(pgOnly, "")).toBe(sqlite.replaceAll("`", "\""));
    });
});
