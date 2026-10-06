// PostgreSQL sidecar for 0115_selling_countries_dependency, on the upgrade
// path a real PostgreSQL store follows (the fresh 0103 schema plus every later
// sidecar): `mk:selling`, the set of countries the active markets sell to,
// advances at commit when a country of an active market or a market's status
// changes, and stays put for a rename or a presence edit. Opt-in, like the
// other sidecars.
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
].map((name) => join(import.meta.dirname, `../migrations/postgres/${name}.sql`));

const openClients: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of openClients.splice(0)) await close();
});

async function database(schemaSql: string): Promise<Client> {
  const name = `scalius_sc_${randomUUID().replaceAll("-", "")}`;
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

describe.runIf(postgresUrl)("0115 selling countries PostgreSQL sidecar", () => {
  it("advances mk:selling only for a country of an active market or a status change", async () => {
    const before = await compileCanonicalPostgresSchema({ beforeMigration: "0104_" });
    const client = await database(before.sql);
    for (const file of sidecars) await applySidecar(client, file);
    const seq = async (key: string) => Number((await client.query("SELECT seq FROM cache_dep WHERE dep = $1", [key])).rows[0]?.seq ?? 0);

    await client.query(`
      INSERT INTO markets (id, handle, name, status) VALUES ('mkt_in', 'india', 'India', 'active'), ('mkt_pk', 'pakistan', 'Pakistan', 'draft');
      INSERT INTO market_countries (country_code, market_id) VALUES ('IN', 'mkt_in');
      INSERT INTO market_presences (id, market_id, kind, value, locale) VALUES ('mkp_in', 'mkt_in', 'subfolder', 'en-in', 'en');
    `);
    const start = await seq("mk:selling");
    expect(start).toBeGreaterThan(0);

    await client.query("UPDATE markets SET name = 'India store', handle = 'india-store' WHERE id = 'mkt_in'");
    await client.query("UPDATE market_presences SET value = 'bn-in', locale = 'bn' WHERE id = 'mkp_in'");
    await client.query("UPDATE markets SET price_increment_minor = 1 WHERE id = 'mkt_backup'");
    await client.query("INSERT INTO market_countries (country_code, market_id) VALUES ('PK', 'mkt_pk')");
    await client.query("DELETE FROM market_countries WHERE country_code = 'PK'");
    expect(await seq("mk:selling")).toBe(start);

    await client.query("INSERT INTO market_countries (country_code, market_id) VALUES ('LK', 'mkt_in')");
    const added = await seq("mk:selling");
    expect(added).toBeGreaterThan(start);
    await client.query("UPDATE market_countries SET country_code = 'NP' WHERE country_code = 'LK'");
    const moved = await seq("mk:selling");
    expect(moved).toBeGreaterThan(added);
    await client.query("DELETE FROM market_countries WHERE country_code = 'NP'");
    const removed = await seq("mk:selling");
    expect(removed).toBeGreaterThan(moved);
    await client.query("UPDATE markets SET status = 'draft' WHERE id = 'mkt_in'");
    const withdrawn = await seq("mk:selling");
    expect(withdrawn).toBeGreaterThan(removed);

    await client.query("UPDATE markets SET status = 'active' WHERE id = 'mkt_in'");
    const published = await seq("mk:selling");
    expect(published).toBeGreaterThan(withdrawn);
    await client.query("DELETE FROM market_presences WHERE market_id = 'mkt_in'");
    await client.query("DELETE FROM markets WHERE id = 'mkt_in'");
    expect(await seq("mk:selling")).toBeGreaterThan(published);
    expect((await client.query("SELECT version FROM scalius_schema_migrations ORDER BY version DESC LIMIT 1")).rows)
      .toEqual([{ version: 115 }]);
  }, 240_000);
});
