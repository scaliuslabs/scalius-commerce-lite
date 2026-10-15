// Migration 0110 (plugin platform phase 3): the `provider` registration kind
// (plugin_registrations rebuilt with foreign keys on), compare-and-set
// revisions on app records and KV, order holds, and
// the generated cache dependency triggers of the plugin tables. It applies
// over a populated 0109 store: every installation, registration, record and
// KV entry survives, foreign keys still cascade, and every
// later write advances the keys storefront app output is cached on.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CACHE_DEP_LATER_TABLES, CACHE_DEP_LATER_TRIGGERS, generateCacheDepTriggers } from "../scripts/cache-dep-triggers";
import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";

const NAME = "0110_plugin_providers";
const BREAKPOINT = "--> statement-breakpoint";
const migration = (dir = "") => readFileSync(join(import.meta.dirname, `../migrations/${dir}${NAME}.sql`), "utf8");
const MANIFEST = JSON.stringify({ id: "acme.loyalty", name: "Loyalty", version: "1.0.0" });

describe(`${NAME} files`, () => {
  it("installs the generated cache dependency triggers of the plugin tables verbatim on every provider", () => {
    const triggers = generateCacheDepTriggers({ withRetired: true }).filter((trigger) =>
      (CACHE_DEP_LATER_TRIGGERS[trigger.name] ?? CACHE_DEP_LATER_TABLES[trigger.table]) === NAME);
    const tables = ["plugin_installations", "plugin_registrations", "plugin_records"];
    expect([...new Set(triggers.map((trigger) => trigger.table))]).toEqual(tables);
    expect(Object.entries(CACHE_DEP_LATER_TABLES).filter(([, name]) => name === NAME).map(([table]) => table)).toEqual(tables);
    const sqlite = migration();
    const postgres = migration("postgres/");
    for (const trigger of triggers) {
      expect(sqlite, trigger.name).toContain(`${trigger.sqlite};`);
      expect(postgres, trigger.name).toContain(`${trigger.postgres};`);
    }
  });

  it("keeps every statement remote-D1 safe and transaction-safe", () => {
    const sqlite = migration();
    expect(sqlite).not.toMatch(/SELECT\s+CASE\s+WHEN/i);
    expect(sqlite).not.toMatch(/^\s*PRAGMA/im);
    expect(migration("postgres/")).not.toMatch(/GLOB|PRAGMA|randomblob/i);
    for (const statement of sqlite.split(BREAKPOINT)) {
      const trigger = /CREATE TRIGGER[\s\S]*?\bBEGIN\b([\s\S]*)\bEND;\s*$/.exec(statement.trim());
      if (!trigger) continue;
      expect(trigger[1]!.split(";").filter((part) => part.trim()).length, statement.slice(0, 80)).toBe(1);
    }
  });
});

