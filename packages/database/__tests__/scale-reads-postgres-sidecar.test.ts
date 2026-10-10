// PostgreSQL sidecar for 0128_scale_reads, on the upgrade path a real
// PostgreSQL store follows (the fresh 0103 schema plus every later sidecar):
// the new indexes replace the old ones, a customer without orders gets a
// zero customer_order_stats row (backfill) and so does a new one (trigger),
// and a replay is harmless. Opt-in, like the other sidecars.
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

describe.runIf(postgresUrl)("0128 scale reads PostgreSQL sidecar", () => {
  it("replaces the indexes, gives every customer a stats row and replays harmlessly", async () => {
    const before = await compileCanonicalPostgresSchema({ beforeMigration: "0104_" });
    const client = await database(before.sql);
    for (const file of sidecars) await applySidecar(client, file);
    await client.query("INSERT INTO customers (id, name, phone) VALUES ('cus_old', 'Rahim', '+8801711000001')");
    const sidecar = join(sidecarDirectory, "0128_scale_reads.sql");
    await applySidecar(client, sidecar);

    const indexes = async () => new Set((await client.query("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()"))
      .rows.map((row: { indexname: string }) => row.indexname));
    const after = await indexes();
    for (const name of ["orders_sales_rollup_idx", "product_variants_product_live_idx", "customer_order_stats_orders_list_idx",
      "customer_order_stats_spent_list_idx", "customer_order_stats_last_order_list_idx"]) {
      expect(after.has(name), name).toBe(true);
    }
    for (const name of ["orders_dashboard_agg_idx", "product_variants_product_id_idx", "customer_order_stats_orders_idx",
      "customer_order_stats_spent_idx", "customer_order_stats_last_order_idx"]) {
      expect(after.has(name), name).toBe(false);
    }
    await client.query("INSERT INTO customers (id, name, phone) VALUES ('cus_new', 'Karim', '+8801711000002')");
    const stats = await client.query("SELECT customer_id, orders_count, total_spent_minor, last_order_at FROM customer_order_stats ORDER BY customer_id");
    expect(stats.rows.map((row: Record<string, unknown>) => ({ ...row, orders_count: Number(row.orders_count), total_spent_minor: Number(row.total_spent_minor) })))
      .toEqual([
        { customer_id: "cus_new", orders_count: 0, total_spent_minor: 0, last_order_at: null },
        { customer_id: "cus_old", orders_count: 0, total_spent_minor: 0, last_order_at: null },
      ]);

    await applySidecar(client, sidecar, { skipLedger: true });
    expect(await indexes()).toEqual(after);
    expect(Number((await client.query("SELECT count(*) AS n FROM customer_order_stats")).rows[0].n)).toBe(2);
    const ledger = await client.query("SELECT name FROM scalius_schema_migrations WHERE version = 128");
    expect(ledger.rows[0]?.name).toBe("0128_scale_reads");
  });
});
