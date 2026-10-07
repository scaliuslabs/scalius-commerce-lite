// PostgreSQL sidecar for 0124_theme_restore_points, on the upgrade path a
// real PostgreSQL store follows (the fresh 0103 schema plus every later
// sidecar): the restore point table with its checks. Opt-in, like the other
// sidecars.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { compileCanonicalPostgresSchema } from "../scripts/postgres-schema";

// Opt-in: point SCALIUS_TEST_POSTGRES_URL at a disposable server.
const postgresUrl = process.env.SCALIUS_TEST_POSTGRES_URL?.trim();
const sidecars = [
  "0104_custom_fields",
  "0105_plugin_runtime",
  "0106_theme_document_v6",
  "0107_plugin_platform",
  "0108_customer_marketing",
  "0109_inventory_purchasing",
  "0110_plugin_providers",
  "0111_order_money_chain",
  "0112_markets",
  "0113_country_aware_addresses",
  "0114_shipping_zones",
  "0115_selling_countries_dependency",
  "0116_tax_regions",
  "0117_phoneless_guest_customers",
  "0118_places",
  "0119_billing_addresses",
  "0120_price_lists",
  "0121_translations",
  "0122_sales_channels",
  "0123_market_currencies",
  "0124_theme_restore_points",
].map((name) => join(import.meta.dirname, `../migrations/postgres/${name}.sql`));

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

async function applySidecar(client: Client, file: string): Promise<void> {
  const sql = readFileSync(file, "utf8");
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

describe.runIf(postgresUrl)("0124 theme restore points PostgreSQL sidecar", () => {
  it("adds the restore point table with its id, reason and revision checks", async () => {
    const before = await compileCanonicalPostgresSchema({ beforeMigration: "0104_" });
    const client = await database(before.sql);
    for (const file of sidecars) await applySidecar(client, file);
    await client.query("INSERT INTO theme_restore_points (id, theme, draft_revision, reason) VALUES ('themerp_abcd1234', '{}', 7, 'discard')");
    const rows = await client.query("SELECT reason, draft_revision FROM theme_restore_points");
    expect(rows.rows).toEqual([{ reason: "discard", draft_revision: "7" }]);
    await expect(client.query("INSERT INTO theme_restore_points (id, theme, draft_revision, reason) VALUES ('rp_1', '{}', 7, 'restore')")).rejects.toThrow(/theme_restore_points_id_shape/);
    await expect(client.query("INSERT INTO theme_restore_points (id, theme, draft_revision, reason) VALUES ('themerp_abcd5678', '{}', 7, 'publish')")).rejects.toThrow(/theme_restore_points_reason_check/);
    await expect(client.query("INSERT INTO theme_restore_points (id, theme, draft_revision, reason) VALUES ('themerp_abcd9012', '{}', 0, 'restore')")).rejects.toThrow(/theme_restore_points_draft_revision_positive/);
    const ledger = await client.query("SELECT name FROM scalius_schema_migrations WHERE version = 124");
    expect(ledger.rows[0]?.name).toBe("0124_theme_restore_points");
  });
});
