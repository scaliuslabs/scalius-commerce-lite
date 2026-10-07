// PostgreSQL sidecar for 0122_sales_channels, on the upgrade path a real
// PostgreSQL store follows (the fresh 0103 schema plus every later sidecar):
// the built-in channels, every product published to every channel but the
// feed flag's products off the feeds and AI agents, every location linked,
// the order column with its guards, the publication fences and events, and
// the cache keys. Opt-in, like the other sidecars.
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

describe.runIf(postgresUrl)("0122 sales channels PostgreSQL sidecar", () => {
  it("adds channels, publications and channel locations with their guards, fences, events and cache keys", async () => {
    const before = await compileCanonicalPostgresSchema({ beforeMigration: "0104_" });
    const client = await database(before.sql);
    for (const file of sidecars.slice(0, -1)) await applySidecar(client, file);
    await client.query(`
      INSERT INTO products (id, name, price_minor, slug, is_active, exclude_from_product_feed) VALUES ('p_tee', 'Tee', 50000, 'tee', 1, 0), ('p_cap', 'Cap', 20000, 'cap', 1, 1);
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status, channel) VALUES ('o_bot', 'B', '+8801711111112', 'H', 'c', 'z', 'pending', 'agent');
      INSERT INTO checkout_authority (id, revision) VALUES ('default', 1) ON CONFLICT (id) DO NOTHING;
    `);
    await applySidecar(client, sidecars.at(-1)!);

    const channels = await client.query("SELECT id, kind FROM sales_channels ORDER BY position");
    expect(channels.rows).toEqual([
      { id: "sc_online_store", kind: "online_store" },
      { id: "sc_google", kind: "catalog_feed" },
      { id: "sc_meta", kind: "catalog_feed" },
      { id: "sc_agents", kind: "agent" },
    ]);
    const unpublished = await client.query("SELECT product_id, channel_id FROM product_channel_publications WHERE unpublished_at IS NOT NULL ORDER BY channel_id");
    expect(unpublished.rows).toEqual([
      { product_id: "p_cap", channel_id: "sc_agents" },
      { product_id: "p_cap", channel_id: "sc_google" },
      { product_id: "p_cap", channel_id: "sc_meta" },
    ]);
    const columns = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'exclude_from_product_feed'");
    expect(columns.rows).toEqual([]);
    expect((await client.query("SELECT sales_channel_id FROM orders WHERE id = 'o_bot'")).rows[0]).toEqual({ sales_channel_id: "sc_agents" });
    expect((await client.query("SELECT count(*)::int AS n FROM sales_channel_locations")).rows[0]).toEqual({ n: 4 });

    await expect(client.query("DELETE FROM sales_channels WHERE id = 'sc_online_store'")).rejects.toThrow(/SALES_CHANNEL_ONLINE_STORE_REQUIRED/);
    await expect(client.query("UPDATE orders SET sales_channel_id = 'sc_google' WHERE id = 'o_bot'")).rejects.toThrow(/immutable/);
    await expect(client.query("DELETE FROM sales_channels WHERE id = 'sc_agents'")).rejects.toThrow(/SALES_CHANNEL_HAS_ORDERS/);

    await client.query("INSERT INTO products (id, name, price_minor, slug) VALUES ('p_new', 'New', 1000, 'new')");
    expect((await client.query("SELECT count(*)::int AS n FROM product_channel_publications WHERE product_id = 'p_new' AND unpublished_at IS NULL")).rows[0]).toEqual({ n: 4 });
    const events = await client.query("SELECT count(*)::int AS n FROM event_outbox WHERE topic = 'product.publication_changed' AND resource_id = 'p_new'");
    expect(events.rows[0]).toEqual({ n: 4 });

    const revision = async () => Number((await client.query("SELECT revision FROM checkout_authority WHERE id = 'default'")).rows[0].revision);
    const seq = async (key: string) => Number((await client.query("SELECT seq FROM cache_dep WHERE dep = $1", [key])).rows[0]?.seq ?? 0);
    const start = { revision: await revision(), all: await seq("lm:all"), product: await seq("p:p_tee"), store: await seq("store") };
    await client.query("UPDATE product_channel_publications SET unpublished_at = published_at + 1 WHERE product_id = 'p_tee' AND channel_id = 'sc_online_store'");
    expect(await revision()).toBe(start.revision + 1);
    expect(await seq("lm:all")).toBeGreaterThan(start.all);
    expect(await seq("p:p_tee")).toBeGreaterThan(start.product);
    await client.query("DELETE FROM sales_channel_locations WHERE channel_id = 'sc_meta'");
    expect(await seq("store")).toBeGreaterThan(start.store);

    const ledger = await client.query("SELECT name FROM scalius_schema_migrations WHERE version = 122");
    expect(ledger.rows[0]?.name).toBe("0122_sales_channels");
  });
});
