import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { compileCanonicalPostgresSchema } from "../scripts/postgres-schema";
import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";

const migration = "0155_v2_beta_contract";
const seed = `
  INSERT INTO theme_settings (id, colors) VALUES ('default', '{"version":9}');
  INSERT INTO theme_settings_drafts (id, theme, base_published_revision) VALUES ('default', '{"version":9}', 1);
  INSERT INTO webhook_subscriptions (id, url, topics, api_version, secret_ciphertext, secret_hint)
    VALUES ('whk_beta', 'https://example.test/events', '["object.*"]', '2026-08-01', 'enc:fixture', 'test');
  INSERT INTO permissions (id, name, display_name, resource, action, category)
    VALUES ('perm_meta_view', 'metaobjects.view', 'View metaobjects', 'metaobjects', 'view', 'content');
`;

describe.each(["d1", "turso"] as const)(`${migration} on %s`, (provider) => {
  it("upgrades the contract atomically and resets obsolete theme documents", () => {
    const db = createMigratedSqlite({ provider, beforeMigration: "0155_" });
    try {
      db.exec(seed);
      db.exec(`BEGIN; ${compiledMigrationSql(provider, "0156_", "0155_")} COMMIT;`);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("SELECT filter FROM event_demand").all()).toEqual([{ filter: "object.*" }]);
      expect(db.prepare("SELECT * FROM theme_settings").all()).toEqual([]);
      expect(db.prepare("SELECT * FROM theme_settings_drafts").all()).toEqual([]);
      expect(db.prepare("SELECT id, name, resource FROM permissions WHERE id = 'perm_meta_view'").get())
        .toEqual({ id: "perm_meta_view", name: "objects.view", resource: "objects" });
      for (const name of ["plugin_records", "metaobject_entries", "metaobject_definitions"]) {
        expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").all(name)).toEqual([]);
      }
      db.exec(`INSERT INTO object_types (id, namespace, type, name, fields_json, storefront, events)
        VALUES ('oty_custom.faq', 'custom', 'faq', 'FAQ', '[]', 1, 1);
        INSERT INTO object_records (type_id, id, data_json, status, pub, ev)
        VALUES ('oty_custom.faq', 'faq_1', '{}', 'published', 1, 1);`);
      expect(db.prepare("SELECT topic FROM event_outbox WHERE resource_id = 'faq_1'").all())
        .toEqual([{ topic: "object.created" }]);
      expect(db.prepare("SELECT dep FROM cache_dep WHERE dep = 'obj:oty_custom.faq'").all())
        .toEqual([{ dep: "obj:oty_custom.faq" }]);
      expect(db.prepare("SELECT version, name FROM scalius_schema_migrations ORDER BY version DESC LIMIT 1").get())
        .toEqual({ version: 155, name: migration });
    } finally { db.close(); }
  });
});

const server = process.env.SCALIUS_TEST_POSTGRES_URL?.trim();
const cleanup: Array<() => Promise<void>> = [];
afterAll(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function postgresDatabase(source: string) {
  const name = `scalius_beta_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: server });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(server!); url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.toString() });
  cleanup.push(async () => { await client.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  await client.connect();
  await client.query(source);
  return client;
}

describe.runIf(server)(`${migration} on native PostgreSQL`, () => {
  it("applies the sidecar and matches a fresh compiled schema", async () => {
    const upgraded = await postgresDatabase((await compileCanonicalPostgresSchema({ beforeMigration: "0155_" })).sql);
    await upgraded.query(seed);
    await upgraded.query("BEGIN");
    const source = readFileSync(new URL(`../migrations/postgres/${migration}.sql`, import.meta.url), "utf8");
    for (const statement of source.split("--> statement-breakpoint")) if (statement.trim()) await upgraded.query(statement);
    await upgraded.query("COMMIT");
    expect((await upgraded.query("SELECT filter FROM event_demand")).rows).toEqual([{ filter: "object.*" }]);
    expect((await upgraded.query("SELECT * FROM theme_settings")).rows).toEqual([]);
    await upgraded.query("DELETE FROM webhook_subscriptions");
    expect((await upgraded.query("SELECT * FROM event_demand")).rows).toEqual([]);
    const product = (id: string) => upgraded.query("INSERT INTO products (id, name, slug) VALUES ($1, 'Fixture', $1)", [id]);
    await product("no_subscriber");
    expect((await upgraded.query("SELECT topic FROM event_outbox")).rows).toEqual([]);
    await upgraded.query(`INSERT INTO webhook_subscriptions (id, url, topics, api_version, secret_ciphertext, secret_hint)
      VALUES ('whk_product', 'https://example.test/events', '["product.created"]', '2026-08-01', 'enc:fixture', 'test')`);
    await product("with_subscriber");
    expect((await upgraded.query("SELECT topic FROM event_outbox")).rows).toEqual([{ topic: "product.created" }]);
    await upgraded.query(`UPDATE webhook_subscriptions SET topics = '["order.*"]' WHERE id = 'whk_product'`);
    expect((await upgraded.query("SELECT filter FROM event_demand")).rows).toEqual([{ filter: "order.*" }]);
    await upgraded.query("DELETE FROM webhook_subscriptions");
    await product("subscriber_removed");
    expect((await upgraded.query("SELECT topic FROM event_outbox")).rows).toEqual([{ topic: "product.created" }]);
    const fresh = await postgresDatabase((await compileCanonicalPostgresSchema({ beforeMigration: "0156_" })).sql);
    for (const query of [
      "SELECT table_name,column_name,data_type,is_nullable,column_default,collation_name FROM information_schema.columns WHERE table_schema='public' ORDER BY 1,2",
      "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY 1,2",
      "SELECT tgrelid::regclass::text AS table_name,tgname,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1,2",
    ]) expect((await upgraded.query(query)).rows).toEqual((await fresh.query(query)).rows);
  }, 120_000);
});
