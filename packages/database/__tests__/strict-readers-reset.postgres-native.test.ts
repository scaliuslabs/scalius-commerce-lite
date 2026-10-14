// PostgreSQL sidecar for 0149_strict_readers_reset on the upgrade path: it resets the rows the strict
// readers reject and leaves valid rows alone. Opt-in: point SCALIUS_TEST_POSTGRES_URL at a disposable server.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { compileCanonicalPostgresSchema } from "../scripts/postgres-schema";
import { strictReadersSeed } from "./strict-readers-reset.fixture";

const server = process.env.SCALIUS_TEST_POSTGRES_URL?.trim();
const cleanup: Array<() => Promise<void>> = [];
afterAll(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function database(sql: string) {
  const name = `scalius_reset_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: server }); await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(server!); url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.toString() });
  cleanup.push(async () => { await client.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  await client.connect(); await client.query(sql); return client;
}

describe.runIf(server)("0149 strict readers reset on native PostgreSQL", () => {
  it("resets only what the strict readers reject", async () => {
    const client = await database((await compileCanonicalPostgresSchema({ beforeMigration: "0149_" })).sql);
    await client.query(strictReadersSeed());
    const migration = readFileSync(join(import.meta.dirname, "../migrations/postgres/0149_strict_readers_reset.sql"), "utf8");
    await client.query("BEGIN");
    for (const statement of migration.split("--> statement-breakpoint")) if (statement.trim()) await client.query(statement);
    await client.query("COMMIT");
    const rows = async (sql: string) => (await client.query(sql)).rows;

    expect((await rows("SELECT revision::integer AS revision FROM theme_settings")).map((row) => row.revision)).toEqual([7]);
    expect(await rows("SELECT id FROM theme_settings_drafts")).toEqual([]);
    expect((await rows("SELECT id FROM theme_settings_versions ORDER BY id")).map((row) => row.id)).toEqual(["themev_ok"]);
    expect((await rows("SELECT id FROM theme_restore_points")).map((row) => row.id)).toEqual(["themerp_good01"]);
    expect(await rows("SELECT id, provider_type, tracking_url, courier_name FROM delivery_shipments ORDER BY id")).toEqual([
      { id: "shp_app", provider_type: "acme.parcel:parcel", tracking_url: null, courier_name: null },
      { id: "shp_pathao", provider_type: "scalius.bangladesh:pathao", tracking_url: "https://merchant.pathao.com/tracking?consignment_id=DL1001", courier_name: "Pathao" },
      { id: "shp_saved", provider_type: "scalius.bangladesh:pathao", tracking_url: "https://saved.example/DL2", courier_name: "Pathao" },
      { id: "shp_steadfast", provider_type: "scalius.bangladesh:steadfast", tracking_url: "https://steadfast.com.bd/t/SF9", courier_name: "Steadfast" },
    ]);
    expect(await rows("SELECT id, type, is_active::integer AS is_active, credentials, config FROM delivery_providers ORDER BY id")).toEqual([
      { id: "dp_app", type: "acme.parcel:parcel", is_active: 1, credentials: "{}", config: "{}" },
      { id: "dp_pathao", type: "scalius.bangladesh:pathao", is_active: 0, credentials: "{}", config: "{}" },
    ]);
    expect((await rows("SELECT payment_method FROM orders ORDER BY id")).map((row) => row.payment_method))
      .toEqual(["cod", "scalius.bangladesh:sslcommerz", "scalius.bangladesh:sslcommerz"]);
    expect((await rows("SELECT payment_method FROM order_payments")).map((row) => row.payment_method)).toEqual(["scalius.bangladesh:sslcommerz"]);
    expect((await rows("SELECT gateway FROM payment_session_attempts")).map((row) => row.gateway)).toEqual(["scalius.bangladesh:sslcommerz"]);
    expect(JSON.parse((await rows("SELECT value FROM settings WHERE category = 'payment_methods'"))[0]!.value))
      .toEqual({ enabledMethods: ["scalius.bangladesh:sslcommerz", "cod"], defaultMethod: "scalius.bangladesh:sslcommerz" });
    expect(await rows("SELECT id FROM settings WHERE category = 'sslcommerz'")).toEqual([]);
    expect(JSON.parse((await rows("SELECT value FROM settings WHERE category = 'sms'"))[0]!.value)).toEqual({ activeProvider: "" });
    expect((await rows("SELECT id FROM checkout_attempts")).map((row) => row.id)).toEqual(["ca_done"]);
    expect((await rows("SELECT id FROM abandoned_checkouts")).map((row) => row.id)).toEqual(["ab_new"]);
    expect((await rows("SELECT id FROM two_factor")).map((row) => row.id)).toEqual(["tf_sealed"]);
    expect((await rows("SELECT name FROM scalius_schema_migrations WHERE version = 149")).map((row) => row.name)).toEqual(["0149_strict_readers_reset"]);
  }, 120_000);
});
