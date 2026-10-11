import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "@tursodatabase/database";
import { describe, expect, it } from "vitest";
import { compileSqliteDdlForPostgres } from "../scripts/postgres-schema";
import { CURRENT_DATABASE_SCHEMA_MIGRATIONS } from "../src/schema-contract";
import { createMigratedSqlite } from "../src/testing/sqlite-d1";

const name = "0136_buyer_state_covering_index";
const migration = (provider = "") => readFileSync(join(import.meta.dirname, `../migrations/${provider}${name}.sql`), "utf8");
const statements = (source: string) => source.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
const seed = `INSERT INTO products (id,name,slug) VALUES ('a','A','a'),('b','B','b'),('c','C','c');
  INSERT INTO product_buyer_state (product_id,is_public,product_created_at,sku_id,from_minor,to_minor,base_minor,available_for_sale,availability_band) VALUES
  ('a',1,10,'va',100,100,100,1,'in_stock'),('b',1,20,'vb',100,100,100,0,'out_of_stock'),('c',1,30,'vc',200,200,200,1,'in_stock')`;
const candidates = `SELECT product_id,from_minor,available_for_sale,category_id,product_created_at
  FROM product_buyer_state WHERE is_public = 1 ORDER BY from_minor,product_id`;

describe("buyer-state recommendation covering index", () => {
  it("keeps replayable SQLite and PostgreSQL artifacts equivalent", () => {
    const sqlite = statements(migration());
    expect(sqlite).toHaveLength(3);
    expect(sqlite[0]).toMatch(/^DROP INDEX IF EXISTS `product_buyer_state_price_idx`/);
    expect(sqlite[1]).toMatch(/^CREATE INDEX IF NOT EXISTS `product_buyer_state_price_idx`/);
    expect(statements(migration("postgres/"))).toEqual(sqlite.map(compileSqliteDdlForPostgres));
  });

  it("upgrades populated buyer state without writes and preserves its price-order prefix", () => {
    const db = createMigratedSqlite({ beforeMigration: "0136_" });
    try {
      db.exec(seed);
      const rows = () => ["products", "product_buyer_state", "event_outbox", "cache_dep", "cache_clock"]
        .map((table) => db.prepare(`SELECT * FROM ${table}`).all());
      const before = rows();
      const triggers = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name").all();
      const indexCount = db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'index'").get();
      const prices = () => ["ASC", "DESC"].map((direction) => db.prepare(`SELECT product_id,from_minor FROM product_buyer_state WHERE is_public=1 ORDER BY from_minor ${direction},product_id`).all());
      const beforePrices = prices();
      db.exec(migration());
      db.exec(statements(migration()).slice(0, -1).join("\n"));
      expect(rows()).toEqual(before);
      expect(prices()).toEqual(beforePrices);
      expect(db.prepare("SELECT name,sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name").all()).toEqual(triggers);
      expect(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'index'").get()).toEqual(indexCount);
      expect(db.prepare("PRAGMA index_info('product_buyer_state_price_idx')").all().map((row) => row.name))
        .toEqual(["is_public", "from_minor", "product_id", "available_for_sale", "category_id", "product_created_at"]);
      const authority = CURRENT_DATABASE_SCHEMA_MIGRATIONS.find((entry) => entry.version === 136)!;
      expect(db.prepare("SELECT name,source_sha256 FROM scalius_schema_migrations WHERE version = 136").get())
        .toEqual({ name, source_sha256: authority.sourceSha256 });
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${candidates}`).all().map((row) => row.detail).join("\n");
      expect(plan).toContain("SEARCH product_buyer_state USING COVERING INDEX product_buyer_state_price_idx (is_public=?)");
      expect(plan).not.toContain("TEMP B-TREE");
      db.exec("UPDATE product_buyer_state SET available_for_sale=1,category_id='cat_changed',product_created_at=25 WHERE product_id='b'");
      expect(db.prepare(candidates).all()[1]).toMatchObject({ product_id: "b", available_for_sale: 1, category_id: "cat_changed", product_created_at: 25 });
      db.exec("BEGIN; UPDATE product_buyer_state SET is_public=0 WHERE product_id='b'; ROLLBACK");
      expect(db.prepare(candidates).all()).toHaveLength(3);
    } finally { db.close(); }
  });

  it("keeps the same ordered candidate values on the Turso engine", async () => {
    const source = createMigratedSqlite({ beforeMigration: "0136_" });
    const db = await connect(":memory:");
    try {
      for (const table of ["products", "product_buyer_state", "scalius_schema_migrations"]) {
        const row = source.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table) as { sql: string };
        await db.exec(row.sql);
      }
      await db.exec("CREATE INDEX product_buyer_state_price_idx ON product_buyer_state(is_public,from_minor,product_id)");
      await db.exec(seed);
      const before = await db.prepare(candidates).all();
      for (const statement of statements(migration())) await db.exec(statement);
      expect(await db.prepare(candidates).all()).toEqual(before);
      await db.exec("UPDATE product_buyer_state SET is_public=0 WHERE product_id='b'");
      expect((await db.prepare(candidates).all()).map((row) => row.product_id)).toEqual(["a", "c"]);
    } finally { source.close(); await db.close(); }
  });
});
