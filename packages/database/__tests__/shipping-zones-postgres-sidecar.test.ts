// PostgreSQL sidecar for 0114_shipping_zones, on the upgrade path a real
// PostgreSQL store follows (the fresh 0103 schema plus every later sidecar):
// the Everywhere else rates become the zone "Bangladesh", local pickup stays
// store-wide, a live delivery rate needs a zone, one zone holds a region, and
// a region write fences checkout. Opt-in, like the other sidecars.
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
  "0114_shipping_zones",
].map((name) => join(import.meta.dirname, `../migrations/postgres/${name}.sql`));

const openClients: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of openClients.splice(0)) await close();
});

async function database(schemaSql: string): Promise<Client> {
  const name = `scalius_sz_${randomUUID().replaceAll("-", "")}`;
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

describe.runIf(postgresUrl)("0114 shipping zones PostgreSQL sidecar", () => {
  it("turns the Everywhere else rates into the Bangladesh zone and guards zones and regions", async () => {
    const before = await compileCanonicalPostgresSchema({ beforeMigration: "0104_" });
    const client = await database(before.sql);
    for (const file of sidecars.slice(0, -1)) await applySidecar(client, file);
    await client.query(`
      INSERT INTO delivery_zones (id, name, sort_order) VALUES ('dz_dhaka', 'Inside Dhaka', 2);
      INSERT INTO shipping_methods (id, name, fee_minor, zone_id, kind) VALUES ('sm_inside', 'Inside Dhaka', 6000, 'dz_dhaka', 'delivery');
      INSERT INTO shipping_methods (id, name, fee_minor, free_over_minor, kind) VALUES ('sm_outside', 'Outside Dhaka', 12000, 300000, 'delivery');
      INSERT INTO shipping_methods (id, name, fee_minor, kind, pickup_address) VALUES ('sm_pickup', 'Shop pickup', 0, 'pickup', 'House 1');
      INSERT INTO settings (id, category, key, value, type, revision) VALUES ('set_elsewhere', 'delivery_everywhere_else', 'document', '{}', 'json', 4);
    `);
    await applySidecar(client, sidecars.at(-1)!);

    expect((await client.query("SELECT id, name, sort_order FROM delivery_zones ORDER BY sort_order")).rows)
      .toEqual([{ id: "dz_dhaka", name: "Inside Dhaka", sort_order: 2 }, { id: "dz_bd", name: "Bangladesh", sort_order: 3 }]);
    expect((await client.query("SELECT country_code, admin_area, postal_prefix, zone_id FROM delivery_zone_regions")).rows)
      .toEqual([{ country_code: "BD", admin_area: "", postal_prefix: "", zone_id: "dz_bd" }]);
    expect((await client.query("SELECT id, zone_id FROM shipping_methods ORDER BY id")).rows).toEqual([
      { id: "sm_inside", zone_id: "dz_dhaka" },
      { id: "sm_outside", zone_id: "dz_bd" },
      { id: "sm_pickup", zone_id: null },
    ]);
    expect((await client.query("SELECT category, revision FROM settings WHERE id = 'set_elsewhere'")).rows)
      .toEqual([{ category: "delivery_pickup", revision: 4 }]);

    await expect(client.query("INSERT INTO shipping_methods (id, name, fee_minor) VALUES ('sm_x', 'Flat', 100)"))
      .rejects.toThrow(/SHIPPING_RATE_ZONE_REQUIRED/);
    await expect(client.query("INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('BD', 'dz_dhaka')"))
      .rejects.toThrow(/duplicate key/);
    await expect(client.query("INSERT INTO delivery_zone_regions (country_code, admin_area, postal_prefix, zone_id) VALUES ('US', 'CA', '941', 'dz_dhaka')"))
      .rejects.toThrow(/check constraint/);
    // The canonical schema has no seed rows: the fence row is the store's.
    await client.query("INSERT INTO checkout_authority (id, revision) VALUES ('default', 1) ON CONFLICT (id) DO NOTHING");
    const revision = async () => Number((await client.query("SELECT revision FROM checkout_authority WHERE id = 'default'")).rows[0].revision);
    const fence = await revision();
    await client.query("INSERT INTO delivery_zone_regions (country_code, postal_prefix, zone_id) VALUES ('GB', 'SW1', 'dz_dhaka')");
    expect(await revision()).toBeGreaterThan(fence);
    expect((await client.query("SELECT version FROM scalius_schema_migrations ORDER BY version DESC LIMIT 1")).rows)
      .toEqual([{ version: 114 }]);
  }, 240_000);
});
