// The search index of the providers without FTS5 (src/search-index.ts):
// - its fold and separators are FTS5's (unicode61, remove_diacritics 2);
// - its triggers store exactly FTS5's tokens and counts for every source;
// - migration 0152 builds it on Turso (fresh install and an existing store,
//   on the real Turso engine), and D1 runs 0152 as a no-op.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { compileSqliteMigrationForProvider, createSqliteDataExportEnvelopeForProvider } from "../src/migration-artifacts";
import {
  foldSearchText,
  SEARCH_FOLD_MAP,
  SEARCH_INDEX_TABLE_STATEMENTS,
  SEARCH_SOURCES,
  searchIndexRebuildStatements,
  searchIndexTriggers,
  searchTerms,
  type SearchSource,
} from "../src/search-index";
import { createMigratedSqlite } from "../src/testing/sqlite-d1";
import { createProviderSchemaDatabase, readFinalTriggerDefinitions, sqliteSchemaStatements } from "../scripts/sqlite-provider-schema";
import { connect } from "@tursodatabase/database";
import { freshTursoEngineStore, tursoEngineConnection } from "./turso-engine";

const MIGRATION = readFileSync(new URL("../migrations/0152_search_index.sql", import.meta.url), "utf8");

/** Text of every kind the stores hold: English, Bangla, accents, punctuation-bound words, SKUs, phones, emails. */
const CORPUS: string[] = [
  "Blue Cotton T-Shirt (Men's) — 100% cotton",
  "জামা প্রোডাক্ট বাংলা বর্ণনা। নতুন কালেকশন৷ ৳৫০০",
  "র‍্যাব ক্যাপ – কালো",
  "CAFÉ Crème Brûlée ÉCOLE Ölkanne Øresund Þór",
  "“Smart” watch… 2-in-1 • 5ATM ™ © ® ° ±",
  "SKU-ABC-123 abc_def 12.5kg 4K/UHD",
  "+880 1712-345678 rahim.uddin@example.com",
  "Line one\nline\ttwo\r\nthree four five​six",
  "MiXeD CaSe naïve façade jalapeño",
  "",
];

const corpusRow = (corpus: readonly string[], index: number, column: number) => corpus[(index + column) % corpus.length] ?? null;

