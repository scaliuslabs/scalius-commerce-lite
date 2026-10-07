// PostgreSQL sidecar for 0118_places, on the upgrade path a real PostgreSQL
// store follows (the fresh 0103 schema plus every later sidecar): every
// delivery location becomes a Bangladesh place with its id and level, zone
// places follow it, and the guards, fence and `loc` key work on places.
// Opt-in, like the other sidecars.
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

describe.runIf(postgresUrl)("0118 places PostgreSQL sidecar", () => {
  it("moves every delivery location into places and guards, fences and keys them", async () => {
    const before = await compileCanonicalPostgresSchema({ beforeMigration: "0104_" });
    const client = await database(before.sql);
    for (const file of sidecars.slice(0, -1)) await applySidecar(client, file);
    await client.query(`
      INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata, is_active, deleted_at)
        VALUES ('city_dhaka', 'Dhaka', 'city', NULL, '{"pathao":"1"}', '{}', 1, NULL),
               ('zone_mirpur', 'Mirpur', 'zone', 'city_dhaka', '{}', '{}', 1, NULL),
               ('area_s10', 'Section 10', 'area', 'zone_mirpur', '{}', '{}', 0, 1700000000);
      INSERT INTO delivery_zones (id, name) VALUES ('dz_dhaka', 'Inside Dhaka');
      INSERT INTO delivery_zone_locations (location_id, zone_id) VALUES ('city_dhaka', 'dz_dhaka');
    `);
    await applySidecar(client, sidecars.at(-1)!);

    expect((await client.query("SELECT id, country_code, level, parent_id, is_active, deleted_at FROM places ORDER BY level")).rows).toEqual([
      { id: "city_dhaka", country_code: "BD", level: "1", parent_id: null, is_active: "1", deleted_at: null },
      { id: "zone_mirpur", country_code: "BD", level: "2", parent_id: "city_dhaka", is_active: "1", deleted_at: null },
      { id: "area_s10", country_code: "BD", level: "3", parent_id: "zone_mirpur", is_active: "0", deleted_at: "1700000000" },
    ]);
    expect((await client.query("SELECT to_regclass('delivery_locations') AS old")).rows).toEqual([{ old: null }]);
    expect((await client.query(
      "SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'cdep_delivery_locations_%' OR proname LIKE 'delivery_locations_checkout_authority_%'",
    )).rows).toEqual([{ n: 0 }]);

    await expect(client.query("INSERT INTO delivery_zone_locations (location_id, zone_id) VALUES ('nowhere', 'dz_dhaka')"))
      .rejects.toThrow(/foreign key/);
    await expect(client.query("INSERT INTO places (id, country_code, level, parent_id, name, external_ids, metadata) VALUES ('bad', 'BD', 3, 'city_dhaka', 'Bad', '{}', '{}')"))
      .rejects.toThrow(/PLACE_PARENT_INVALID/);
    await expect(client.query("INSERT INTO places (id, country_code, level, parent_id, name, external_ids, metadata) VALUES ('dup', 'BD', 1, NULL, ' dhaka', '{}', '{}')"))
      .rejects.toThrow(/places_active_root_name_uidx/);
    await client.query("INSERT INTO places (id, country_code, level, parent_id, name, external_ids, metadata) VALUES ('in_mh', 'IN', 1, NULL, 'Maharashtra', '{}', '{}')");

    // The canonical schema has no seed rows: the fence and clock rows are the store's.
    await client.query("INSERT INTO checkout_authority (id, revision) VALUES ('default', 1) ON CONFLICT (id) DO NOTHING");
    await client.query("INSERT INTO cache_clock (id, seq) VALUES (1, 0) ON CONFLICT (id) DO NOTHING");
    const revision = async () => Number((await client.query("SELECT revision FROM checkout_authority WHERE id = 'default'")).rows[0].revision);
    const loc = async () => Number((await client.query("SELECT coalesce((SELECT seq FROM cache_dep WHERE dep = 'loc'), 0) AS seq")).rows[0].seq);
    const [fence, key] = [await revision(), await loc()];
    await client.query("UPDATE places SET name = 'Mirpur DOHS' WHERE id = 'zone_mirpur'");
    expect(await revision()).toBeGreaterThan(fence);
    expect(await loc()).toBeGreaterThan(key);
    const [fence2, key2] = [await revision(), await loc()];
    await client.query("UPDATE places SET source = 'bd', source_key = 'pathao:city:1', source_version = 'v1', source_active = 1 WHERE id = 'city_dhaka'");
    expect([await revision(), await loc()]).toEqual([fence2, key2]);
    expect((await client.query("SELECT version::int AS version FROM scalius_schema_migrations ORDER BY version DESC LIMIT 1")).rows)
      .toEqual([{ version: 118 }]);
  }, 240_000);
});
