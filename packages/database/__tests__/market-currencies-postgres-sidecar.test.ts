// PostgreSQL sidecar for 0123_market_currencies, on the upgrade path a real
// PostgreSQL store follows (the fresh 0103 schema plus every later sidecar):
// every market keeps the shop currency, the guards keep the backup market in
// it and a market in its own currency in fx mode, a currency change fences
// checkout and advances the market's keys, and customer spend is kept in the
// shop currency. Opt-in, like the other sidecars.
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

describe.runIf(postgresUrl)("0123 market currencies PostgreSQL sidecar", () => {
  it("adds a market's own currency with its guards, fence, cache key and shop-currency spend", async () => {
    const before = await compileCanonicalPostgresSchema({ beforeMigration: "0104_" });
    const client = await database(before.sql);
    for (const file of sidecars.slice(0, -1)) await applySidecar(client, file);
    await client.query("INSERT INTO markets (id, handle, name, status, price_mode, fx_rate) VALUES ('mkt_gb', 'uk', 'UK', 'active', 'fx', '1')");
    await applySidecar(client, sidecars.at(-1)!);

    const markets = await client.query("SELECT id, currency_code, fx_rate_as_of IS NOT NULL AS dated, fx_lock_minutes FROM markets ORDER BY id");
    expect(markets.rows).toEqual([
      { id: "mkt_backup", currency_code: null, dated: false, fx_lock_minutes: "30" },
      { id: "mkt_gb", currency_code: null, dated: true, fx_lock_minutes: "30" },
    ]);
    await expect(client.query("UPDATE markets SET currency_code = 'USD' WHERE id = 'mkt_backup'")).rejects.toThrow(/MARKET_CURRENCY_INVALID/);
    await expect(client.query("UPDATE markets SET currency_code = 'GBP', price_mode = 'fixed' WHERE id = 'mkt_gb'")).rejects.toThrow(/MARKET_CURRENCY_INVALID/);
    await expect(client.query("UPDATE markets SET fx_lock_minutes = 2 WHERE id = 'mkt_gb'")).rejects.toThrow(/markets_fx_lock_minutes/);

    await client.query("INSERT INTO checkout_authority (id, revision) VALUES ('default', 1) ON CONFLICT (id) DO NOTHING");
    const revision = async () => Number((await client.query("SELECT revision FROM checkout_authority WHERE id = 'default'")).rows[0].revision);
    const seq = async (key: string) => Number((await client.query("SELECT seq FROM cache_dep WHERE dep = $1", [key])).rows[0]?.seq ?? 0);
    const start = { revision: await revision(), market: await seq("mk:mkt_gb") };
    await client.query("UPDATE markets SET currency_code = 'GBP', fx_rate = '0.0068' WHERE id = 'mkt_gb'");
    expect(await revision()).toBeGreaterThan(start.revision);
    expect(await seq("mk:mkt_gb")).toBeGreaterThan(start.market);

    await client.query(`
      INSERT INTO customers (id, name, phone) VALUES ('cust_1', 'Rahim', '+8801711111111');
      INSERT INTO orders (id, customer_id, customer_name, customer_phone, shipping_address, city, zone, status, paid_amount_minor, total_amount_minor, total_shop_minor)
        VALUES ('ord_1', 'cust_1', 'Rahim', '+8801711111111', 'House 1', 'city_1', 'zone_1', 'delivered', 36000, 36000, 36000);
      INSERT INTO orders (id, customer_id, customer_name, customer_phone, shipping_address, city, zone, status,
        currency_code, shop_currency, fx_rate, paid_amount_minor, total_amount_minor, total_shop_minor)
      VALUES ('ord_2', 'cust_1', 'Rahim', '+8801711111111', 'House 1', 'city_1', 'zone_1', 'pending',
        'GBP', 'BDT', '147.058823529412', 680, 1020, 150000);
    `);
    const spent = await client.query("SELECT total_spent_minor FROM customer_order_stats WHERE customer_id = 'cust_1'");
    expect(Number(spent.rows[0].total_spent_minor)).toBe(136_000);

    const ledger = await client.query("SELECT name FROM scalius_schema_migrations WHERE version = 123");
    expect(ledger.rows[0]?.name).toBe("0123_market_currencies");
  });
});
