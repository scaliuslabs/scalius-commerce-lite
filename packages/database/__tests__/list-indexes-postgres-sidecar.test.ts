// PostgreSQL sidecar for 0127_list_indexes, on the upgrade path a real
// PostgreSQL store follows (the fresh 0103 schema plus every later sidecar):
// the dashboard list indexes exist, the replaced ones are gone, and a replay
// is harmless. Opt-in, like the other sidecars.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { compileCanonicalPostgresSchema } from "../scripts/postgres-schema";

// Opt-in: point SCALIUS_TEST_POSTGRES_URL at a disposable server.
const postgresUrl = process.env.SCALIUS_TEST_POSTGRES_URL?.trim();
const sidecarDirectory = join(import.meta.dirname, "../migrations/postgres");
const sidecars = readdirSync(sidecarDirectory)
  .filter((name) => name >= "0104_" && name < "0128_" && name.endsWith(".sql"))
  .sort()
  .map((name) => join(sidecarDirectory, name));

const openClients: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of openClients.splice(0)) await close();
});

async function database(schemaSql: string): Promise<Client> {
  const name = `scalius_pg_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: postgresUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(postgresUrl!);
  url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  await client.query(schemaSql);
  openClients.push(async () => {
    await client.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  return client;
}

async function applySidecar(client: Client, file: string, options: { skipLedger?: boolean } = {}): Promise<void> {
  const statements = readFileSync(file, "utf8").split("--> statement-breakpoint").filter((statement) => statement.trim());
  await client.query("BEGIN");
  try {
    for (const statement of options.skipLedger ? statements.slice(0, -1) : statements) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

describe.runIf(postgresUrl)("0127 list indexes PostgreSQL sidecar", () => {
  it("adds the list indexes, drops the replaced ones and replays harmlessly", async () => {
    const before = await compileCanonicalPostgresSchema({ beforeMigration: "0104_" });
    const client = await database(before.sql);
    for (const file of sidecars) await applySidecar(client, file);
    const indexes = async () => new Set((await client.query("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()"))
      .rows.map((row: { indexname: string }) => row.indexname));

    const after = await indexes();
    for (const name of ["orders_list_created_idx", "orders_list_status_idx", "orders_list_pickup_idx", "customers_list_updated_idx",
      "products_list_name_idx", "product_reviews_created_idx", "cod_tracking_status_idx", "delivery_shipments_tracking_lookup_idx"]) {
      expect(after.has(name), name).toBe(true);
    }
    for (const name of ["orders_archive_list_idx", "orders_payment_status_list_idx", "orders_channel_list_idx"]) {
      expect(after.has(name), name).toBe(false);
    }
    await applySidecar(client, join(sidecarDirectory, "0127_list_indexes.sql"), { skipLedger: true });
    expect(await indexes()).toEqual(after);
    const ledger = await client.query("SELECT name FROM scalius_schema_migrations WHERE version = 127");
    expect(ledger.rows[0]?.name).toBe("0127_list_indexes");
  });
});
