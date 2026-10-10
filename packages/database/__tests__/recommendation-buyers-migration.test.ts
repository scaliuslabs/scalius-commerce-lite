import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileSqliteDdlForPostgres } from "../scripts/postgres-schema";
import { CURRENT_DATABASE_SCHEMA_MIGRATIONS } from "../src/schema-contract";
import { createMigratedSqlite } from "../src/testing/sqlite-d1";

const name = "0132_recommendation_buyers";
const migration = (provider = "") => readFileSync(join(import.meta.dirname, `../migrations/${provider}${name}.sql`), "utf8");
const statements = (source: string) => source.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);

describe("recommendation buyer covering indexes", () => {
  it("keeps SQLite and PostgreSQL index-only artifacts equivalent and replayable", () => {
    const sqlite = statements(migration());
    expect(sqlite).toHaveLength(3);
    for (const statement of sqlite.slice(0, -1)) expect(statement).toMatch(/^CREATE INDEX IF NOT EXISTS /);
    expect(statements(migration("postgres/"))).toEqual(sqlite.map(compileSqliteDdlForPostgres));
  });

  it("upgrades populated history without changing orders, projections, outbox or cache dependencies", () => {
    const db = createMigratedSqlite({ beforeMigration: "0132_" });
    try {
      db.exec(`INSERT INTO orders (id,customer_name,customer_phone,shipping_address,city,zone,total_amount_minor,created_at)
        VALUES ('ord_rec_index','Buyer','+8801712345678','Road','city','zone',600,1000)`);
      const tables = ["orders", "customers", "analytics_order_facts", "analytics_sales_buckets", "analytics_customer_first_sale", "event_outbox", "cache_dep", "cache_clock"];
      const rows = () => tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
      const before = rows();
      const triggers = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name").all();
      db.exec(migration());
      db.exec(statements(migration()).slice(0, -1).join("\n"));
      expect(rows()).toEqual(before);
      expect(db.prepare("SELECT name,sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name").all()).toEqual(triggers);
      expect(db.prepare("PRAGMA index_info('orders_recommendation_buyers_idx')").all().map((row) => row.name))
        .toEqual(["deleted_at", "created_at", "status", "id", "customer_phone", "customer_email"]);
      expect(db.prepare("PRAGMA index_info('order_items_order_product_idx')").all().map((row) => row.name))
        .toEqual(["order_id", "product_id"]);
      const authority = CURRENT_DATABASE_SCHEMA_MIGRATIONS.find((entry) => entry.version === 132)!;
      expect(db.prepare("SELECT name,source_sha256 FROM scalius_schema_migrations WHERE version = 132").get())
        .toEqual({ name, source_sha256: authority.sourceSha256 });
    } finally { db.close(); }
  });
});
