// PostgreSQL sidecar for 0112_markets, on the upgrade path a real PostgreSQL
// store follows (the fresh 0103 schema plus every later sidecar): the backup
// market carries the currency document's price increment (which leaves the
// document), existing orders are placed in it, the guards refuse deleting
// it, and the market keys advance at commit. Opt-in, like the other sidecars.
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
].map((name) => join(import.meta.dirname, `../migrations/postgres/${name}.sql`));

const openClients: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of openClients.splice(0)) await close();
});

async function database(schemaSql: string): Promise<Client> {
  const name = `scalius_mk_${randomUUID().replaceAll("-", "")}`;
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

describe.runIf(postgresUrl)("0112 markets PostgreSQL sidecar", () => {
  it("creates the backup market from today's store and keeps it", async () => {
    const before = await compileCanonicalPostgresSchema({ beforeMigration: "0104_" });
    const client = await database(before.sql);
    for (const file of sidecars.slice(0, -1)) await applySidecar(client, file);
    await client.query(`
      INSERT INTO settings (id, key, value, type, category, revision)
      VALUES ('set_currency', 'document', '{"currencyCode":"BDT","currencySymbol":"৳","priceIncrementMinor":1}', 'json', 'currency', 2);
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status)
      VALUES ('ord_1', 'Rahim', '+8801711111111', 'House 1', 'city_1', 'zone_1', 'pending');
    `);
    const events = Number((await client.query("SELECT count(*) AS n FROM event_outbox")).rows[0].n);
    await applySidecar(client, sidecars.at(-1)!);

    expect((await client.query("SELECT id, handle, status, is_backup, price_increment_minor FROM markets")).rows).toEqual([
      { id: "mkt_backup", handle: "bangladesh", status: "active", is_backup: 1, price_increment_minor: 1 },
    ]);
    expect((await client.query("SELECT country_code, market_id FROM market_countries")).rows)
      .toEqual([{ country_code: "BD", market_id: "mkt_backup" }]);
    expect((await client.query("SELECT value, locale FROM market_presences")).rows).toEqual([{ value: "", locale: "en" }]);
    const document = (await client.query("SELECT value FROM settings WHERE category = 'currency'")).rows[0].value as string;
    expect(JSON.parse(document)).toEqual({ currencyCode: "BDT", currencySymbol: "৳" });
    expect((await client.query("SELECT market_id FROM orders")).rows).toEqual([{ market_id: "mkt_backup" }]);
    expect(Number((await client.query("SELECT count(*) AS n FROM event_outbox")).rows[0].n)).toBe(events);

    await expect(client.query("DELETE FROM markets WHERE id = 'mkt_backup'")).rejects.toThrow(/MARKET_BACKUP_REQUIRED/);
    await client.query("INSERT INTO markets (id, handle, name, status) VALUES ('mkt_in', 'india', 'India', 'active')");
    await expect(client.query("INSERT INTO market_presences (id, market_id, kind, value, locale) VALUES ('mkp_x', 'mkt_in', 'subfolder', '', 'en')"))
      .rejects.toThrow(/MARKET_ROOT_PRESENCE_BACKUP_ONLY|unique/i);
    await client.query("INSERT INTO market_presences (id, market_id, kind, value, locale) VALUES ('mkp_in', 'mkt_in', 'subfolder', 'en-in', 'en')");
    const seq = async (key: string) => Number((await client.query("SELECT seq FROM cache_dep WHERE dep = $1", [key])).rows[0]?.seq ?? 0);
    expect(await seq("mk:mkt_in")).toBeGreaterThan(0);
    const backup = await seq("mk:backup");
    await client.query("UPDATE markets SET price_increment_minor = 100 WHERE id = 'mkt_backup'");
    expect(await seq("mk:backup")).toBeGreaterThan(backup);
    expect((await client.query("SELECT version FROM scalius_schema_migrations ORDER BY version DESC LIMIT 1")).rows)
      .toEqual([{ version: 112 }]);
  }, 240_000);
});
