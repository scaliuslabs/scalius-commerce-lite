import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "@tursodatabase/database";
import { describe, expect, it } from "vitest";
import { ANALYTICS_ROLLUP_MIGRATION, generateAnalyticsRollupTriggers, renderAnalyticsRollupMigration } from "../scripts/analytics-rollup-triggers";
import { analyticsRollupBackfillStatements } from "../src/analytics-rollup";
import { CURRENT_DATABASE_SCHEMA_MIGRATIONS } from "../src/schema-contract";
import { createMigratedSqlite } from "../src/testing/sqlite-d1";

const read = (provider = "") => readFileSync(join(import.meta.dirname, `../migrations/${provider}${ANALYTICS_ROLLUP_MIGRATION}.sql`), "utf8");
const statements = (source: string) => source.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);

describe("transactional analytics projection migration", () => {
  it("keeps SQLite and PostgreSQL artifacts equal to their source generator", () => {
    const sqlite = read();
    const ddl = statements(sqlite).filter((s) => /^CREATE (?:TABLE|INDEX|UNIQUE INDEX) /i.test(s));
    const generated = renderAnalyticsRollupMigration(ddl);
    expect(generated.sqlite).toBe(sqlite);
    expect(generated.postgres).toBe(read("postgres/"));
    expect(CURRENT_DATABASE_SCHEMA_MIGRATIONS.find((entry) => entry.version === 131)?.sourceSha256).toBe(generated.digest);
    for (const t of generateAnalyticsRollupTriggers()) {
      // The D1 remote parser requires a single statement in each trigger body.
      expect(t.sqlite.slice(t.sqlite.indexOf("BEGIN\n")).match(/;/g)).toHaveLength(1);
    }
  });

  it("backfills populated history without source writes and keeps updates atomic", () => {
    const db = createMigratedSqlite({ beforeMigration: "0131_" });
    try {
      db.exec(`INSERT INTO orders (id,customer_name,customer_phone,shipping_address,city,zone,total_amount_minor,shipping_amount_minor,created_at)
        VALUES ('ord_rollup','Buyer','+8801712345678','Road','city','zone',600,600,1000)`);
      const source = () => ["orders", "customers", "event_outbox", "cache_dep", "cache_clock"].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
      const before = source();
      db.exec(read());
      expect(source()).toEqual(before);
      expect(db.prepare("SELECT order_count,placed,shipping FROM analytics_order_facts WHERE order_id = 'ord_rollup'").get()).toEqual({ order_count: 1, placed: 1, shipping: 600 });
      expect(db.prepare("SELECT count(*) as n FROM analytics_sales_buckets").get()).toEqual({ n: 7 });
      const projection = () => ["analytics_order_facts", "analytics_sales_buckets", "analytics_customer_first_sale", "analytics_customer_currency_summary"].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
      const initial = projection();
      db.exec("BEGIN; UPDATE orders SET shipping_amount_minor = 777 WHERE id = 'ord_rollup'; ROLLBACK");
      expect(projection()).toEqual(initial);
      db.exec("UPDATE orders SET status = 'cancelled' WHERE id = 'ord_rollup'");
      expect(db.prepare("SELECT order_count,placed,cancelled,shipping FROM analytics_order_facts WHERE order_id = 'ord_rollup'").get()).toEqual({ order_count: 0, placed: 1, cancelled: 1, shipping: 0 });
      expect(db.prepare("SELECT first_sale_at FROM analytics_customer_first_sale").get()).toEqual({ first_sale_at: null });
      db.exec("DELETE FROM orders WHERE id = 'ord_rollup'");
      expect(db.prepare("SELECT count(*) as n FROM analytics_order_facts").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT sum(placed) as n FROM analytics_sales_buckets").get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });

  it("rebuilds the same projection after a triggerless seed", () => {
    const db = createMigratedSqlite();
    try {
      db.exec(`INSERT INTO orders (id,customer_name,customer_phone,shipping_address,city,zone,total_amount_minor,created_at)
        VALUES ('ord_rebuild','Buyer','+8801712345678','Road','city','zone',0,-1)`);
      const tables = ["analytics_order_facts", "analytics_sales_buckets", "analytics_customer_first_sale", "analytics_customer_currency_summary"];
      const before = tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all());
      for (const t of generateAnalyticsRollupTriggers()) db.exec(`DROP TRIGGER ${t.name}`);
      for (const table of tables) db.exec(`DELETE FROM ${table}`);
      for (const statement of analyticsRollupBackfillStatements()) db.exec(statement);
      expect(tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all())).toEqual(before);
      expect(db.prepare("SELECT DISTINCT bucket_start FROM analytics_sales_buckets ORDER BY 1").all()).toEqual([{ bucket_start: -86400 }, { bucket_start: -900 }]);
    } finally { db.close(); }
  });

  it("backfills and maintains all projections on the Turso engine", async () => {
    const source = createMigratedSqlite({ beforeMigration: "0131_" });
    const database = await connect(":memory:");
    try {
      // Keep this engine regression scoped to 0131, using the real source-table DDL.
      for (const table of ["orders", "order_items", "order_returns", "order_return_lines", "order_payments", "cod_tracking", "scalius_schema_migrations"]) {
        const row = source.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) as { sql: string };
        await database.exec(row.sql);
      }
      await database.exec(`INSERT INTO orders (id,customer_name,customer_phone,shipping_address,city,zone,shipping_amount_minor,created_at)
        VALUES ('ord_turso','Buyer','+8801712345678','Road','city','zone',600,100)`);
      for (const statement of statements(read())) await database.exec(statement);
      const fact = () => database.prepare("SELECT order_count,placed,cancelled,shipping FROM analytics_order_facts WHERE order_id = 'ord_turso'").get();
      const summary = () => database.prepare("SELECT first_sale_at,second_sale_at,last_sale_at,first_sale_any_currency_at FROM analytics_customer_currency_summary").get();
      expect(await fact()).toEqual({ order_count: 1, placed: 1, cancelled: 0, shipping: 600 });
      expect(await database.prepare("SELECT count(*) AS n FROM analytics_sales_buckets").get()).toEqual({ n: 7 });
      expect(await summary()).toEqual({ first_sale_at: 100, second_sale_at: null, last_sale_at: 100, first_sale_any_currency_at: 100 });
      await database.exec("UPDATE orders SET shipping_amount_minor = 777 WHERE id = 'ord_turso'");
      expect(await fact()).toEqual({ order_count: 1, placed: 1, cancelled: 0, shipping: 777 });
      expect(await database.prepare("SELECT sum(shipping) AS shipping FROM analytics_sales_buckets").get()).toEqual({ shipping: 7 * 777 });
      await database.exec("UPDATE orders SET status = 'cancelled' WHERE id = 'ord_turso'");
      expect(await fact()).toEqual({ order_count: 0, placed: 1, cancelled: 1, shipping: 0 });
      expect(await database.prepare("SELECT sum(order_count) AS orders,sum(shipping) AS shipping FROM analytics_sales_buckets").get()).toEqual({ orders: 0, shipping: 0 });
      expect(await database.prepare("SELECT first_sale_at FROM analytics_customer_first_sale").get()).toEqual({ first_sale_at: null });
      expect(await summary()).toEqual({ first_sale_at: null, second_sale_at: null, last_sale_at: null, first_sale_any_currency_at: null });
      await database.exec("BEGIN; UPDATE orders SET status = 'pending' WHERE id = 'ord_turso'; ROLLBACK");
      expect(await fact()).toEqual({ order_count: 0, placed: 1, cancelled: 1, shipping: 0 });
      expect(await summary()).toEqual({ first_sale_at: null, second_sale_at: null, last_sale_at: null, first_sale_any_currency_at: null });
    } finally { source.close(); await database.close(); }
  });
});
