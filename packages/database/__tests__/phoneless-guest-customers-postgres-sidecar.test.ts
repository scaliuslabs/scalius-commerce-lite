// PostgreSQL sidecar for 0117_phoneless_guest_customers, on the upgrade path a
// real PostgreSQL store follows (the fresh 0103 schema plus every later
// sidecar): one guest record per phone except phoneless ones (''), and one
// phoneless guest record per email. Opt-in, like the other sidecars.
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

describe.runIf(postgresUrl)("0117 phoneless guest customers PostgreSQL sidecar", () => {
  it("keeps one guest per phone and one phoneless guest per email", async () => {
    const before = await compileCanonicalPostgresSchema({ beforeMigration: "0104_" });
    const client = await database(before.sql);
    for (const file of sidecars) await applySidecar(client, file);
    const insert = (id: string, phone: string, email: string, claimed = false) => client.query(
      `INSERT INTO customers (id, name, phone, email, account_claimed_at) VALUES ($1, 'Buyer', $2, $3, ${claimed ? "extract(epoch from now())::bigint" : "NULL"})`,
      [id, phone, email],
    );

    await insert("cust_a", "+8801712000001", "a@example.test");
    await expect(insert("cust_a2", "+8801712000001", "other@example.test")).rejects.toThrow(/customers_guest_phone_unique/);
    await insert("cust_p1", "", "one@example.test");
    await insert("cust_p2", "", "two@example.test");
    await expect(insert("cust_p3", "", "ONE@example.test")).rejects.toThrow(/customers_guest_email_unique/);
    await insert("cust_b", "+14155550100", "one@example.test");
    await insert("cust_acc1", "", "one@example.test", true);
    await insert("cust_acc2", "", "one@example.test", true);
    const ledger = await client.query("SELECT name FROM scalius_schema_migrations WHERE version = 117");
    expect(ledger.rows[0]?.name).toBe("0117_phoneless_guest_customers");
    const count = await client.query("SELECT count(*)::int AS n FROM customers WHERE phone = ''");
    expect(count.rows[0]?.n).toBe(4);
  });
});
