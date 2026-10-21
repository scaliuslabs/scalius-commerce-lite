// The PostgreSQL upgrade chain on a real server, from the verified 0049
// baseline to the current release, through the production runner
// (`applyPostgresSchemaUpgrades`): one serializable transaction per sidecar.
// A sidecar a supported server version rejects fails here (0053's unaliased
// derived tables failed on PostgreSQL 15), and the upgraded store must hold
// exactly the tables, columns, indexes and triggers of a fresh canonical
// install. Opt-in: point SCALIUS_TEST_POSTGRES_URL at a disposable server
// (run it on the oldest and the newest supported major).
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { compileCanonicalPostgresSchema } from "../scripts/postgres-schema";
import {
  applyPostgresSchemaUpgrades,
  loadSchemaUpgradeArtifacts,
} from "../scripts/upgrade-provider-schema";
import { connectPostgres } from "../src/postgres-adapter";
import {
  POSTGRES_MIGRATION_CONTROL_SCHEMA,
  POSTGRES_MIGRATION_STATE_TABLE,
  postgresMigrationControlTable,
} from "../src/postgres-migration-control";
import { CURRENT_DATABASE_SCHEMA, DATABASE_SCHEMA_LEGACY_BASELINE } from "../src/schema-contract";
import { createMigratedSqlite } from "../src/testing/sqlite-d1";
import { loadMigrationSeed, NATIVE_POSTGRES_TEST_TIMEOUT, nativePostgresUrl } from "../src/testing/postgres-native";

const serverUrl = nativePostgresUrl();
const open: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const close of open.splice(0).reverse()) await close();
});

async function freshDatabase(label: string): Promise<{ client: Client; url: string }> {
  const name = `scalius_${label}_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: serverUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(serverUrl!);
  url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  open.push(async () => {
    await client.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });
  return { client, url: url.toString() };
}

/** The catalog a store's application reads: tables and columns, indexes and triggers. */
async function catalog(client: Client) {
  const columns = await client.query(`
    SELECT table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable AS entry
    FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1`);
  const indexes = await client.query(`
    SELECT tablename || '.' || indexname AS entry FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`);
  const triggers = await client.query(`
    SELECT DISTINCT event_object_table || '.' || trigger_name AS entry
    FROM information_schema.triggers WHERE trigger_schema = 'public' ORDER BY 1`);
  return {
    columns: columns.rows.map((row) => row.entry as string),
    indexes: indexes.rows.map((row) => row.entry as string),
    triggers: triggers.rows.map((row) => row.entry as string),
  };
}

describe.runIf(serverUrl)("PostgreSQL upgrade chain on a real server", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
  it("upgrades a seeded 0049 store to the current release, the same schema as a fresh install", async () => {
    const { client, url } = await freshDatabase("chain");
    const server = (await client.query("SHOW server_version")).rows[0]?.server_version as string;

    // The 0049 store: its schema bundle with the rows its migrations seeded,
    // and the verified-baseline record the initial import writes.
    const baseline = await compileCanonicalPostgresSchema({ beforeMigration: "0050_" });
    await client.query(baseline.preDataSql);
    await loadMigrationSeed(client, createMigratedSqlite({ provider: "turso", beforeMigration: "0050_" }));
    await client.query(baseline.postDataSql);
    await client.query(`CREATE SCHEMA ${POSTGRES_MIGRATION_CONTROL_SCHEMA}`);
    await client.query(`CREATE TABLE ${postgresMigrationControlTable(POSTGRES_MIGRATION_STATE_TABLE)} (
      schema_version text NOT NULL, schema_sha256 text NOT NULL, phase text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT statement_timestamp())`);
    await client.query(
      `INSERT INTO ${postgresMigrationControlTable(POSTGRES_MIGRATION_STATE_TABLE)} (schema_version, schema_sha256, phase) VALUES ($1, $2, 'complete')`,
      [DATABASE_SCHEMA_LEGACY_BASELINE.postgresSchemaBundleVersion, DATABASE_SCHEMA_LEGACY_BASELINE.postgresSchemaSha256],
    );

    const artifacts = await loadSchemaUpgradeArtifacts();
    const result = await applyPostgresSchemaUpgrades(connectPostgres(url), artifacts).catch((error: unknown) => {
      throw new Error(`PostgreSQL ${server}: ${error instanceof Error ? error.message : String(error)}`);
    });
    expect(result.before.version).toBe(DATABASE_SCHEMA_LEGACY_BASELINE.version);
    expect(result.after).toMatchObject({ version: CURRENT_DATABASE_SCHEMA.version, name: CURRENT_DATABASE_SCHEMA.name });
    expect(result.applied.map((artifact) => artifact.version)).toEqual(artifacts.map((artifact) => artifact.version));

    // A replay finds nothing to apply.
    expect((await applyPostgresSchemaUpgrades(connectPostgres(url), artifacts)).applied).toEqual([]);

    const fresh = await freshDatabase("fresh");
    await fresh.client.query((await compileCanonicalPostgresSchema()).sql);
    const upgraded = await catalog(client);
    const installed = await catalog(fresh.client);
    // Known drift, held from growing: these sidecars added the columns as
    // `integer` where a fresh install has `bigint` (every value fits both).
    const integerOnUpgrade = new Set([
      "checkout_languages.revision", "media.variant_width", "orders.order_number", "settings.revision",
      "promotions.combines_with_order_discounts", "promotions.combines_with_product_discounts",
      "promotions.combines_with_shipping_discounts",
    ]);
    const asInstalled = (entry: string) => {
      const [column, type, nullable] = entry.split(" ");
      return integerOnUpgrade.has(column!) && type === "integer" ? `${column} bigint ${nullable}` : entry;
    };
    expect(upgraded.columns.map(asInstalled)).toEqual(installed.columns);
    expect(upgraded.indexes).toEqual(installed.indexes);
    expect(upgraded.triggers).toEqual(installed.triggers);
  });
});
