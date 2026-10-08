// PostgreSQL sidecar for 0126_plugin_seams, on the upgrade path a real
// PostgreSQL store follows (the fresh 0103 schema plus every later sidecar):
// metaobjects with their cache dependency triggers, Web Push subscriptions,
// buyer identities and the market FX rate source. Opt-in, like the other
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
  "0125_plugin_lifecycle",
  "0126_plugin_seams",
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

describe.runIf(postgresUrl)("0126 plugin seams PostgreSQL sidecar", () => {
  it("adds metaobjects with their dependency triggers, push subscriptions, identities and the rate source", async () => {
    const before = await compileCanonicalPostgresSchema({ beforeMigration: "0104_" });
    const client = await database(before.sql);
    for (const file of sidecars) await applySidecar(client, file);
    const seq = async (dep: string) => Number((await client.query("SELECT seq FROM cache_dep WHERE dep = $1", [dep])).rows[0]?.seq ?? 0);

    await client.query(`INSERT INTO metaobject_definitions (id, namespace, type, name, fields, storefront_access)
      VALUES ('mod_faq00001', 'custom', 'faq', 'FAQ', '[]', 1)`);
    const afterDefinition = await seq("mo:mod_faq00001");
    expect(afterDefinition).toBeGreaterThan(0);
    await client.query(`INSERT INTO metaobject_entries (id, definition_id, handle, status, fields)
      VALUES ('moe_ship0001', 'mod_faq00001', 'shipping', 'published', '{"question":"How long?"}')`);
    expect(await seq("mo:mod_faq00001")).toBeGreaterThan(afterDefinition);
    await expect(client.query("INSERT INTO metaobject_entries (id, definition_id, handle) VALUES ('moe_bad00001', 'mod_faq00001', 'Bad Handle')"))
      .rejects.toThrow(/metaobject_entries_handle_shape/);
    await expect(client.query("INSERT INTO metaobject_definitions (id, namespace, type, name) VALUES ('mod_faq00002', 'custom', 'faq', 'Again')"))
      .rejects.toThrow(/duplicate key/);

    const key = "B".repeat(87);
    const auth = "a".repeat(22);
    await client.query("INSERT INTO customers (id, name, phone) VALUES ('cus_1', 'Buyer', '+8801711000001')");
    await client.query(`INSERT INTO push_subscriptions (id, audience, customer_id, endpoint, p256dh, auth)
      VALUES ('psb_buyer0001', 'customer', 'cus_1', 'https://fcm.googleapis.com/fcm/send/x', '${key}', '${auth}')`);
    await expect(client.query(`INSERT INTO push_subscriptions (id, audience, endpoint, p256dh, auth)
      VALUES ('psb_none0001', 'staff', 'https://fcm.googleapis.com/fcm/send/y', '${key}', '${auth}')`)).rejects.toThrow(/push_subscriptions_audience_owner/);
    await client.query("INSERT INTO customer_identities (provider_id, subject, customer_id) VALUES ('acme.sso:google', 'g-1', 'cus_1')");
    await expect(client.query("INSERT INTO customer_identities (provider_id, subject, customer_id) VALUES ('nocolon', 'g-2', 'cus_1')"))
      .rejects.toThrow(/customer_identities_provider_shape/);

    const markets = await client.query("SELECT fx_rate_source FROM markets");
    expect(markets.rows.every((row: { fx_rate_source: string }) => row.fx_rate_source === "manual")).toBe(true);
    const ledger = await client.query("SELECT name FROM scalius_schema_migrations WHERE version = 126");
    expect(ledger.rows[0]?.name).toBe("0126_plugin_seams");
  });
});
