import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMigratedSqlite } from "../src/testing/sqlite-d1";
import { CURRENT_DATABASE_SCHEMA_MIGRATIONS } from "../src/schema-contract";

const name = "0129_order_overview_reads";
const migration = (provider = "") => readFileSync(join(import.meta.dirname, `../migrations/${provider}${name}.sql`), "utf8");
const statements = (sql: string) => sql.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean);

describe("order detail and overview covering indexes", () => {
  it("has matching, index-only, idempotent SQLite and PostgreSQL DDL", () => {
    const sqlite = statements(migration());
    const postgres = statements(migration("postgres/"));
    expect(postgres.map((statement) => statement.replaceAll('"', "`")))
      .toEqual(sqlite.map((statement) => statement.replaceAll('"', "`")));
    expect(sqlite).toHaveLength(7);
    for (const statement of sqlite.slice(0, -1)) {
      expect(statement.replace(/^(?:--[^\n]*\n)*/, "")).toMatch(/^CREATE INDEX IF NOT EXISTS /);
    }
  });

  it("upgrades a populated 0128 store without changing rows or triggers, and replays the indexes", () => {
    const db = createMigratedSqlite({ beforeMigration: "0129_" });
    try {
      db.exec(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, total_amount_minor)
        VALUES ('ord_index', 'Buyer', '+8801712345678', 'Road', 'city', 'zone', 12345)`);
      const before = db.prepare("SELECT id, total_amount_minor, version FROM orders").all();
      const triggers = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name").all();
      db.exec(migration());
      db.exec(statements(migration()).slice(0, -1).join("\n"));
      expect(db.prepare("SELECT id, total_amount_minor, version FROM orders").all()).toEqual(before);
      expect(db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name").all()).toEqual(triggers);
      const authority = CURRENT_DATABASE_SCHEMA_MIGRATIONS.find((entry) => entry.version === 129)!;
      expect(db.prepare("SELECT name, source_sha256 FROM scalius_schema_migrations WHERE version = 129").get())
        .toEqual({ name, source_sha256: authority.sourceSha256 });
    } finally {
      db.close();
    }
  });
});