describe("search index tokens", { timeout: 180_000 }, () => {
  it("folds and splits exactly as FTS5 unicode61 (remove_diacritics 2) does", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`CREATE VIRTUAL TABLE t USING fts5(x, tokenize = "unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 2");
      CREATE VIRTUAL TABLE v USING fts5vocab(t, 'instance');`);
    const fts5Terms = (text: string) => {
      sqlite.exec("DELETE FROM t");
      sqlite.prepare("INSERT INTO t (rowid, x) VALUES (1, ?)").run(text);
      return (sqlite.prepare("SELECT term FROM v ORDER BY offset").all() as Array<{ term: string }>).map((row) => row.term);
    };
    for (const [character, replacement] of SEARCH_FOLD_MAP) {
      expect(fts5Terms(`Ab${character}c`), JSON.stringify(character)).toEqual(replacement === " " ? ["ab", "c"] : [`ab${replacement}c`]);
      expect(searchTerms(`Ab${character}c`)).toEqual(fts5Terms(`Ab${character}c`));
    }
    for (const text of CORPUS) expect(searchTerms(text), text).toEqual(fts5Terms(text));
    expect(foldSearchText("ÉCOLE Ж")).toBe("ecole Ж");
    sqlite.close();
  });

  it("stores FTS5's terms and counts for every source, through its triggers", () => {
    const d1 = createMigratedSqlite({ provider: "d1" });
    const sqlite = new DatabaseSync(":memory:");
    const sources = Object.keys(SEARCH_SOURCES) as SearchSource[];
    for (const source of sources) {
      const columns = [...new Set(SEARCH_SOURCES[source].map(([, column]) => column).filter((column) => column !== "id"))];
      sqlite.exec(`CREATE TABLE ${source} (id TEXT PRIMARY KEY, ${columns.map((column) => `${column} TEXT`).join(", ")})`);
      // The D1 FTS5 table as deployed, with its tokenizer.
      sqlite.exec(String((d1.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(`${source}_fts`) as { sql: string }).sql));
      sqlite.exec(`CREATE VIRTUAL TABLE ${source}_vocab USING fts5vocab(${source}_fts, 'instance')`);
    }
    d1.close();
    for (const statement of SEARCH_INDEX_TABLE_STATEMENTS) sqlite.exec(statement);
    for (const trigger of searchIndexTriggers("sqlite")) sqlite.exec(trigger.sql);

    for (const source of sources) {
      const columns = [...new Set(SEARCH_SOURCES[source].map(([, column]) => column).filter((column) => column !== "id"))];
      // product_variants_fts and abandoned_checkouts_fts keep FTS5's default
      // tokenizer, which splits words at combining marks (Bangla vowel signs);
      // the index keeps those words whole, as every other table does.
      const ftsSql = String((sqlite.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(`${source}_fts`) as { sql: string }).sql);
      const corpus = /Mc Mn/.test(ftsSql) ? CORPUS : CORPUS.filter((text) => !/\p{M}/u.test(text));
      for (let index = 0; index < corpus.length; index += 1) {
        sqlite.prepare(`INSERT INTO ${source} (id, ${columns.join(", ")}) VALUES (?, ${columns.map(() => "?").join(", ")})`)
          .run(`${source}_${index}`, ...columns.map((_, column) => corpusRow(corpus, index, column)));
      }
      // An update of one column re-indexes the row; an update of no indexed column changes nothing.
      sqlite.prepare(`UPDATE ${source} SET ${columns[0]} = ? WHERE id = ?`).run("Updated Ñame", `${source}_1`);
      sqlite.prepare(`DELETE FROM ${source} WHERE id = ?`).run(`${source}_2`);
      const ftsColumns = SEARCH_SOURCES[source].map(([fts5Column]) => fts5Column);
      sqlite.exec(`INSERT INTO ${source}_fts (rowid, ${ftsColumns.join(", ")}) SELECT rowid, ${SEARCH_SOURCES[source].map(([, column]) => column).join(", ")} FROM ${source}`);
    }

    for (const source of sources) {
      const ftsColumns = SEARCH_SOURCES[source].map(([fts5Column]) => fts5Column);
      const fts5 = (sqlite.prepare(`
        SELECT s.id AS doc_id, v.col, v.term, count(*) AS tf FROM ${source}_vocab v JOIN ${source} s ON s.rowid = v.doc
        GROUP BY s.id, v.col, v.term
      `).all() as Array<{ doc_id: string; col: string; term: string; tf: number }>)
        .map((row) => ({ doc_id: row.doc_id, col: ftsColumns.indexOf(row.col), term: row.term, tf: Number(row.tf) }));
      const tokens = new Map<string, number>();
      for (const row of fts5) tokens.set(row.doc_id, (tokens.get(row.doc_id) ?? 0) + row.tf);
      const ids = (sqlite.prepare(`SELECT id FROM ${source}`).all() as Array<{ id: string }>).map((row) => row.id);
      const expected = [...fts5, ...ids.map((id) => ({ doc_id: id, col: -1, term: "", tf: tokens.get(id) ?? 0 }))];
      const stored = sqlite.prepare("SELECT doc_id, col, term, tf FROM search_fts_terms WHERE source = ?").all(source)
        .map((row) => ({ ...row, col: Number(row.col), tf: Number(row.tf) }));
      const order = (rows: Array<Record<string, unknown>>) => rows.map((row) => JSON.stringify([row.doc_id, row.col, row.term, row.tf])).sort();
      expect(order(stored), source).toEqual(order(expected));
    }

    // The rebuild (0152's backfill, an import's last step) stores exactly what the triggers stored.
    const before = sqlite.prepare("SELECT source, doc_id, col, term, tf FROM search_fts_terms ORDER BY 1, 2, 3, 4").all();
    for (const statement of searchIndexRebuildStatements("sqlite")) sqlite.exec(statement);
    expect(sqlite.prepare("SELECT source, doc_id, col, term, tf FROM search_fts_terms ORDER BY 1, 2, 3, 4").all()).toEqual(before);
    sqlite.close();
  });

  it("keeps a word's first 100 characters", () => {
    expect(searchTerms(`${"x".repeat(150)} y`)).toEqual(["x".repeat(100), "y"]);
  });
});

