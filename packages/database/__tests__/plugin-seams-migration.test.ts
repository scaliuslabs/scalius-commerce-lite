// Migration 0126 (the plugin seams): metaobject definitions and entries,
// Web Push subscriptions, buyer identities and the market FX rate source.
// It applies over a populated 0125 store without changing a price (every
// market's rate source is `manual`); the database refuses malformed rows;
// and the generated cache dependency triggers advance `mo:<definition id>`
// for any definition or entry change, and nothing for subscriptions.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { CACHE_DEP_LATER_TABLES, CACHE_DEP_LATER_TRIGGERS, generateCacheDepTriggers } from "../scripts/cache-dep-triggers";
import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";

const NAME = "0126_plugin_seams";
const BREAKPOINT = "--> statement-breakpoint";
const migration = (dir = "") => readFileSync(join(import.meta.dirname, `../migrations/${dir}${NAME}.sql`), "utf8");

describe(`${NAME} files`, () => {
  it("installs the generated cache dependency triggers verbatim on every provider", () => {
    const triggers = generateCacheDepTriggers({ withRetired: true }).filter((trigger) =>
      (CACHE_DEP_LATER_TRIGGERS[trigger.name] ?? CACHE_DEP_LATER_TABLES[trigger.table]) === NAME);
    expect(Object.entries(CACHE_DEP_LATER_TABLES).filter(([, name]) => name === NAME).map(([table]) => table))
      .toEqual(["metaobject_definitions", "metaobject_entries"]);
    expect(Object.entries(CACHE_DEP_LATER_TRIGGERS).filter(([, name]) => name === NAME)).toEqual([]);
    expect(triggers.map((trigger) => trigger.name)).toHaveLength(8);
    const sqlite = migration();
    const postgres = migration("postgres/");
    for (const trigger of triggers) {
      expect(sqlite, trigger.name).toContain(`${trigger.sqlite};`);
      expect(postgres, trigger.name).toContain(`${trigger.postgres};`);
    }
  });

  it("keeps every statement remote-D1 safe and transaction-safe, and rebuilds no table", () => {
    const sqlite = migration();
    expect(sqlite).not.toMatch(/^\s*PRAGMA/im);
    expect(sqlite).not.toMatch(/__new_/);
    expect(migration("postgres/")).not.toMatch(/GLOB|PRAGMA|randomblob|json_remove|instr\(/i);
    for (const statement of sqlite.split(BREAKPOINT)) {
      const trigger = /CREATE TRIGGER[\s\S]*?\bBEGIN\b([\s\S]*)\bEND;\s*$/.exec(statement.trim());
      if (!trigger) continue;
      expect(trigger[1], statement.slice(0, 80)).not.toMatch(/SELECT\s+CASE\s+WHEN/i);
      expect(trigger[1]!.split(";").filter((part) => part.trim()).length, statement.slice(0, 80)).toBe(1);
    }
  });
});

describe(`${NAME} over a populated 0125 database`, () => {
  let db: DatabaseSync | null = null;
  afterEach(() => db?.close());

  function migrate(seed: (database: DatabaseSync) => void = () => undefined): DatabaseSync {
    db = createMigratedSqlite({ beforeMigration: "0126_" });
    seed(db);
    db.exec(compiledMigrationSql("d1", "0127_", "0126_"));
    return db;
  }

  const dep = (key: string) => (db!.prepare("SELECT seq FROM cache_dep WHERE dep = ?").get(key) as { seq: number } | undefined)?.seq ?? 0;
  const refuses = (sql: string) => expect(() => db!.exec(sql), sql.slice(0, 60)).toThrow();

  it("keeps every market's rate manual, so every price stays today's", () => {
    const database = migrate((seeded) => {
      seeded.exec("INSERT INTO markets (id, handle, name, status) VALUES ('mkt_in', 'india', 'India', 'active')");
    });
    expect(database.prepare("SELECT id, fx_rate_source FROM markets ORDER BY id").all()).toEqual([
      { id: "mkt_backup", fx_rate_source: "manual" },
      { id: "mkt_in", fx_rate_source: "manual" },
    ]);
    // The source names who writes the rate; it advances no cache dependency.
    const before = dep("pl:mkt_in");
    database.exec("UPDATE markets SET fx_rate_source = 'acme.rates:ecb' WHERE id = 'mkt_in'");
    expect(dep("pl:mkt_in")).toBe(before);
  });

  it("advances mo:<definition> for definition and entry changes, and refuses malformed rows", () => {
    migrate();
    db!.exec(`INSERT INTO metaobject_definitions (id, namespace, type, name, fields, storefront_access)
      VALUES ('mod_faq00001', 'custom', 'faq', 'FAQ', '[{"key":"question","name":"Question","type":"single_line_text","required":true}]', 1)`);
    const afterDefinition = dep("mo:mod_faq00001");
    expect(afterDefinition).toBeGreaterThan(0);
    expect(dep("mo:*")).toBeGreaterThan(0);
    db!.exec(`INSERT INTO metaobject_entries (id, definition_id, handle, status, fields)
      VALUES ('moe_ship0001', 'mod_faq00001', 'shipping', 'published', '{"question":"How long?"}')`);
    expect(dep("mo:mod_faq00001")).toBeGreaterThan(afterDefinition);
    const afterEntry = dep("mo:mod_faq00001");
    // Bookkeeping columns are noise.
    db!.exec("UPDATE metaobject_entries SET revision = revision + 1 WHERE id = 'moe_ship0001'");
    expect(dep("mo:mod_faq00001")).toBe(afterEntry);
    db!.exec("UPDATE metaobject_entries SET status = 'draft' WHERE id = 'moe_ship0001'");
    expect(dep("mo:mod_faq00001")).toBeGreaterThan(afterEntry);
    // Deleting a definition deletes its entries.
    db!.exec("DELETE FROM metaobject_definitions WHERE id = 'mod_faq00001'");
    expect(db!.prepare("SELECT count(*) AS n FROM metaobject_entries").get()).toEqual({ n: 0 });

    refuses("INSERT INTO metaobject_definitions (id, namespace, type, name) VALUES ('bad_000001', 'custom', 'faq', 'FAQ')");
    refuses("INSERT INTO metaobject_definitions (id, namespace, type, name) VALUES ('mod_x000001', 'Not A Namespace', 'faq', 'FAQ')");
    refuses("INSERT INTO metaobject_definitions (id, namespace, type, name) VALUES ('mod_x000002', 'custom', 'Bad-Type', 'FAQ')");
    refuses("INSERT INTO metaobject_definitions (id, namespace, type, name, fields) VALUES ('mod_x000003', 'custom', 'faq', 'FAQ', '{}')");
    db!.exec("INSERT INTO metaobject_definitions (id, namespace, type, name) VALUES ('mod_x000004', 'acme.loyalty', 'tiers', 'Tiers')");
    refuses("INSERT INTO metaobject_definitions (id, namespace, type, name) VALUES ('mod_x000005', 'acme.loyalty', 'tiers', 'Again')");
    refuses("INSERT INTO metaobject_entries (id, definition_id, handle) VALUES ('moe_x000001', 'mod_x000004', 'Bad Handle')");
    refuses("INSERT INTO metaobject_entries (id, definition_id, handle, status) VALUES ('moe_x000002', 'mod_x000004', 'gold', 'live')");
  });

  it("keeps push subscriptions private and owned by exactly one staff member or customer", () => {
    migrate((seeded) => {
      seeded.exec(`
        INSERT INTO user (id, name, email, email_verified) VALUES ('usr_1', 'Staff', 'staff@shop.test', 1);
        INSERT INTO customers (id, name, phone) VALUES ('cus_1', 'Buyer', '+8801711000001');
      `);
    });
    const key = "B".repeat(87);
    const auth = "a".repeat(22);
    const clock = db!.prepare("SELECT seq FROM cache_clock WHERE id = 1").get();
    db!.exec(`INSERT INTO push_subscriptions (id, audience, user_id, endpoint, p256dh, auth)
      VALUES ('psb_staff0001', 'staff', 'usr_1', 'https://fcm.googleapis.com/fcm/send/abc', '${key}', '${auth}')`);
    db!.exec(`INSERT INTO push_subscriptions (id, audience, customer_id, endpoint, p256dh, auth)
      VALUES ('psb_buyer0001', 'customer', 'cus_1', 'https://updates.push.services.mozilla.com/wpush/v2/x', '${key}', '${auth}')`);
    expect(db!.prepare("SELECT seq FROM cache_clock WHERE id = 1").get()).toEqual(clock);
    refuses(`INSERT INTO push_subscriptions (id, audience, user_id, customer_id, endpoint, p256dh, auth)
      VALUES ('psb_both00001', 'staff', 'usr_1', 'cus_1', 'https://fcm.googleapis.com/fcm/send/def', '${key}', '${auth}')`);
    refuses(`INSERT INTO push_subscriptions (id, audience, user_id, endpoint, p256dh, auth)
      VALUES ('psb_http00001', 'staff', 'usr_1', 'http://fcm.googleapis.com/x', '${key}', '${auth}')`);
    refuses(`INSERT INTO push_subscriptions (id, audience, user_id, endpoint, p256dh, auth)
      VALUES ('psb_dupe00001', 'staff', 'usr_1', 'https://fcm.googleapis.com/fcm/send/abc', '${key}', '${auth}')`);
    // Deleting the customer deletes their subscriptions.
    db!.exec("DELETE FROM customers WHERE id = 'cus_1'");
    expect(db!.prepare("SELECT id FROM push_subscriptions").all()).toEqual([{ id: "psb_staff0001" }]);
  });

  it("links a buyer identity to one customer per provider subject", () => {
    migrate((seeded) => seeded.exec("INSERT INTO customers (id, name, phone) VALUES ('cus_1', 'Buyer', '+8801711000001')"));
    db!.exec("INSERT INTO customer_identities (provider_id, subject, customer_id) VALUES ('acme.sso:google', 'g-123', 'cus_1')");
    refuses("INSERT INTO customer_identities (provider_id, subject, customer_id) VALUES ('acme.sso:google', 'g-123', 'cus_1')");
    refuses("INSERT INTO customer_identities (provider_id, subject, customer_id) VALUES ('nocolon', 'g-124', 'cus_1')");
  });
});
