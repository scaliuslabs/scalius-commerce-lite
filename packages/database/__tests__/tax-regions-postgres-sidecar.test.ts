// PostgreSQL sidecar for 0116_tax_regions, on the upgrade path a real
// PostgreSQL store follows (the fresh 0103 schema plus every later sidecar):
// today's rates become Bangladesh regions with the same rates, soft-deleted
// rates go, every market carries the store-wide tax flag, the flag leaves
// tax_settings, the region guards hold, and region, rate and market-flag
// writes fence checkout and advance the tax key. Opt-in, like the other
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
  "0114_shipping_zones",
  "0115_selling_countries_dependency",
  "0116_tax_regions",
].map((name) => join(import.meta.dirname, `../migrations/postgres/${name}.sql`));

const openClients: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of openClients.splice(0)) await close();
});

async function database(schemaSql: string): Promise<Client> {
  const name = `scalius_tr_${randomUUID().replaceAll("-", "")}`;
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

describe.runIf(postgresUrl)("0116 tax regions PostgreSQL sidecar", () => {
  it("moves today's rates into Bangladesh regions, the tax flag onto markets and guards regions", async () => {
    const before = await compileCanonicalPostgresSchema({ beforeMigration: "0104_" });
    const client = await database(before.sql);
    for (const file of sidecars.slice(0, -1)) await applySidecar(client, file);
    await client.query(`
      INSERT INTO tax_classes (id, name) VALUES ('taxc_std', 'Standard');
      INSERT INTO tax_settings (id, enabled, prices_include_tax, tax_shipping, default_tax_class_id, display_label, version)
        VALUES ('default', 1, 1, 0, 'taxc_std', 'VAT', 3);
      INSERT INTO tax_rates (id, tax_class_id, name, rate_bps, jurisdiction_type, jurisdiction_id, jurisdiction_label, priority, is_compound, is_active)
        VALUES ('taxr_vat', 'taxc_std', 'VAT', 1500, 'all', NULL, NULL, 0, 0, 1),
               ('taxr_dhaka', 'taxc_std', 'Dhaka', 200, 'city', 'city_dhaka', 'Dhaka', 1, 1, 1);
      INSERT INTO tax_rates (id, tax_class_id, name, rate_bps, jurisdiction_type, deleted_at, is_active)
        VALUES ('taxr_gone', 'taxc_std', 'Gone', 700, 'all', 1700000000, 0);
      INSERT INTO markets (id, handle, name, status, is_backup) VALUES ('mkt_in', 'india', 'India', 'active', 0);
    `);
    await applySidecar(client, sidecars.at(-1)!);

    expect((await client.query("SELECT id, country_code, place_type, place_id FROM tax_regions ORDER BY id")).rows).toEqual([
      { id: "txreg_bd", country_code: "BD", place_type: null, place_id: null },
      { id: "txreg_bd_city_dhaka", country_code: "BD", place_type: "city", place_id: "city_dhaka" },
    ]);
    expect((await client.query("SELECT id, tax_region_id, rate_bps, priority, is_compound, combinable FROM tax_rates ORDER BY id")).rows).toEqual([
      { id: "taxr_dhaka", tax_region_id: "txreg_bd_city_dhaka", rate_bps: 200, priority: 1, is_compound: 1, combinable: 1 },
      { id: "taxr_vat", tax_region_id: "txreg_bd", rate_bps: 1500, priority: 0, is_compound: 0, combinable: 0 },
    ]);
    expect((await client.query("SELECT id, prices_include_tax FROM markets ORDER BY id")).rows)
      .toEqual([{ id: "mkt_backup", prices_include_tax: 1 }, { id: "mkt_in", prices_include_tax: 1 }]);
    expect((await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name IN ('tax_settings', 'tax_rates') AND column_name IN ('prices_include_tax', 'jurisdiction_type', 'deleted_at')",
    )).rows).toEqual([]);
    expect((await client.query("SELECT provider_id FROM tax_settings")).rows).toEqual([{ provider_id: "system" }]);

    await expect(client.query("INSERT INTO tax_regions (id, country_code, admin_area) VALUES ('r_ca', 'US', 'CA')"))
      .rejects.toThrow(/TAX_REGION_COUNTRY_REQUIRED/);
    await client.query("INSERT INTO tax_regions (id, country_code) VALUES ('r_us', 'US')");
    await client.query("INSERT INTO tax_regions (id, country_code, admin_area) VALUES ('r_ca', 'US', 'CA')");
    await expect(client.query("INSERT INTO tax_regions (id, country_code) VALUES ('r_us2', 'US')")).rejects.toThrow(/duplicate key/);
    await expect(client.query("UPDATE tax_regions SET admin_area = 'NY' WHERE id = 'r_ca'")).rejects.toThrow(/TAX_REGION_SCOPE_IMMUTABLE/);
    await expect(client.query("DELETE FROM tax_regions WHERE id = 'r_us'")).rejects.toThrow(/TAX_REGION_HAS_SUBREGIONS/);
    await expect(client.query("UPDATE tax_settings SET provider_id = 'avalara'")).rejects.toThrow(/check constraint/);

    // The canonical schema has no seed rows: the fence and clock rows are the store's.
    await client.query("INSERT INTO checkout_authority (id, revision) VALUES ('default', 1) ON CONFLICT (id) DO NOTHING");
    await client.query("INSERT INTO cache_clock (id, seq) VALUES (1, 0) ON CONFLICT (id) DO NOTHING");
    const revision = async () => Number((await client.query("SELECT revision FROM checkout_authority WHERE id = 'default'")).rows[0].revision);
    const tax = async () => Number((await client.query("SELECT coalesce((SELECT seq FROM cache_dep WHERE dep = 'tax'), 0) AS seq")).rows[0].seq);
    for (const sql of [
      "INSERT INTO tax_rates (id, tax_class_id, tax_region_id, name, rate_bps) VALUES ('taxr_ca', 'taxc_std', 'r_ca', 'CA', 725)",
      "UPDATE tax_rates SET combinable = 1 WHERE id = 'taxr_ca'",
      "UPDATE tax_regions SET provider_id = 'acme.tax:avalara' WHERE id = 'r_us'",
    ]) {
      const [fence, key] = [await revision(), await tax()];
      await client.query(sql);
      expect(await revision(), sql).toBeGreaterThan(fence);
      expect(await tax(), sql).toBeGreaterThan(key);
    }
    const fence = await revision();
    await client.query("UPDATE markets SET prices_include_tax = 0 WHERE id = 'mkt_in'");
    expect(await revision()).toBeGreaterThan(fence);
    expect((await client.query("SELECT version FROM scalius_schema_migrations ORDER BY version DESC LIMIT 1")).rows)
      .toEqual([{ version: 116 }]);
  }, 240_000);
});
