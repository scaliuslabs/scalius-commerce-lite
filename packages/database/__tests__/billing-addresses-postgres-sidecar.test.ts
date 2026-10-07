// PostgreSQL sidecar for 0119_billing_addresses, on the upgrade path a real
// PostgreSQL store follows (the fresh 0103 schema plus every later sidecar):
// earlier orders keep no billing address, one default billing address per
// customer, and a billing change is an order.updated. Opt-in, like the other
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

describe.runIf(postgresUrl)("0119 billing addresses PostgreSQL sidecar", () => {
  it("adds the billing snapshot, the address source and one default billing address per customer", async () => {
    const before = await compileCanonicalPostgresSchema({ beforeMigration: "0104_" });
    const client = await database(before.sql);
    for (const file of sidecars.slice(0, -1)) await applySidecar(client, file);
    await client.query("INSERT INTO orders (id, customer_name, customer_phone, status, requires_shipping) VALUES ('ord_old', 'Buyer', '+8801711111111', 'pending', 0)");
    await applySidecar(client, sidecars.at(-1)!);

    const old = await client.query("SELECT billing_same_as_shipping AS same, billing_country_code AS country FROM orders WHERE id = 'ord_old'");
    expect(old.rows[0]).toEqual({ same: "0", country: null });

    await client.query("DELETE FROM event_outbox");
    await client.query("UPDATE orders SET billing_country_code = 'DE', billing_postal_code = '10115' WHERE id = 'ord_old'");
    const events = await client.query("SELECT topic, data FROM event_outbox");
    expect(events.rows.map((row: { topic: string }) => row.topic)).toEqual(["order.updated"]);
    expect(String(events.rows[0].data)).not.toContain("10115");
    await expect(client.query("UPDATE orders SET billing_country_code = 'de' WHERE id = 'ord_old'")).rejects.toThrow(/orders_billing_country_shape/);

    await client.query("INSERT INTO customers (id, name, phone) VALUES ('cust_1', 'Karim', '+8801711111112')");
    await client.query("INSERT INTO customer_addresses (id, customer_id, country_code, line1, is_default_billing) VALUES ('caddr_a', 'cust_1', 'DE', 'Hauptstr. 1', 1), ('caddr_b', 'cust_1', 'DE', 'Hauptstr. 2', 0)");
    await expect(client.query("UPDATE customer_addresses SET is_default_billing = 1 WHERE id = 'caddr_b'")).rejects.toThrow(/customer_addresses_default_billing_unique/);
    await expect(client.query("INSERT INTO order_tax_snapshots (order_id, currency_code, decimal_places, display_label, prices_include_tax, shipping_taxed, settings_version, calculation_version, destination_snapshot, rate_snapshot, address_source) VALUES ('ord_old', 'EUR', 2, 'VAT', 1, 0, 1, 'tax-v1', '{}', '{}', 'home')"))
      .rejects.toThrow(/order_tax_snapshots_address_source_check/);
    const ledger = await client.query("SELECT name FROM scalius_schema_migrations WHERE version = 119");
    expect(ledger.rows[0]?.name).toBe("0119_billing_addresses");
  });
});
