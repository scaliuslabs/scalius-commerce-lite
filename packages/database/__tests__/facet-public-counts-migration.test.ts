import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { connect } from "@tursodatabase/database";
import { describe, expect, it } from "vitest";
import { FACET_PUBLIC_COUNTS_MIGRATION, generateFacetPublicCountsTriggers, renderFacetPublicCountsMigration } from "../scripts/facet-public-counts";
import { createSqliteDataExportEnvelopeForProvider } from "../src/migration-artifacts";
import { CURRENT_DATABASE_SCHEMA_MIGRATIONS } from "../src/schema-contract";
import { createMigratedSqlite } from "../src/testing/sqlite-d1";
import { facetCountActual, facetCountMutations, facetCountOracle, facetCountSeed } from "./facet-public-counts-fixture";

const read = (provider = "") => readFileSync(join(import.meta.dirname, `../migrations/${provider}${FACET_PUBLIC_COUNTS_MIGRATION}.sql`), "utf8");
const statements = (source: string) => source.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);

describe("exact public facet counts", () => {
  it("reproduces both artifacts and uses one statement per bounded trigger", () => {
    const ddl = statements(read()).filter((s) => /^CREATE (?:TABLE|INDEX) /i.test(s));
    const generated = renderFacetPublicCountsMigration(ddl);
    expect(generated.sqlite).toBe(read());
    expect(generated.postgres).toBe(read("postgres/"));
    expect(CURRENT_DATABASE_SCHEMA_MIGRATIONS.find((m) => m.version === 138)?.sourceSha256).toBe(generated.digest);
    for (const trigger of generateFacetPublicCountsTriggers()) {
      expect(trigger.sqlite.slice(trigger.sqlite.indexOf("BEGIN\n")).match(/;/g)).toHaveLength(1);
      expect(trigger.sqlite).not.toContain("SELECT CASE WHEN");
    }
  });

  it.each(["SQLite", "Turso"])("backfills and maintains exact distinct products on %s", async (provider) => {
    const source = createMigratedSqlite({ beforeMigration: "0138_" });
    const db = provider === "Turso" ? await connect(":memory:") : source;
    try {
      if (provider === "Turso") {
        // Native engine, real facet/buyer constraints, minimal referenced parents.
        await db.exec("PRAGMA foreign_keys=ON");
        await db.exec("CREATE TABLE products(id TEXT PRIMARY KEY,name TEXT,slug TEXT)");
        await db.exec("CREATE TABLE product_variants(id TEXT PRIMARY KEY,product_id TEXT REFERENCES products(id) ON DELETE CASCADE,sku TEXT,option_combination_key TEXT)");
        for (const table of ["product_facet_values", "product_buyer_state", "scalius_schema_migrations"]) {
          const row = source.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table) as { sql: string };
          await db.exec(row.sql);
        }
      }
      for (const statement of facetCountSeed.split(";").filter((s) => s.trim())) await db.exec(statement);
      const preserved = async () => Promise.all(["products", "product_variants", "product_facet_values", "product_buyer_state",
        ...(provider === "SQLite" ? ["cache_dep", "cache_clock", "event_outbox"] : [])].map((table) => db.prepare(`SELECT * FROM ${table}`).all()));
      const before = await preserved();
      for (const statement of statements(read())) await db.exec(statement);
      expect(await preserved()).toEqual(before);
      const assertCounts = async () => expect(await db.prepare(facetCountActual).all()).toEqual(await db.prepare(facetCountOracle).all());
      await assertCounts();
      for (const mutation of facetCountMutations) {
        await db.exec(mutation);
        await assertCounts();
      }
      expect(await db.prepare("SELECT count(*) AS n FROM product_facet_public_counts").get()).toMatchObject({ n: 5 });
    } finally {
      if (provider === "Turso") await db.close();
      source.close();
    }
  });

  it("does not count ignored invalid writes, and rolls back source/count changes together", () => {
    const db = createMigratedSqlite();
    try {
      db.exec(facetCountSeed);
      db.exec("UPDATE product_buyer_state SET is_public=1 WHERE product_id='p1'");
      const before = db.prepare(facetCountActual).all();
      db.exec(`INSERT OR IGNORE INTO product_facet_values (owner_id,product_id,variant_id,facet_kind,facet_key,value_key,value_label)
        VALUES ('v4','p2','v4','option','option.color','invalid','')`);
      db.exec("UPDATE OR IGNORE product_facet_values SET value_key='invalid',value_label='' WHERE owner_id='v1'");
      db.exec("UPDATE OR IGNORE product_facet_values SET owner_id='v2',variant_id='v2',value_key='invalid' WHERE owner_id='v1'");
      db.exec("UPDATE OR IGNORE product_buyer_state SET is_public=0,discount_depth_bps=-1 WHERE product_id='p1'");
      expect(db.prepare(facetCountActual).all()).toEqual(before);
      db.exec("BEGIN; DELETE FROM products WHERE id='p1'; ROLLBACK");
      expect(db.prepare(facetCountActual).all()).toEqual(before);
      db.exec("BEGIN; UPDATE product_buyer_state SET is_public=0; ROLLBACK");
      expect(db.prepare(facetCountActual).all()).toEqual(before);
    } finally { db.close(); }
  });

  it("writes one count for 99 equal SKU values, and none for metadata or stock-only changes", () => {
    const db = createMigratedSqlite();
    try {
      db.exec(facetCountSeed);
      db.exec("UPDATE product_buyer_state SET is_public=1 WHERE product_id='p1'; DELETE FROM product_facet_values WHERE product_id='p1'");
      let writes = 0;
      db.function("count_write", () => { writes += 1; return 0; });
      for (const event of ["INSERT", "UPDATE", "DELETE"]) db.exec(`CREATE TRIGGER count_${event} AFTER ${event} ON product_facet_public_counts BEGIN SELECT count_write(); END`);
      for (let index = 0; index < 99; index += 1) {
        db.exec(`INSERT INTO product_variants(id,product_id,sku,option_combination_key) VALUES ('many_${index}','p1','MANY_${index}','${index}')`);
        db.exec(`INSERT INTO product_facet_values(owner_id,product_id,variant_id,facet_kind,facet_key,value_key,value_label)
          VALUES ('many_${index}','p1','many_${index}','option','option.size','large','Large')`);
      }
      expect(writes).toBe(1);
      db.exec("UPDATE product_facet_values SET value_label='LARGE',sort_order=2 WHERE product_id='p1'; UPDATE product_buyer_state SET available_for_sale=1,refreshed_at=20 WHERE product_id='p1'");
      expect(writes).toBe(1);
      db.exec("DELETE FROM product_facet_values WHERE product_id='p1'");
      expect(writes).toBe(2);
      expect(db.prepare(facetCountActual).all()).toEqual(db.prepare(facetCountOracle).all());
    } finally { db.close(); }
  });

  it("imports copied counts with triggers suspended, without counting the same facets twice", () => {
    const source = createMigratedSqlite();
    const target = new DatabaseSync(":memory:");
    try {
      source.exec(facetCountSeed);
      const tables = ["products", "product_variants", "product_facet_values", "product_buyer_state", "product_facet_public_counts"];
      for (const table of tables) target.exec(String(source.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(table)!.sql));
      const triggers = generateFacetPublicCountsTriggers().map((t) => ({ name: t.name, sql: t.sqlite }));
      for (const trigger of triggers) target.exec(trigger.sql);
      const envelope = createSqliteDataExportEnvelopeForProvider("turso", triggers, tables);
      target.exec(envelope.prefix);
      for (const table of tables) {
        for (const row of source.prepare(`SELECT * FROM ${table}`).all()) {
          const names = Object.keys(row);
          target.prepare(`INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...Object.values(row));
        }
      }
      target.exec(envelope.suffix);
      expect(target.prepare(facetCountActual).all()).toEqual(source.prepare(facetCountActual).all());
      target.exec("UPDATE product_buyer_state SET is_public=1 WHERE product_id='p1'");
      expect(target.prepare(facetCountActual).all()).toEqual(target.prepare(facetCountOracle).all());
    } finally { source.close(); target.close(); }
  });
});
