// PostgreSQL sidecar for 0110_plugin_providers, on the upgrade path a real
// PostgreSQL store follows (the fresh 0103 schema plus every later sidecar):
// populated app rows survive the CHECK swap and the new columns, the
// `provider` registration kind is admitted, and the deferred cache dependency
// triggers advance the app keys at commit. Opt-in, like the other sidecars.
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
].map((name) => join(import.meta.dirname, `../migrations/postgres/${name}.sql`));

const openClients: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of openClients.splice(0)) await close();
});

async function database(schemaSql: string): Promise<Client> {
  const name = `scalius_pp_${randomUUID().replaceAll("-", "")}`;
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

describe.runIf(postgresUrl)("0110 plugin providers PostgreSQL sidecar", () => {
  it("keeps app rows, admits provider registrations and advances app keys at commit", async () => {
    const before = await compileCanonicalPostgresSchema({ beforeMigration: "0104_" });
    const client = await database(before.sql);
    for (const file of sidecars.slice(0, -1)) await applySidecar(client, file);
    await client.query(`
      INSERT INTO plugin_installations (plugin_id, version, source, bundle_sha256, manifest_json, grant_json, grant_key, status, settings_json)
      VALUES ('acme.loyalty', '1.0.0', 'upload', '${"a".repeat(64)}', '{}', '{}', '{}', 'active', '{}');
      INSERT INTO plugin_registrations (kind, name, plugin_id) VALUES ('function', 'checkout.discounts', 'acme.loyalty');
      INSERT INTO plugin_records (plugin_id, collection, id, data_json) VALUES ('acme.loyalty', 'balances', 'cust_1', '{"points":120}');
      INSERT INTO plugin_kv (plugin_id, key, value_json) VALUES ('acme.loyalty', 'rate', '1');
    `);
    await applySidecar(client, sidecars.at(-1)!);

    expect((await client.query("SELECT id, revision FROM plugin_records")).rows).toEqual([{ id: "cust_1", revision: 1 }]);
    expect((await client.query("SELECT key, revision FROM plugin_kv")).rows).toEqual([{ key: "rate", revision: 1 }]);
    expect((await client.query("SELECT kind, name FROM plugin_registrations")).rows).toEqual([{ kind: "function", name: "checkout.discounts" }]);

    const seq = async (key: string) =>
      Number((await client.query("SELECT seq FROM cache_dep WHERE dep = $1", [key])).rows[0]?.seq ?? 0);
    const installationBefore = await seq("plg:acme.loyalty");
    const recordsBefore = await seq("plgs:acme.loyalty:balances");
    await client.query("BEGIN");
    await client.query("INSERT INTO plugin_registrations (kind, name, plugin_id) VALUES ('provider', 'payment', 'acme.loyalty')");
    await client.query(`UPDATE plugin_records SET data_json = '{"points":80}', revision = revision + 1 WHERE id = 'cust_1'`);
    await client.query("COMMIT");
    expect(await seq("plg:acme.loyalty")).toBeGreaterThan(installationBefore);
    expect(await seq("plgs:acme.loyalty:balances")).toBeGreaterThan(recordsBefore);
    await expect(client.query("INSERT INTO plugin_registrations (kind, name, plugin_id) VALUES ('webhook', 'x', 'acme.loyalty')"))
      .rejects.toThrow(/plugin_registrations_kind_check/);
  }, 240_000);
});
