import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { connect } from "@tursodatabase/database";
import { describe, expect, it } from "vitest";
import { BUYER_PUBLIC_COUNTS_MIGRATION, generateBuyerPublicCountsTriggers, renderBuyerPublicCountsMigration } from "../scripts/buyer-public-counts";
import { createSqliteDataExportEnvelopeForProvider } from "../src/migration-artifacts";
import { CURRENT_DATABASE_SCHEMA_MIGRATIONS } from "../src/schema-contract";
import { createMigratedSqlite } from "../src/testing/sqlite-d1";
import { buyerCountActual, buyerCountMutations, buyerCountOracle, buyerCountSeed } from "./buyer-public-counts-fixture";

const read = (provider = "") => readFileSync(join(import.meta.dirname, `../migrations/${provider}${BUYER_PUBLIC_COUNTS_MIGRATION}.sql`), "utf8");
const statements = (source: string) => source.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);

describe("exact public brand/category counts", () => {
  it("reproduces both artifacts with three bounded single-statement triggers", () => {
    const ddl = statements(read()).filter((s) => /^CREATE TABLE /i.test(s));
    expect(ddl).toHaveLength(1);
    const generated = renderBuyerPublicCountsMigration(ddl);
    expect(generated.sqlite).toBe(read());
    expect(generated.postgres).toBe(read("postgres/"));
    expect(CURRENT_DATABASE_SCHEMA_MIGRATIONS.find((m) => m.version === 140)?.sourceSha256).toBe(generated.digest);
    expect(generateBuyerPublicCountsTriggers()).toHaveLength(3);
    for (const trigger of generateBuyerPublicCountsTriggers()) {
      expect(trigger.sqlite.slice(trigger.sqlite.indexOf("BEGIN\n")).match(/;/g)).toHaveLength(1);
      expect(trigger.sqlite).not.toContain("SELECT CASE WHEN");
    }
  });

  it.each(["SQLite", "Turso"])("backfills without changing source/dependencies and maintains lifecycle parity on %s", async (provider) => {
    const source = createMigratedSqlite({ beforeMigration: "0140_" });
    const db = provider === "Turso" ? await connect(":memory:") : source;
    try {
      if (provider === "Turso") {
        await db.exec("PRAGMA foreign_keys=ON");
        await db.exec("CREATE TABLE products(id TEXT PRIMARY KEY,name TEXT,slug TEXT)");
        await db.exec("CREATE TABLE product_variants(id TEXT PRIMARY KEY,product_id TEXT REFERENCES products(id) ON DELETE CASCADE,sku TEXT,option_combination_key TEXT)");
        for (const table of ["product_buyer_state", "scalius_schema_migrations"]) {
          const row = source.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table) as { sql: string };
          await db.exec(row.sql);
        }
      }
      for (const statement of buyerCountSeed.split(";").filter((s) => s.trim())) await db.exec(statement);
      const preserved = async () => Promise.all(["products", "product_variants", "product_buyer_state",
        ...(provider === "SQLite" ? ["cache_dep", "cache_clock", "event_outbox"] : [])].map((table) => db.prepare(`SELECT * FROM ${table}`).all()));
      const before = await preserved();
      for (const statement of statements(read())) await db.exec(statement);
      expect(await preserved()).toEqual(before);
      const assertCounts = async () => expect(await db.prepare(buyerCountActual).all()).toEqual(await db.prepare(buyerCountOracle).all());
      await assertCounts();
      await db.exec("INSERT OR IGNORE INTO product_buyer_state (product_id,is_public,brand_id,product_created_at) VALUES ('p4',1,'invalid',1)");
      await db.exec("UPDATE OR IGNORE product_buyer_state SET brand_id='invalid',discount_depth_bps=-1 WHERE product_id='p2'");
      await assertCounts();
      await db.exec("BEGIN");
      await db.exec("DELETE FROM products WHERE id='p2'");
      await db.exec("ROLLBACK");
      await assertCounts();
      for (const mutation of buyerCountMutations) {
        await db.exec(mutation);
        await assertCounts();
      }
      expect(await db.prepare(buyerCountActual).all()).toEqual([]);
    } finally {
      if (provider === "Turso") await db.close();
      source.close();
    }
  });

  it("writes at most four changed keys and skips price/stock/refresh changes and cancelled deltas", () => {
    const db = createMigratedSqlite();
    try {
      db.exec(buyerCountSeed);
      let writes = 0;
      db.function("count_write", () => { writes += 1; return 0; });
      for (const event of ["INSERT", "UPDATE", "DELETE"]) db.exec(`CREATE TRIGGER count_${event} AFTER ${event} ON product_buyer_public_counts BEGIN SELECT count_write(); END`);
      db.exec("UPDATE product_buyer_state SET available_for_sale=1,from_minor=90,refreshed_at=20,brand_id=brand_id,category_id=category_id");
      db.exec("UPDATE product_buyer_state SET product_id='p4',sku_id='v4' WHERE product_id='p2'");
      expect(writes).toBe(0);
      db.exec("UPDATE product_buyer_state SET is_public=1 WHERE product_id='p1'");
      expect(writes).toBe(2);
      db.exec("UPDATE product_buyer_state SET brand_id='b2',category_id='c2' WHERE product_id='p1'");
      expect(writes).toBe(6);
      db.exec("UPDATE product_buyer_state SET is_public=0 WHERE product_id='p1'");
      expect(writes).toBe(8);
      db.exec("UPDATE product_buyer_state SET brand_id='b3',category_id='c3' WHERE product_id='p1'");
      expect(writes).toBe(8);
      expect(db.prepare(buyerCountActual).all()).toEqual(db.prepare(buyerCountOracle).all());
    } finally { db.close(); }
  });

  it("imports copied counts with triggers suspended without double-counting", () => {
    const source = createMigratedSqlite();
    const target = new DatabaseSync(":memory:");
    try {
      source.exec(buyerCountSeed);
      const tables = ["products", "product_variants", "product_buyer_state", "product_buyer_public_counts"];
      for (const table of tables) target.exec(String(source.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(table)!.sql));
      const triggers = generateBuyerPublicCountsTriggers().map((t) => ({ name: t.name, sql: t.sqlite }));
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
      expect(target.prepare(buyerCountActual).all()).toEqual(source.prepare(buyerCountActual).all());
      target.exec("UPDATE product_buyer_state SET is_public=1 WHERE product_id='p1'");
      expect(target.prepare(buyerCountActual).all()).toEqual(target.prepare(buyerCountOracle).all());
    } finally { source.close(); target.close(); }
  });
});
