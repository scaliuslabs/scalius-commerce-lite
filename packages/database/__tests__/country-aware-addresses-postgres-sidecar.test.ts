// PostgreSQL sidecar for 0113_country_aware_addresses, on the upgrade path a
// real PostgreSQL store follows (the fresh 0103 schema plus every later
// sidecar): shipped orders become Bangladesh addresses, customer addresses
// move into the address book, the per-country trigger and the seed behave as
// on D1, and address-book writes are customer.updated. Opt-in, like the other
// sidecars.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, types } from "pg";
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
].map((name) => join(import.meta.dirname, `../migrations/postgres/${name}.sql`));

const openClients: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of openClients.splice(0)) await close();
});

async function database(schemaSql: string): Promise<Client> {
  const name = `scalius_ad_${randomUUID().replaceAll("-", "")}`;
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

describe.runIf(postgresUrl)("0113 country-aware addresses PostgreSQL sidecar", () => {
  it("backfills orders, moves customer addresses and checks addresses per country", async () => {
    const before = await compileCanonicalPostgresSchema({ beforeMigration: "0104_" });
    const client = await database(before.sql);
    for (const file of sidecars.slice(0, -1)) await applySidecar(client, file);
    await client.query(`
      INSERT INTO customers (id, name, phone, address, city, zone, city_name, zone_name)
      VALUES ('cust_1', 'Karim', '+8801711111112', 'House 3', 'c1', 'z1', 'Dhaka', 'Dhanmondi');
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, city_name, zone_name, status)
      VALUES ('ord_1', 'Rahim', '+8801711111111', 'House 1', 'c1', 'z1', 'Dhaka', 'Dhanmondi', 'pending');
    `);
    const events = Number((await client.query("SELECT count(*) AS n FROM event_outbox")).rows[0].n);
    await applySidecar(client, sidecars.at(-1)!);

    expect((await client.query("SELECT shipping_country_code, shipping_locality, shipping_dependent_locality FROM orders")).rows)
      .toEqual([{ shipping_country_code: "BD", shipping_locality: "Dhaka", shipping_dependent_locality: "Dhanmondi" }]);
    expect((await client.query("SELECT id, customer_id, is_default, country_code, line1, locality, city FROM customer_addresses")).rows)
      .toEqual([{ id: "caddr_cust_1", customer_id: "cust_1", is_default: 1, country_code: "BD", line1: "House 3", locality: "Dhaka", city: "c1" }]);
    const customerColumns = (await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'customers' AND column_name IN ('address', 'city', 'city_name')",
    )).rows;
    expect(customerColumns).toEqual([]);
    expect(Number((await client.query("SELECT count(*) AS n FROM event_outbox")).rows[0].n)).toBe(events);

    const order = (id: string, values: string) => client.query(
      `INSERT INTO orders (id, customer_name, customer_phone, status, ${values.split("|")[0]}) VALUES ('${id}', 'X', '+8801711111111', 'pending', ${values.split("|")[1]})`,
    );
    await expect(order("bd_no_zone", "shipping_address, shipping_country_code, city|'House 1', 'BD', 'c1'")).rejects.toThrow(/shipping address required/);
    await order("us_ok", "shipping_address, shipping_country_code, shipping_locality, shipping_admin_area, shipping_postal_code|'1 Loop', 'US', 'Cupertino', 'CA', '95014'");
    await expect(order("us_no_zip", "shipping_address, shipping_country_code, shipping_locality, shipping_admin_area|'1 Loop', 'US', 'Cupertino', 'CA'")).rejects.toThrow(/shipping address required/);
    await order("us_skipped", "shipping_address, shipping_country_code, shipping_validation_skipped|'1 Loop', 'US', 1");

    await client.query("INSERT INTO customers (id, name, phone) VALUES ('guest', 'G', '+8801711111119')");
    await order("seed", "customer_id, shipping_address, shipping_country_code, city, zone|'guest', 'House 9', 'BD', 'c1', 'z1'");
    expect((await client.query("SELECT id, is_default, line1 FROM customer_addresses WHERE customer_id = 'guest'")).rows)
      .toEqual([{ id: "caddr_guest", is_default: 1, line1: "House 9" }]);
    await expect(client.query("INSERT INTO customer_addresses (id, customer_id, is_default, country_code) VALUES ('x', 'guest', 1, 'IN')"))
      .rejects.toThrow(/unique/i);
    // The seeded first address is part of the record (no customer.updated); a later change is an update.
    expect((await client.query("SELECT topic FROM event_outbox WHERE resource_id = 'guest' ORDER BY id")).rows.map((row) => row.topic))
      .not.toContain("customer.updated");
    await client.query("UPDATE customer_addresses SET line1 = 'House 10' WHERE id = 'caddr_guest'");
    expect((await client.query("SELECT topic FROM event_outbox WHERE resource_id = 'guest' ORDER BY id")).rows.map((row) => row.topic))
      .toContain("customer.updated");
    expect((await client.query("SELECT version FROM scalius_schema_migrations ORDER BY version DESC LIMIT 1")).rows)
      .toEqual([{ version: 113 }]);
  }, 240_000);
});
