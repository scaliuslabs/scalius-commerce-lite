// PostgreSQL sidecar for 0120_price_lists, on the upgrade path a real
// PostgreSQL store follows (the fresh 0103 schema plus every later sidecar):
// every market stays fixed, market and sale lists stay off the backup market,
// prices are checked, an active list's writes fence checkout, and the cache
// triggers advance only active public lists' keys. Opt-in, like the other
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

describe.runIf(postgresUrl)("0120 price lists PostgreSQL sidecar", () => {
  it("adds price lists and market pricing with their guards, fences and cache keys", async () => {
    const before = await compileCanonicalPostgresSchema({ beforeMigration: "0104_" });
    const client = await database(before.sql);
    for (const file of sidecars.slice(0, -1)) await applySidecar(client, file);
    await client.query("INSERT INTO markets (id, handle, name, status) VALUES ('mkt_in', 'india', 'India', 'active')");
    await applySidecar(client, sidecars.at(-1)!);

    const markets = await client.query("SELECT id, price_mode, price_adjustment_bps AS bps FROM markets ORDER BY id");
    expect(markets.rows).toEqual([{ id: "mkt_backup", price_mode: "fixed", bps: "0" }, { id: "mkt_in", price_mode: "fixed", bps: "0" }]);
    await expect(client.query("UPDATE markets SET price_mode = 'fx' WHERE id = 'mkt_backup'")).rejects.toThrow(/markets_price_mode_check/);
    await expect(client.query("UPDATE markets SET fx_rate = 'abc' WHERE id = 'mkt_in'")).rejects.toThrow(/markets_fx_rate_shape/);
    await expect(client.query("UPDATE markets SET price_ending_minor = 99 WHERE id = 'mkt_in'")).rejects.toThrow(/markets_price_ending/);

    await client.query(`
      INSERT INTO products (id, name, price_minor, slug, is_active) VALUES ('p_tee', 'Tee', 50000, 'tee', 1);
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory) VALUES ('v_tee', 'p_tee', 'TEE-1', 50000, 5, 0, 1, 1);
      INSERT INTO customer_segments (id, name, definition) VALUES ('seg_vip001', 'VIP', '{"version":1,"match":"all","conditions":[]}');
    `);
    await expect(client.query("INSERT INTO price_lists (id, name, kind, market_id) VALUES ('pl_back', 'Back', 'sale', 'mkt_backup')")).rejects.toThrow(/PRICE_LIST_BACKUP_MARKET/);
    await client.query("INSERT INTO price_lists (id, name, kind, market_id, segment_id) VALUES ('pl_vip', 'VIP', 'segment', 'mkt_backup', 'seg_vip001')");
    await client.query("INSERT INTO price_lists (id, name, kind, market_id) VALUES ('pl_india', 'India', 'market', 'mkt_in')");
    await expect(client.query("INSERT INTO price_list_prices (price_list_id, variant_id, currency_code, amount_minor) VALUES ('pl_india', 'v_tee', 'bdt', 1)")).rejects.toThrow(/price_list_prices_currency_shape/);

    const revision = async () => Number((await client.query("SELECT revision FROM checkout_authority WHERE id = 'default'")).rows[0].revision);
    const seq = async (key: string) => Number((await client.query("SELECT seq FROM cache_dep WHERE dep = $1", [key])).rows[0]?.seq ?? 0);
    const start = { revision: await revision(), list: await seq("pl:mkt_in"), product: await seq("pl:mkt_in:p_tee") };
    await client.query("INSERT INTO price_list_prices (price_list_id, variant_id, currency_code, amount_minor) VALUES ('pl_india', 'v_tee', 'BDT', 45000)");
    expect(await revision()).toBe(start.revision);
    expect(await seq("pl:mkt_in:p_tee")).toBe(start.product);
    await client.query("UPDATE price_lists SET status = 'active' WHERE id = 'pl_india'");
    expect(await revision()).toBeGreaterThan(start.revision);
    expect(await seq("pl:mkt_in")).toBeGreaterThan(start.list);
    const afterActivation = await seq("pl:mkt_in:p_tee");
    await client.query("UPDATE price_list_prices SET amount_minor = 44000 WHERE price_list_id = 'pl_india'");
    expect(await seq("pl:mkt_in:p_tee")).toBeGreaterThan(afterActivation);
    const pricing = await seq("pl:mkt_in");
    await client.query("UPDATE markets SET price_mode = 'fx', price_adjustment_bps = 1000 WHERE id = 'mkt_in'");
    expect(await seq("pl:mkt_in")).toBeGreaterThan(pricing);

    const ledger = await client.query("SELECT name FROM scalius_schema_migrations WHERE version = 120");
    expect(ledger.rows[0]?.name).toBe("0120_price_lists");
  });
});
