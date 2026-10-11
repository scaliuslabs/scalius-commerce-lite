import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "@tursodatabase/database";
import { describe, expect, it } from "vitest";
import { compileSqliteDdlForPostgres } from "../scripts/postgres-schema";
import { CURRENT_DATABASE_SCHEMA_MIGRATIONS } from "../src/schema-contract";
import { createMigratedSqlite } from "../src/testing/sqlite-d1";

const name = "0137_recommendation_order_id";
const migration = (provider = "") => readFileSync(join(import.meta.dirname, `../migrations/${provider}${name}.sql`), "utf8");
const statements = (source: string) => source.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
const seed = `INSERT INTO orders (id,customer_name,customer_phone,customer_email,shipping_address,city,zone,status,created_at)
  VALUES ('order_a','Buyer','NO_PHONE','buyer@example.com','Road','city','zone','confirmed',1000),
         ('order_b','Buyer','+8801712345678',NULL,'Road','city','zone','completed',2000)`;
const lookup = `SELECT status,created_at,customer_phone,customer_email FROM orders AS rec_co_order
  INDEXED BY orders_recommendation_id_buyers_idx
  WHERE rec_co_order.id = ? AND deleted_at IS NULL AND status IN ('confirmed','completed')`;

describe("recommendation source-order covering index", () => {
  it("keeps replayable SQLite and PostgreSQL artifacts equivalent", () => {
    const sqlite = statements(migration());
    expect(sqlite).toHaveLength(2);
    expect(sqlite[0]).toMatch(/^CREATE INDEX IF NOT EXISTS `orders_recommendation_id_buyers_idx`/);
    expect(statements(migration("postgres/"))).toEqual(sqlite.map(compileSqliteDdlForPostgres));
  });

  it("upgrades populated order history without changing domain rows or triggers", () => {
    const db = createMigratedSqlite({ beforeMigration: "0137_" });
    try {
      db.exec(seed);
      const rows = () => ["orders", "customers", "analytics_order_facts", "analytics_sales_buckets", "analytics_customer_first_sale", "analytics_customer_currency_summary", "event_outbox", "cache_dep", "cache_clock"]
        .map((table) => db.prepare(`SELECT * FROM ${table}`).all());
      const before = rows();
      const triggers = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all();
      const buyerCover = db.prepare("PRAGMA index_info('product_buyer_state_price_idx')").all();
      db.exec(migration());
      db.exec(statements(migration())[0]!);
      expect(rows()).toEqual(before);
      expect(db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all()).toEqual(triggers);
      expect(db.prepare("PRAGMA index_info('product_buyer_state_price_idx')").all()).toEqual(buyerCover);
      expect(db.prepare("PRAGMA index_info('orders_recommendation_id_buyers_idx')").all().map((row) => row.name))
        .toEqual(["id", "deleted_at", "status", "created_at", "customer_phone", "customer_email"]);
      const authority = CURRENT_DATABASE_SCHEMA_MIGRATIONS.find((entry) => entry.version === 137)!;
      expect(db.prepare("SELECT name,source_sha256 FROM scalius_schema_migrations WHERE version=137").get())
        .toEqual({ name, source_sha256: authority.sourceSha256 });
      expect(db.prepare(`EXPLAIN QUERY PLAN ${lookup}`).all("order_a").map((row) => row.detail).join("\n"))
        .toContain("SEARCH rec_co_order USING COVERING INDEX orders_recommendation_id_buyers_idx (id=");
      expect(db.prepare(lookup).get("order_a")).toEqual({ status: "confirmed", created_at: 1000, customer_phone: "NO_PHONE", customer_email: "buyer@example.com" });
      db.exec("UPDATE orders SET status='cancelled' WHERE id='order_a'");
      expect(db.prepare(lookup).get("order_a")).toBeUndefined();
      db.exec("BEGIN; UPDATE orders SET deleted_at=3000 WHERE id='order_b'; ROLLBACK");
      expect(db.prepare(lookup).get("order_b")).toMatchObject({ status: "completed", created_at: 2000 });
    } finally { db.close(); }
  });

  it("executes the indexed ID lookup and current buyer fields on the native Turso engine", async () => {
    const source = createMigratedSqlite({ beforeMigration: "0137_" });
    const db = await connect(":memory:");
    try {
      for (const table of ["orders", "scalius_schema_migrations"]) {
        const row = source.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table) as { sql: string };
        await db.exec(row.sql);
      }
      await db.exec(seed);
      for (const statement of statements(migration())) await db.exec(statement);
      expect(await db.prepare(lookup).get("order_a")).toEqual({ status: "confirmed", created_at: 1000, customer_phone: "NO_PHONE", customer_email: "buyer@example.com" });
      expect((await db.prepare(`EXPLAIN QUERY PLAN ${lookup}`).all("order_a")).map((row) => row.detail).join("\n"))
        .toMatch(/SEARCH rec_co_order USING (?:COVERING )?INDEX orders_recommendation_id_buyers_idx \(id=/);
      await db.exec("UPDATE orders SET status='completed',customer_email='changed@example.com',created_at=2500 WHERE id='order_a'");
      expect(await db.prepare(lookup).get("order_a")).toMatchObject({ status: "completed", customer_email: "changed@example.com", created_at: 2500 });
      await db.exec("UPDATE orders SET deleted_at=3000 WHERE id='order_a'");
      expect(await db.prepare(lookup).get("order_a")).toBeUndefined();
    } finally { source.close(); await db.close(); }
  });
});
