// PostgreSQL sidecar for 0111_order_money_chain, on the upgrade path a real
// PostgreSQL store follows (the fresh 0103 schema plus every later sidecar):
// populated orders and payments come out same-currency and settled as
// presented, and no event row is written. Opt-in, like the other sidecars.
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
].map((name) => join(import.meta.dirname, `../migrations/postgres/${name}.sql`));

const openClients: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of openClients.splice(0)) await close();
});

async function database(schemaSql: string): Promise<Client> {
  const name = `scalius_mc_${randomUUID().replaceAll("-", "")}`;
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

describe.runIf(postgresUrl)("0111 order money chain PostgreSQL sidecar", () => {
  it("backfills orders as same-currency and payments as settled, without events", async () => {
    const before = await compileCanonicalPostgresSchema({ beforeMigration: "0104_" });
    const client = await database(before.sql);
    for (const file of sidecars.slice(0, -1)) await applySidecar(client, file);
    await client.query(`
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status, payment_method,
        payment_status, currency_code, currency_decimal_places, subtotal_amount_minor, shipping_amount_minor,
        discount_amount_minor, tax_amount_minor, total_amount_minor, paid_amount_minor, balance_due_minor)
      VALUES ('ord_1', 'Rahim', '+8801711111111', 'House 1', 'city_1', 'zone_1', 'delivered', 'cod', 'paid',
        'BDT', 2, 250000, 6000, 10000, 12000, 258000, 258000, 0);
      INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status)
      VALUES ('pay_1', 'ord_1', 258000, 'BDT', 'cod', 'full', 'succeeded');
    `);
    const events = Number((await client.query("SELECT count(*) AS n FROM event_outbox")).rows[0].n);
    await applySidecar(client, sidecars.at(-1)!);

    expect((await client.query(`SELECT shop_currency, fx_rate, fx_source, fx_as_of, fx_locked_until, subtotal_shop_minor,
      shipping_shop_minor, discount_shop_minor, tax_shop_minor, total_shop_minor FROM orders`)).rows).toEqual([{
      shop_currency: "BDT", fx_rate: "1", fx_source: "same_currency", fx_as_of: null, fx_locked_until: null,
      subtotal_shop_minor: 250000, shipping_shop_minor: 6000, discount_shop_minor: 10000, tax_shop_minor: 12000,
      total_shop_minor: 258000,
    }]);
    expect((await client.query(`SELECT settlement_currency, settlement_amount_minor, settlement_rate,
      exchange_adjustment_minor FROM order_payments`)).rows).toEqual([{
      settlement_currency: "BDT", settlement_amount_minor: 258000, settlement_rate: "1", exchange_adjustment_minor: 0,
    }]);
    expect(Number((await client.query("SELECT count(*) AS n FROM event_outbox")).rows[0].n)).toBe(events);
    expect((await client.query("SELECT version FROM scalius_schema_migrations ORDER BY version DESC LIMIT 1")).rows)
      .toEqual([{ version: 111 }]);
  }, 240_000);
});
