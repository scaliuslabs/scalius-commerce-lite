import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMigratedSqlite } from "../src/testing/sqlite-d1";
import { CURRENT_DATABASE_SCHEMA_MIGRATIONS } from "../src/schema-contract";
import { compileSqliteDdlForPostgres } from "../scripts/postgres-schema";

const name = "0130_dashboard_home_reads";
const migration = (provider = "") => readFileSync(join(import.meta.dirname, `../migrations/${provider}${name}.sql`), "utf8");
const statements = (sql: string) => sql.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean);

describe("dashboard Home read indexes", () => {
    it("keeps SQLite and PostgreSQL index-only DDL replayable and equivalent", () => {
        const sqlite = statements(migration());
        expect(statements(migration("postgres/"))).toEqual(sqlite.map(compileSqliteDdlForPostgres));
        expect(sqlite).toHaveLength(7);
        for (const statement of sqlite.slice(0, -1)) {
            expect(statement.replace(/^(?:--[^\n]*\n)*/, "")).toMatch(/^CREATE INDEX IF NOT EXISTS /);
        }
    });

    it("upgrades populated 0129 without changing rows, ledger-v2 edges or dependency triggers", () => {
        const db = createMigratedSqlite({ beforeMigration: "0130_" });
        try {
            db.exec(`INSERT INTO products (id, name, slug, price_minor) VALUES ('prod_index', 'Index', 'index', 1000);
                INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default) VALUES ('var_index', 'prod_index', 'INDEX', 1000, 3, 1);
                INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, total_amount_minor)
                VALUES ('ord_index', 'Buyer', '+8801712345678', 'Road', 'city', 'zone', 12345)`);
            const tables = ["products", "product_variants", "orders", "inventory_movements", "cache_dep", "cache_clock", "event_outbox"];
            const rows = () => tables.map((table) => db.prepare(`SELECT * FROM "${table}"`).all());
            const before = rows();
            const triggers = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name").all();
            db.exec(migration());
            db.exec(statements(migration()).slice(0, -1).join("\n"));
            expect(rows()).toEqual(before);
            expect(db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name").all()).toEqual(triggers);
            const authority = CURRENT_DATABASE_SCHEMA_MIGRATIONS.find((entry) => entry.version === 130)!;
            expect(db.prepare("SELECT name, source_sha256 FROM scalius_schema_migrations WHERE version = 130").get())
                .toEqual({ name, source_sha256: authority.sourceSha256 });
        } finally {
            db.close();
        }
    });
});