describe("migration 0152", { timeout: 180_000 }, () => {
  it("is a no-op on D1 and the search index on Turso", () => {
    expect(compileSqliteMigrationForProvider(MIGRATION, "d1")).toBe(MIGRATION);
    const turso = compileSqliteMigrationForProvider(MIGRATION, "turso");
    expect(turso).not.toMatch(/SELECT 'search_fts_terms'/);
    expect(turso).toMatch(/CREATE TABLE search_fts_terms/);
    expect(turso.match(/CREATE TRIGGER search_fts_terms_\w+/g)).toHaveLength(Object.keys(SEARCH_SOURCES).length * 3);
    // No raw invisible or bidirectional characters in schema SQL.
    expect(turso).not.toMatch(/[​-‏‪-‮﻿]/);
    const d1 = createMigratedSqlite({ provider: "d1" });
    expect(d1.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name GLOB 'search_fts_terms*'").get()).toEqual({ n: 0 });
    d1.close();
  });

  it("indexes a fresh Turso store's writes on the Turso engine", async () => {
    const database = await freshTursoEngineStore();
    try {
      await database.exec("INSERT INTO products (id, name, price_minor, slug, description) VALUES ('p1', 'Café T-Shirt', 100, 'p1', 'জামা প্রোডাক্ট… ৳৫০০')");
      await database.exec("INSERT INTO customers (id, name, phone, email) VALUES ('c1', 'Rahim Uddin', '+8801712345678', 'rahim@example.com')");
      await database.exec("UPDATE products SET description = 'Soft cotton' WHERE id = 'p1'");
      await database.exec("UPDATE products SET price_minor = 200 WHERE id = 'p1'");
      const rows = await database.prepare("SELECT source, doc_id, col, term, tf FROM search_fts_terms ORDER BY source, doc_id, col, term").all();
      expect(rows).toEqual([
        { source: "customers", doc_id: "c1", col: -1, term: "", tf: 6 },
        { source: "customers", doc_id: "c1", col: 0, term: "rahim", tf: 1 },
        { source: "customers", doc_id: "c1", col: 0, term: "uddin", tf: 1 },
        { source: "customers", doc_id: "c1", col: 1, term: "8801712345678", tf: 1 },
        { source: "customers", doc_id: "c1", col: 2, term: "com", tf: 1 },
        { source: "customers", doc_id: "c1", col: 2, term: "example", tf: 1 },
        { source: "customers", doc_id: "c1", col: 2, term: "rahim", tf: 1 },
        { source: "products", doc_id: "p1", col: -1, term: "", tf: 5 },
        { source: "products", doc_id: "p1", col: 0, term: "cafe", tf: 1 },
        { source: "products", doc_id: "p1", col: 0, term: "shirt", tf: 1 },
        { source: "products", doc_id: "p1", col: 0, term: "t", tf: 1 },
        { source: "products", doc_id: "p1", col: 1, term: "cotton", tf: 1 },
        { source: "products", doc_id: "p1", col: 1, term: "soft", tf: 1 },
      ]);
      await database.exec("DELETE FROM customers WHERE id = 'c1'");
      expect(await database.prepare("SELECT count(*) AS n FROM search_fts_terms WHERE source = 'customers'").get()).toEqual({ n: 0 });
    } finally {
      await database.close();
    }
  });

  it("backfills an existing Turso store's rows on the Turso engine", async () => {
    const before = await createProviderSchemaDatabase("turso", ":memory:", "0152_");
    const database = await connect(":memory:");
    try {
      const connection = tursoEngineConnection(database);
      await connection.transactionAsync(async (transaction) => transaction.batch(sqliteSchemaStatements(before))).immediate();
      await database.exec("INSERT INTO products (id, name, price_minor, slug) VALUES ('p_old', 'Old Shirt', 100, 'old')");
      for (const statement of compileSqliteMigrationForProvider(MIGRATION, "turso").split("--> statement-breakpoint")) {
        if (statement.trim()) await database.exec(statement);
      }
      expect(await database.prepare("SELECT doc_id, col, term, tf FROM search_fts_terms ORDER BY col, term").all()).toEqual([
        { doc_id: "p_old", col: -1, term: "", tf: 2 },
        { doc_id: "p_old", col: 0, term: "old", tf: 1 },
        { doc_id: "p_old", col: 0, term: "shirt", tf: 1 },
      ]);
    } finally {
      before.close();
      await database.close();
    }
  });

  it("rebuilds the index after a Turso data import that bypassed its triggers", () => {
    const target = createMigratedSqlite({ provider: "turso" });
    const triggers = readFinalTriggerDefinitions(target);
    const envelope = createSqliteDataExportEnvelopeForProvider("turso", triggers, ["products"]);
    target.exec(envelope.prefix);
    target.exec("INSERT INTO products (id, name, price_minor, slug) VALUES ('p1', 'Imported Shirt', 100, 'p1')");
    target.exec(envelope.suffix);
    expect(target.prepare("SELECT term FROM search_fts_terms WHERE doc_id = 'p1' AND col = 0 ORDER BY term").all())
      .toEqual([{ term: "imported" }, { term: "shirt" }]);
    target.close();
  });
});
