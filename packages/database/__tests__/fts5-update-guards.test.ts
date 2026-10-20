// D1's FTS5 update triggers fire only when the row identity or an indexed
// column changes. The generator renders 0157's orders pair byte for byte and
// 0169 installs the rest verbatim; on each source an update of another column
// writes only its row, and every indexed change keeps the index exact.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { compileSqliteMigrationForProvider } from "../src/migration-artifacts";
import { SEARCH_SOURCES, type SearchSource } from "../src/search-index";
import { splitSchemaMigrationStatements } from "../src/schema-upgrade";
import { createMigratedSqlite } from "../src/testing/sqlite-d1";
import {
  FTS5_GUARDED_SOURCES,
  FTS5_UPDATE_GUARD_MIGRATION,
  fts5UpdateGuardStatements,
  fts5UpdateGuardTriggers,
} from "../scripts/fts5-update-guards";

const readMigration = (name: string) => readFileSync(new URL(`../migrations/${name}.sql`, import.meta.url), "utf8");
const migration = readMigration(FTS5_UPDATE_GUARD_MIGRATION);

/** The deployed FTS5 table and its insert/delete triggers over a bare source with a noise column. */
function isolatedSource(source: SearchSource) {
  const migrated = createMigratedSqlite();
  const schema = (name: string) => (migrated.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name) as { sql: string }).sql;
  const columns = [...new Set(SEARCH_SOURCES[source].map(([, column]) => column).filter((column) => column !== "id"))];
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE ${source} (id TEXT PRIMARY KEY, ${columns.map((column) => `${column} TEXT`).join(", ")}, noise INTEGER DEFAULT 0)`);
  db.exec(schema(`${source}_fts`));
  db.exec(schema(`${source}_fts_after_insert`));
  db.exec(schema(`${source}_fts_before_delete`));
  for (const trigger of fts5UpdateGuardTriggers(source)) db.exec(trigger.sql);
  migrated.close();
  return { db, columns };
}

describe("FTS5 update guards", () => {
  it("renders 0157's orders pair byte for byte and 0169's pairs verbatim", () => {
    const orders = fts5UpdateGuardTriggers("orders");
    const deployed = splitSchemaMigrationStatements(readMigration("0157_order_search_update_guards"));
    for (const trigger of orders) expect(deployed).toContain(`${trigger.sql};`);
    const statements = splitSchemaMigrationStatements(migration);
    const generated = fts5UpdateGuardStatements();
    const start = statements.findIndex((statement) => statement.endsWith(generated[0]!));
    expect(start).toBeGreaterThan(-1);
    expect(statements.slice(start + 1, start + generated.length)).toEqual(generated.slice(1));
  });

  it("is what a migrated D1 store runs, and nothing on providers without FTS5", () => {
    const sqlite = createMigratedSqlite();
    try {
      const installed = new Map((sqlite.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%\\_fts\\_%\\_update' ESCAPE '\\'").all() as Array<{ name: string; sql: string }>)
        .map((row) => [row.name, row.sql]));
      for (const source of [...FTS5_GUARDED_SOURCES, "orders" as const]) {
        for (const trigger of fts5UpdateGuardTriggers(source)) expect(installed.get(trigger.name), trigger.name).toBe(trigger.sql);
      }
    } finally { sqlite.close(); }
    const turso = splitSchemaMigrationStatements(compileSqliteMigrationForProvider(migration, "turso")).join("\n");
    expect(turso).not.toMatch(/_fts_(?:before|after)_update/);
    expect(readMigration(`postgres/${FTS5_UPDATE_GUARD_MIGRATION}`)).not.toMatch(/_fts_(?:before|after)_update/);
  });

  it.each(FTS5_GUARDED_SOURCES)("%s: another column's write is the row write alone, and the index follows every indexed change", (source) => {
    const { db, columns } = isolatedSource(source);
    try {
      const changes = () => Number((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
      const matches = (term: string) => (db.prepare(`SELECT rowid FROM ${source}_fts WHERE ${source}_fts MATCH ?`).all(`"${term}"`) as Array<{ rowid: number }>).map((row) => row.rowid);
      const rowid = () => (db.prepare(`SELECT rowid FROM ${source} WHERE id = 'row'`).get() as { rowid: number }).rowid;
      db.prepare(`INSERT INTO ${source} (id, ${columns.join(", ")}) VALUES ('row', ${columns.map(() => "?").join(", ")})`)
        .run(...columns.map((column) => `alpha${column.replaceAll("_", "")}`));
      for (let i = 0; i < 5; i++) {
        const before = changes();
        db.prepare(`UPDATE ${source} SET noise = ? WHERE id = 'row'`).run(i);
        expect(changes() - before).toBe(1);
      }
      const before = changes();
      db.exec(`UPDATE ${source} SET ${columns.map((column) => `${column} = ${column}`).join(", ")}, id = id`);
      expect(changes() - before).toBe(1);
      for (const column of columns) {
        const term = column.replaceAll("_", "");
        expect(matches(`alpha${term}`)).toEqual([rowid()]);
        db.prepare(`UPDATE ${source} SET ${column} = ? WHERE id = 'row'`).run(`beta${term}`);
        expect(matches(`alpha${term}`)).toEqual([]);
        expect(matches(`beta${term}`)).toEqual([rowid()]);
        db.exec(`UPDATE ${source} SET ${column} = NULL`);
        expect(matches(`beta${term}`)).toEqual([]);
        db.prepare(`UPDATE ${source} SET ${column} = ? WHERE id = 'row'`).run(`gamma${term}`);
        expect(matches(`gamma${term}`)).toEqual([rowid()]);
      }
      db.exec(`UPDATE ${source} SET rowid = 42`);
      expect(matches(`gamma${columns[0]!.replaceAll("_", "")}`)).toEqual([42]);
      db.exec(`INSERT INTO ${source}_fts (${source}_fts) VALUES ('integrity-check')`);
      db.exec(`DELETE FROM ${source}`);
      expect(matches(`gamma${columns[0]!.replaceAll("_", "")}`)).toEqual([]);
    } finally { db.close(); }
  });
});
