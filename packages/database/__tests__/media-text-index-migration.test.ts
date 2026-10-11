import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "@tursodatabase/database";
import { describe, expect, it } from "vitest";
import { compileSqliteDdlForPostgres } from "../scripts/postgres-schema";
import { CURRENT_DATABASE_SCHEMA_MIGRATIONS } from "../src/schema-contract";
import { createMigratedSqlite } from "../src/testing/sqlite-d1";

const name = "0134_media_text_index";
const migration = (provider = "") => readFileSync(join(import.meta.dirname, `../migrations/${provider}${name}.sql`), "utf8");
const statements = (source: string) => source.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
const references = `SELECT id FROM products
  WHERE instr(coalesce(description, ''), 'media/') > 0
    AND instr(coalesce(description, ''), 'media/photo.png') > 0 ORDER BY id`;
const seed = `INSERT INTO products (id,name,slug,description,deleted_at) VALUES
  ('null','Null','null',NULL,NULL),
  ('plain','Plain','plain','Plain description',NULL),
  ('upper','Upper','upper','MEDIA/photo.png',NULL),
  ('live','Live','live','<img src="https://files.example/media/photo.png">',NULL),
  ('trash','Trash','trash','prefixmedia/photo.png suffix',1)`;

describe("product media text index", () => {
  it("keeps the SQLite and PostgreSQL index-only artifacts equivalent and replayable", () => {
    const sqlite = statements(migration());
    expect(sqlite).toHaveLength(2);
    expect(sqlite[0]).toMatch(/^CREATE INDEX IF NOT EXISTS `products_media_text_idx`/);
    expect(statements(migration("postgres/"))).toEqual(sqlite.map(compileSqliteDdlForPostgres));
  });

  it("upgrades populated products without source writes and tracks embedded references through edits", () => {
    const db = createMigratedSqlite({ beforeMigration: "0134_" });
    try {
      db.exec(seed);
      const rows = () => ["products", "product_variants", "product_content_blocks", "event_outbox", "cache_dep", "cache_clock"]
        .map((table) => db.prepare(`SELECT * FROM ${table}`).all());
      const before = rows();
      const triggers = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name").all();
      expect(db.prepare(references).all()).toEqual([{ id: "live" }, { id: "trash" }]);
      db.exec(migration());
      db.exec(statements(migration())[0]!);
      expect(rows()).toEqual(before);
      expect(db.prepare("SELECT name,sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name").all()).toEqual(triggers);
      expect(db.prepare("PRAGMA index_info('products_media_text_idx')").all().map((row) => row.name)).toEqual(["id"]);
      const authority = CURRENT_DATABASE_SCHEMA_MIGRATIONS.find((entry) => entry.version === 134)!;
      expect(db.prepare("SELECT name,source_sha256 FROM scalius_schema_migrations WHERE version = 134").get())
        .toEqual({ name, source_sha256: authority.sourceSha256 });
      expect(db.prepare(`EXPLAIN QUERY PLAN ${references}`).all().map((row) => row.detail).join("\n"))
        .toContain("SCAN products USING INDEX products_media_text_idx");
      expect(db.prepare(references).all()).toEqual([{ id: "live" }, { id: "trash" }]);
      db.exec(`UPDATE products SET description = '<img src="/media/photo.png">' WHERE id = 'null';
        UPDATE products SET description = NULL WHERE id = 'live';
        UPDATE products SET description = 'Plain description' WHERE id = 'trash'`);
      expect(db.prepare(references).all()).toEqual([{ id: "null" }]);
      db.exec("BEGIN; UPDATE products SET description = NULL WHERE id = 'null'; ROLLBACK");
      expect(db.prepare(references).all()).toEqual([{ id: "null" }]);
    } finally { db.close(); }
  });

  it("maintains the same literal predicate on the Turso engine", async () => {
    const source = createMigratedSqlite({ beforeMigration: "0134_" });
    const db = await connect(":memory:");
    try {
      for (const table of ["products", "scalius_schema_migrations"]) {
        const row = source.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) as { sql: string };
        await db.exec(row.sql);
      }
      await db.exec(seed);
      for (const statement of statements(migration())) await db.exec(statement);
      expect(await db.prepare(references).all()).toEqual([{ id: "live" }, { id: "trash" }]);
      await db.exec("UPDATE products SET description = 'media/photo.png' WHERE id = 'plain'; UPDATE products SET description = NULL WHERE id = 'live'");
      expect(await db.prepare(references).all()).toEqual([{ id: "plain" }, { id: "trash" }]);
      await db.exec("BEGIN; UPDATE products SET description = NULL WHERE id = 'trash'; ROLLBACK");
      expect(await db.prepare(references).all()).toEqual([{ id: "plain" }, { id: "trash" }]);
    } finally { source.close(); await db.close(); }
  });
});
