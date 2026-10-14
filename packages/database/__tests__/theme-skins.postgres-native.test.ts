// PostgreSQL sidecar for 0153_theme_skins on the upgrade path: stored theme
// documents and app manifests move to skins and read under today's strict
// schemas. Opt-in: point SCALIUS_TEST_POSTGRES_URL at a disposable server.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { compileCanonicalPostgresSchema } from "../scripts/postgres-schema";
import { expectSkinsRows, themeSkinsSeed } from "./theme-skins.fixture";

const server = process.env.SCALIUS_TEST_POSTGRES_URL?.trim();
const cleanup: Array<() => Promise<void>> = [];
afterAll(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function database(sql: string) {
  const name = `scalius_skins_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: server }); await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(server!); url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.toString() });
  cleanup.push(async () => { await client.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  await client.connect(); await client.query(sql); return client;
}

describe.runIf(server)("0153 theme skins on native PostgreSQL", () => {
  it("moves theme slots and manifest slots to skins, keeping every look, and changes nothing on a second run", async () => {
    const client = await database((await compileCanonicalPostgresSchema({ beforeMigration: "0153_" })).sql);
    await client.query(themeSkinsSeed());
    const migration = readFileSync(join(import.meta.dirname, "../migrations/postgres/0153_theme_skins.sql"), "utf8");
    const statements = migration.split("--> statement-breakpoint").filter((statement) => statement.trim());
    await client.query("BEGIN");
    for (const statement of statements) await client.query(statement);
    await client.query("COMMIT");
    const rows = async (sql: string) => (await client.query(sql)).rows as Array<Record<string, string>>;
    const snapshot = async () => ({
      published: (await rows("SELECT colors AS value FROM theme_settings"))[0]!.value!,
      draft: (await rows("SELECT theme AS value FROM theme_settings_drafts"))[0]!.value!,
      versions: Object.fromEntries((await rows("SELECT id, theme FROM theme_settings_versions")).map((row) => [row.id, row.theme])),
      restore: (await rows("SELECT theme AS value FROM theme_restore_points"))[0]!.value!,
      manifests: Object.fromEntries((await rows("SELECT plugin_id, manifest_json FROM plugin_installations")).map((row) => [row.plugin_id, row.manifest_json])),
    }) as Parameters<typeof expectSkinsRows>[0];
    const first = await snapshot();
    expectSkinsRows(first);
    expect(await rows("SELECT revision::integer AS revision FROM theme_settings_drafts")).toEqual([{ revision: 10 }]);
    expect(await rows("SELECT plugin_id, revision::integer AS revision FROM plugin_installations ORDER BY plugin_id")).toEqual([
      { plugin_id: "acme.plain", revision: 2 },
      { plugin_id: "acme.theme", revision: 4 },
    ]);
    expect((await rows("SELECT name FROM scalius_schema_migrations WHERE version = 153")).map((row) => row.name)).toEqual(["0153_theme_skins"]);
    for (const statement of statements.slice(0, -1)) await client.query(statement);
    expect(await snapshot()).toEqual(first);
  }, 120_000);
});
