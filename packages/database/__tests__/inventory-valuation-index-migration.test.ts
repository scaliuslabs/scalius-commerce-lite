import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "@tursodatabase/database";
import { describe, expect, it } from "vitest";
import { compileSqliteDdlForPostgres } from "../scripts/postgres-schema";
import { CURRENT_DATABASE_SCHEMA_MIGRATIONS } from "../src/schema-contract";
import { createMigratedSqlite } from "../src/testing/sqlite-d1";

const name = "0135_inventory_valuation_indexes";
const migration = (provider = "") => readFileSync(join(import.meta.dirname, `../migrations/${provider}${name}.sql`), "utf8");
const statements = (source: string) => source.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
const missingCost = `SELECT id FROM product_variants WHERE cost_minor IS NULL AND EXISTS (
  SELECT 1 FROM inventory_levels WHERE variant_id = product_variants.id AND on_hand > 0)`;

describe("inventory valuation indexes", () => {
  it("keeps replayable SQLite and PostgreSQL index artifacts equivalent", () => {
    const sqlite = statements(migration());
    expect(sqlite).toHaveLength(5);
    expect(sqlite.filter((statement) => /^CREATE INDEX IF NOT EXISTS /.test(statement))).toHaveLength(3);
    expect(sqlite.filter((statement) => /^DROP INDEX IF EXISTS /.test(statement))).toHaveLength(1);
    expect(statements(migration("postgres/"))).toEqual(sqlite.map(compileSqliteDdlForPostgres));
  });

  it("preserves populated stock and maintains positive membership across locations", () => {
    const db = createMigratedSqlite({ beforeMigration: "0135_" });
    try {
      db.exec(`INSERT INTO products (id,name,slug) VALUES ('prod_cost','Cost','cost'),('prod_unknown','Unknown','unknown');
        INSERT INTO product_variants (id,product_id,sku,is_default,stock,cost_minor)
          VALUES ('var_cost','prod_cost','COST',1,4,125),('var_unknown','prod_unknown','UNKNOWN',1,5,NULL);
        INSERT INTO inventory_locations (id,name,code) VALUES ('loc_other','Other','OTHER');
        INSERT INTO inventory_levels (variant_id,location_id,on_hand) VALUES ('var_unknown','loc_other',2);
        UPDATE product_variants SET deleted_at = 1 WHERE id = 'var_unknown'`);
      const rows = () => ["products", "product_variants", "inventory_levels", "inventory_movements", "event_outbox", "cache_dep", "cache_clock"]
        .map((table) => db.prepare(`SELECT * FROM ${table}`).all());
      const before = rows();
      const triggers = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name").all();
      db.exec(migration());
      db.exec(statements(migration()).slice(0, -1).join("\n"));
      expect(rows()).toEqual(before);
      expect(db.prepare("SELECT name,sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name").all()).toEqual(triggers);
      for (const [index, columns] of [
        ["inventory_levels_location_idx", ["location_id", "on_hand", "variant_id"]],
        ["inventory_levels_positive_variant_idx", ["variant_id"]],
        ["product_variants_valuation_cost_idx", ["id", "cost_minor"]],
      ] as const) expect(db.prepare(`PRAGMA index_info('${index}')`).all().map((row) => row.name)).toEqual(columns);
      const authority = CURRENT_DATABASE_SCHEMA_MIGRATIONS.find((entry) => entry.version === 135)!;
      expect(db.prepare("SELECT name,source_sha256 FROM scalius_schema_migrations WHERE version = 135").get())
        .toEqual({ name, source_sha256: authority.sourceSha256 });
      expect(db.prepare(`EXPLAIN QUERY PLAN ${missingCost}`).all().map((row) => row.detail).join("\n"))
        .toContain("inventory_levels_positive_variant_idx");
      expect(db.prepare(missingCost).all()).toEqual([{ id: "var_unknown" }]);
      db.exec("UPDATE inventory_levels SET on_hand = 0 WHERE variant_id = 'var_unknown' AND location_id = 'loc_default'");
      expect(db.prepare(missingCost).all()).toEqual([{ id: "var_unknown" }]);
      db.exec("BEGIN; UPDATE inventory_levels SET on_hand = 0 WHERE variant_id = 'var_unknown'; ROLLBACK");
      expect(db.prepare(missingCost).all()).toEqual([{ id: "var_unknown" }]);
      db.exec("UPDATE inventory_levels SET on_hand = 0 WHERE variant_id = 'var_unknown'");
      expect(db.prepare(missingCost).all()).toEqual([]);
      db.exec("UPDATE inventory_levels SET on_hand = 1 WHERE variant_id = 'var_unknown' AND location_id = 'loc_other'");
      expect(db.prepare(missingCost).all()).toEqual([{ id: "var_unknown" }]);
      db.exec("UPDATE product_variants SET cost_minor = 0 WHERE id = 'var_unknown'");
      expect(db.prepare(missingCost).all()).toEqual([]);
    } finally { db.close(); }
  });

  it("supports materialized costs and positive-level membership on the Turso engine", async () => {
    const source = createMigratedSqlite({ beforeMigration: "0135_" });
    const db = await connect(":memory:");
    try {
      for (const table of ["product_variants", "inventory_levels", "scalius_schema_migrations"]) {
        const row = source.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) as { sql: string };
        await db.exec(row.sql);
      }
      await db.exec(`CREATE INDEX inventory_levels_location_idx ON inventory_levels(location_id,on_hand);
        INSERT INTO product_variants (id,product_id,sku,is_default,cost_minor) VALUES ('v1','p1','COST',1,125),('v2','p2','UNKNOWN',1,NULL);
        INSERT INTO inventory_levels (variant_id,location_id,on_hand) VALUES ('v1','l1',2),('v2','l1',3),('v2','l2',1)`);
      for (const statement of statements(migration())) await db.exec(statement);
      expect(await db.prepare(`WITH valuation_costs AS MATERIALIZED (SELECT id,cost_minor FROM product_variants)
        SELECT SUM(l.on_hand*c.cost_minor) AS amount FROM inventory_levels AS l
        LEFT JOIN valuation_costs AS c ON c.id = l.variant_id WHERE l.on_hand > 0`).get()).toEqual({ amount: 250 });
      expect(await db.prepare(missingCost).all()).toEqual([{ id: "v2" }]);
      await db.exec("UPDATE inventory_levels SET on_hand = 0 WHERE variant_id = 'v2'");
      expect(await db.prepare(missingCost).all()).toEqual([]);
      await db.exec("BEGIN; UPDATE inventory_levels SET on_hand = 2 WHERE variant_id = 'v2'; ROLLBACK");
      expect(await db.prepare(missingCost).all()).toEqual([]);
    } finally { source.close(); await db.close(); }
  });
});
