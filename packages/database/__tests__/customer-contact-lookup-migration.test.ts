import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileSqliteDdlForPostgres } from "../scripts/postgres-schema";
import { compileSqliteMigrationForProvider } from "../src/migration-artifacts";
import { CURRENT_DATABASE_SCHEMA_MIGRATIONS } from "../src/schema-contract";
import { createMigratedSqlite } from "../src/testing/sqlite-d1";

const name = "0144_customer_contact_lookup";
const migration = (provider = "") => readFileSync(join(import.meta.dirname, `../migrations/${provider}${name}.sql`), "utf8");
const statements = (source: string) => source.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean);
const indexes = ["orders_customer_email_lookup_idx", "orders_customer_phone_lookup_idx"];

describe("proven-contact order lookup indexes", () => {
  it("creates both replacements before dropping old indexes with matching PostgreSQL DDL", () => {
    const ddl = statements(migration());
    expect(ddl).toHaveLength(5);
    expect(ddl.slice(0, 2).every((statement) => statement.startsWith("CREATE INDEX IF NOT EXISTS "))).toBe(true);
    expect(ddl.slice(2, 4).every((statement) => statement.startsWith("DROP INDEX IF EXISTS "))).toBe(true);
    expect(statements(migration("postgres/"))).toEqual(ddl.map(compileSqliteDdlForPostgres));
    expect(ddl.join("\n")).not.toContain(" WHERE ");
  });

  it.each(["d1", "turso"] as const)("preserves orders and triggers on a populated 0143 %s upgrade", (provider) => {
    const sqlite = createMigratedSqlite({ provider, beforeMigration: "0144_" });
    try {
      sqlite.exec(`INSERT INTO orders (id,customer_name,customer_phone,customer_email,shipping_address,city,zone,total_amount_minor)
        VALUES ('ord_contact','Buyer','+8801712345678',' Buyer@Example.Test ','House 1','city','zone',100)`);
      const rows = () => ["orders", "event_outbox", "cache_dep", "cache_clock"].map((table) => sqlite.prepare(`SELECT * FROM ${table}`).all());
      const before = rows();
      const triggers = sqlite.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all();
      const count = sqlite.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='index' AND tbl_name='orders'").get();
      sqlite.exec(compileSqliteMigrationForProvider(migration(), provider));
      sqlite.exec(statements(migration()).slice(0, -1).join("\n"));
      expect(rows()).toEqual(before);
      expect(sqlite.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all()).toEqual(triggers);
      expect(sqlite.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='index' AND tbl_name='orders'").get()).toEqual(count);
      for (const [index, leading] of [[indexes[0], null], [indexes[1], "customer_phone"]]) {
        expect(sqlite.prepare(`PRAGMA index_info('${index}')`).all().map((row) => row.name)).toEqual([leading, "deleted_at", "created_at", "id"]);
      }
      expect(sqlite.prepare("SELECT name FROM sqlite_schema WHERE name IN ('orders_customer_phone_idx','orders_customer_email_normalized_idx')").all()).toEqual([]);
      const authority = CURRENT_DATABASE_SCHEMA_MIGRATIONS.find((entry) => entry.version === 144)!;
      expect(sqlite.prepare("SELECT name,source_sha256 FROM scalius_schema_migrations WHERE version=144").get())
        .toEqual({ name, source_sha256: authority.sourceSha256 });
    } finally { sqlite.close(); }
  });

  it.each(["d1", "turso"] as const)("includes both lookup indexes in a fresh %s schema", (provider) => {
    const sqlite = createMigratedSqlite({ provider });
    try {
      expect(sqlite.prepare("SELECT name FROM sqlite_schema WHERE name IN (?,?) ORDER BY name").all(...indexes))
        .toEqual(indexes.map((name) => ({ name })));
    } finally { sqlite.close(); }
  });
});
