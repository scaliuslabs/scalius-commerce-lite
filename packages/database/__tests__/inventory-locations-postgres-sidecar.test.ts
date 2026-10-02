// PostgreSQL sidecar parity for 0102_inventory_locations (commerce hook H1):
// a pre-0102 schema upgraded by the sidecar must equal the fresh schema
// compiled from the canonical SQLite chain, the backfill must book existing
// stock at the default location, and the level triggers must hold the same
// guards as SQLite (location required, shortfall aborts, receipts upsert).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, types } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { compileCanonicalPostgresSchema } from "../scripts/postgres-schema";

// Opt-in: point SCALIUS_TEST_POSTGRES_URL at a disposable server. Each test
// creates and drops its own databases there.
const postgresUrl = process.env.SCALIUS_TEST_POSTGRES_URL?.trim();
const sidecar = join(import.meta.dirname, "../migrations/postgres/0102_inventory_locations.sql");

const openClients: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of openClients.splice(0)) await close();
});

async function database(schemaSql: string): Promise<Client> {
  const name = `scalius_h1_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: postgresUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(postgresUrl!);
  url.pathname = `/${name}`;
  const client = new Client({
    connectionString: url.toString(),
    types: {
      getTypeParser: ((oid: number, format?: "text" | "binary") =>
        oid === 20 ? Number : types.getTypeParser(oid, format)) as typeof types.getTypeParser,
    },
  });
  await client.connect();
  await client.query(schemaSql);
  openClients.push(async () => {
    await client.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  return client;
}

async function applySidecar(client: Client): Promise<void> {
  const sql = readFileSync(sidecar, "utf8");
  await client.query("BEGIN");
  try {
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.query(statement);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function catalog(client: Client) {
  const query = async (sql: string) => (await client.query(sql)).rows;
  return {
    columns: await query(`
      SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name <> 'scalius_schema_migrations'
      ORDER BY table_name, column_name
    `),
    constraints: await query(`
      SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2, 3
    `),
    indexes: await query(`
      SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname
    `),
    triggers: await query(`
      SELECT tgrelid::regclass::text AS table_name, tgname, pg_get_triggerdef(oid) AS definition
      FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2
    `),
    functions: await query(`
      SELECT p.proname, pg_get_functiondef(p.oid) AS definition FROM pg_proc p
      WHERE p.pronamespace = 'scalius_compat'::regnamespace ORDER BY p.proname, 2
    `),
  };
}

async function rejects(client: Client, sql: string, pattern: RegExp): Promise<void> {
  await client.query("SAVEPOINT guard");
  try {
    await expect(client.query(sql)).rejects.toThrow(pattern);
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT guard");
  }
}

const movement = (id: string, delta: number, location: string | null, before: number, version: number) => `
  INSERT INTO inventory_movements (
    id, variant_id, type, quantity, previous_stock, new_stock, ledger_version, pool, stock_version_before,
    stock_version_after, stock_delta, previous_reserved_stock, new_reserved_stock, reserved_stock_delta,
    previous_preorder_stock, new_preorder_stock, preorder_stock_delta, location_id
  ) VALUES ('${id}', 'var_1', 'adjusted', ${delta}, ${before}, ${before + delta}, 2, 'regular', ${version},
    ${version + 1}, ${delta}, 0, 0, 0, 0, 0, 0, ${location === null ? "NULL" : `'${location}'`})`;

describe.runIf(postgresUrl)("0102 inventory locations PostgreSQL sidecar", () => {
  it("upgrades a pre-0102 schema to exactly the fresh schema", async () => {
    // Fresh through 0102 only: later migrations have their own sidecar tests.
    const [fresh, before] = await Promise.all([
      compileCanonicalPostgresSchema({ beforeMigration: "0103_" }),
      compileCanonicalPostgresSchema({ beforeMigration: "0102_" }),
    ]);
    const freshDatabase = await database(fresh.sql);
    const upgraded = await database(before.sql);
    await applySidecar(upgraded);
    const [expected, actual] = await Promise.all([catalog(freshDatabase), catalog(upgraded)]);
    expect(actual.columns).toEqual(expected.columns);
    expect(actual.constraints).toEqual(expected.constraints);
    expect(actual.indexes).toEqual(expected.indexes);
    expect(actual.triggers).toEqual(expected.triggers);
    expect(actual.functions).toEqual(expected.functions);
  }, 180_000);

  it("books existing stock at the default location and enforces the level guards", async () => {
    const before = await compileCanonicalPostgresSchema({ beforeMigration: "0102_" });
    const client = await database(before.sql);
    await client.query(`
      INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('prod_1', 'Kurta', 'kurta', 80000, 1);
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory)
      VALUES ('var_1', 'prod_1', 'KURTA', 80000, 5, 0, 1, 1, 1);
    `);
    await applySidecar(client);
    expect((await client.query("SELECT variant_id, location_id, on_hand FROM inventory_levels")).rows)
      .toEqual([{ variant_id: "var_1", location_id: "loc_default", on_hand: 5 }]);

    await client.query("BEGIN");
    await client.query(`
      INSERT INTO inventory_locations (id, name, code, kind, is_default, status, position)
      VALUES ('loc_b', 'Branch', 'BR', 'store', 0, 'active', 1)
    `);
    await rejects(client, movement("mv_none", 2, null, 5, 1), /INVENTORY_LOCATION_REQUIRED/);
    await rejects(client, movement("mv_short", -1, "loc_b", 5, 1), /INVENTORY_LEVEL_SHORTFALL/);
    await client.query(movement("mv_in", 3, "loc_b", 5, 1));
    await client.query(movement("mv_in_again", 2, "loc_b", 8, 2));
    await client.query(movement("mv_out", -4, "loc_b", 10, 3));
    expect((await client.query("SELECT location_id, on_hand FROM inventory_levels ORDER BY location_id")).rows).toEqual([
      { location_id: "loc_b", on_hand: 1 },
      { location_id: "loc_default", on_hand: 5 },
    ]);
    await rejects(client, "UPDATE inventory_movements SET location_id = 'loc_default' WHERE id = 'mv_in'", /immutable/);
    await client.query("DELETE FROM inventory_movements WHERE id = 'mv_out'");
    expect((await client.query("SELECT on_hand FROM inventory_levels WHERE location_id = 'loc_b'")).rows)
      .toEqual([{ on_hand: 5 }]);
    await rejects(client, "UPDATE inventory_locations SET is_default = 1 WHERE id = 'loc_b'", /inventory_locations_default_unique/);
    await client.query("ROLLBACK");
  }, 180_000);
});