describe(`${NAME} over a populated 0109 database`, () => {
  let db: DatabaseSync;

  const dep = (key: string) => (db.prepare("SELECT seq FROM cache_dep WHERE dep = ?").get(key) as { seq: number } | undefined)?.seq ?? 0;

  beforeEach(() => {
    db = createMigratedSqlite({ beforeMigration: "0110_" });
    db.exec(`
      INSERT INTO plugin_installations (plugin_id, version, source, bundle_sha256, manifest_json, grant_json, grant_key, status, settings_json, revision)
        VALUES ('acme.loyalty', '1.0.0', 'upload', '${"a".repeat(64)}', '${MANIFEST}', '{}', '{}', 'active', '{}', 3);
      INSERT INTO plugin_registrations (kind, name, plugin_id, priority) VALUES
        ('function', 'checkout.discounts', 'acme.loyalty', 50),
        ('event', 'order.paid', 'acme.loyalty', 100),
        ('cron', 'expire', 'acme.loyalty', 100);
      INSERT INTO plugin_records (plugin_id, collection, id, data_json, idx1) VALUES
        ('acme.loyalty', 'balances', 'cust_1', '{"points":120}', '0a'),
        ('acme.loyalty', 'balances', 'cust_2', '{"points":0}', NULL);
      INSERT INTO plugin_kv (plugin_id, key, value_json) VALUES ('acme.loyalty', 'rate', '{"pointsPerTaka":1}');
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status, payment_method)
        VALUES ('ord_1', 'Rahim', '+8801711111111', 'House 1', 'city_1', 'zone_1', 'pending', 'sslcommerz');
    `);
    db.exec(compiledMigrationSql("d1", "0111_", "0110_"));
  });
  afterEach(() => db.close());

  it("keeps every registration, record and KV entry, with their constraints and indexes", () => {
    expect(db.prepare("SELECT kind, name, priority FROM plugin_registrations ORDER BY kind").all()).toEqual([
      { kind: "cron", name: "expire", priority: 100 },
      { kind: "event", name: "order.paid", priority: 100 },
      { kind: "function", name: "checkout.discounts", priority: 50 },
    ]);
    expect(db.prepare("SELECT id, data_json, idx1, revision FROM plugin_records ORDER BY id").all()).toEqual([
      { id: "cust_1", data_json: '{"points":120}', idx1: "0a", revision: 1 },
      { id: "cust_2", data_json: '{"points":0}', idx1: null, revision: 1 },
    ]);
    expect(db.prepare("SELECT key, revision FROM plugin_kv").all()).toEqual([{ key: "rate", revision: 1 }]);
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE '__new_%'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'plugin_registrations' AND sql IS NOT NULL").all())
      .toEqual([{ name: "plugin_registrations_plugin_idx" }]);

    db.exec("INSERT INTO plugin_registrations (kind, name, plugin_id) VALUES ('provider', 'payment', 'acme.loyalty')");
    expect(() => db.exec("INSERT INTO plugin_registrations (kind, name, plugin_id) VALUES ('webhook', 'x', 'acme.loyalty')")).toThrow(/CHECK/);
    expect(() => db.exec("UPDATE plugin_records SET revision = 0 WHERE id = 'cust_1'")).toThrow(/CHECK/);
    expect(() => db.exec("UPDATE plugin_kv SET revision = 0")).toThrow(/CHECK/);
    // Registrations still need their installation and still go with it.
    expect(() => db.exec("INSERT INTO plugin_registrations (kind, name, plugin_id) VALUES ('provider', 'sms', 'acme.missing')")).toThrow(/FOREIGN KEY/);
    db.exec("DELETE FROM plugin_installations WHERE plugin_id = 'acme.loyalty'");
    expect(db.prepare("SELECT count(*) AS n FROM plugin_registrations").get()).toEqual({ n: 0 });
  });

  it("holds an order once per app and drops its holds with the order", () => {
    const id = `ohd_${"0".repeat(32)}`;
    db.exec(`INSERT INTO order_holds (id, order_id, plugin_id, app_name, reason) VALUES ('${id}', 'ord_1', 'acme.loyalty', 'Loyalty', 'Unusual velocity')`);
    expect(() => db.exec(`INSERT INTO order_holds (id, order_id, plugin_id, app_name, reason) VALUES ('${id}', 'ord_1', 'acme.loyalty', 'Loyalty', 'Again')`)).toThrow(/UNIQUE|PRIMARY/);
    expect(() => db.exec("INSERT INTO order_holds (id, order_id, plugin_id, app_name, reason) VALUES ('hold_1', 'ord_1', 'acme.loyalty', 'Loyalty', 'x')")).toThrow(/CHECK/);
    expect(() => db.exec(`UPDATE order_holds SET released_at = created_at - 1 WHERE id = '${id}'`)).toThrow(/CHECK/);
    expect(db.prepare("SELECT count(*) AS n FROM order_holds WHERE order_id = 'ord_1' AND released_at IS NULL").get()).toEqual({ n: 1 });
    db.exec("DELETE FROM orders WHERE id = 'ord_1'");
    expect(db.prepare("SELECT count(*) AS n FROM order_holds").get()).toEqual({ n: 0 });
  });

  it("advances the app's cache keys with every visible write, and nothing for bookkeeping", () => {
    const status = dep("plg:acme.loyalty");
    db.exec("UPDATE plugin_installations SET status = 'disabled', revision = 4 WHERE plugin_id = 'acme.loyalty'");
    expect(dep("plg:acme.loyalty")).toBeGreaterThan(status);
    expect(dep("plg:*")).toBe(dep("plg:acme.loyalty"));

    const bookkeeping = dep("plg:acme.loyalty");
    db.exec("UPDATE plugin_installations SET revision = 5, updated_at = updated_at + 1, failure_reason = 'x' WHERE plugin_id = 'acme.loyalty'");
    expect(dep("plg:acme.loyalty")).toBe(bookkeeping);

    db.exec("INSERT INTO plugin_registrations (kind, name, plugin_id) VALUES ('provider', 'payment', 'acme.loyalty')");
    expect(dep("plg:acme.loyalty")).toBeGreaterThan(bookkeeping);

    const records = dep("plgs:acme.loyalty:balances");
    db.exec("UPDATE plugin_records SET data_json = '{\"points\":80}', revision = revision + 1 WHERE id = 'cust_1'");
    expect(dep("plgs:acme.loyalty:balances")).toBeGreaterThan(records);
    const recordsAfter = dep("plgs:acme.loyalty:balances");
    db.exec("UPDATE plugin_records SET revision = revision + 1, updated_at = updated_at + 1 WHERE id = 'cust_2'");
    expect(dep("plgs:acme.loyalty:balances")).toBe(recordsAfter);
    db.exec("DELETE FROM plugin_records WHERE id = 'cust_2'");
    expect(dep("plgs:acme.loyalty:balances")).toBeGreaterThan(recordsAfter);
    // KV is not readable while rendering: it advances nothing.
    const before = db.prepare("SELECT max(seq) AS seq FROM cache_dep").get();
    db.exec("UPDATE plugin_kv SET value_json = '{}', revision = revision + 1");
    expect(db.prepare("SELECT max(seq) AS seq FROM cache_dep").get()).toEqual(before);
  });
});
