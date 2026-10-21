import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVENT_DEMAND_CREATE_SQL, eventDemandPostgresTrigger, eventDemandSqliteStatements } from "../scripts/event-demand-triggers";
import { generateEventOutboxTriggers } from "../scripts/event-outbox-triggers";
import { compileCanonicalPostgresSchema } from "../scripts/postgres-schema";
import { EVENT_SOURCE_TABLES } from "../../../apps/api/src/events/source-tables";

// Small relational fixture: the actual generated triggers, without unrelated domain constraints.
describe("transactional event demand", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE webhook_subscriptions (id TEXT PRIMARY KEY, status TEXT, topics TEXT);
      CREATE TABLE plugin_installations (plugin_id TEXT PRIMARY KEY, status TEXT, grant_json TEXT);
      CREATE TABLE plugin_registrations (plugin_id TEXT REFERENCES plugin_installations(plugin_id) ON DELETE CASCADE, kind TEXT, name TEXT);
      CREATE TABLE products (id TEXT PRIMARY KEY);
      CREATE TABLE event_outbox (id TEXT PRIMARY KEY, topic TEXT, resource_type TEXT, resource_id TEXT, data TEXT);
      ${EVENT_DEMAND_CREATE_SQL}
    `);
    for (const statement of eventDemandSqliteStatements()) db.exec(statement);
    db.exec(`${generateEventOutboxTriggers().find((trigger) => trigger.name === "evt_products_created")!.sqlite};`);
  });
  afterEach(() => db.close());
  const filters = () => db.prepare("SELECT filter FROM event_demand ORDER BY filter").all().map((row) => row.filter);
  const eventCount = () => Number(db.prepare("SELECT count(*) AS n FROM event_outbox").get()!.n);

  it.each(["*", "product.*", "product.created"])("starts emitting atomically for %s and stops on disable", (filter) => {
    db.exec("INSERT INTO products VALUES ('before')");
    expect(eventCount()).toBe(0);
    db.prepare("INSERT INTO webhook_subscriptions VALUES ('hook', 'active', ?)").run(JSON.stringify([filter]));
    expect(filters()).toEqual([filter]);
    db.exec("INSERT INTO products VALUES ('during')");
    expect(eventCount()).toBe(1);
    db.exec("UPDATE webhook_subscriptions SET status = 'disabled' WHERE id = 'hook'");
    expect(filters()).toEqual([]);
    db.exec("INSERT INTO products VALUES ('after')");
    expect(eventCount()).toBe(1);
  });

  it("keeps shared demand until the final webhook or approved app removes it", () => {
    db.exec(`INSERT INTO webhook_subscriptions VALUES ('hook', 'active', '["product.*"]');
      INSERT INTO plugin_installations VALUES ('acme.app', 'installed', NULL);
      INSERT INTO plugin_registrations VALUES ('acme.app', 'event', 'product.*');
      DELETE FROM webhook_subscriptions;`);
    // Never approved: no demand.
    expect(filters()).toEqual([]);
    db.exec(`UPDATE plugin_installations SET status = 'active', grant_json = '{}'`);
    expect(filters()).toEqual(["product.*"]);
    // A stopped, failed or update-waiting app keeps its events (held deliveries).
    for (const status of ["disabled", "failed", "installed"]) {
      db.prepare("UPDATE plugin_installations SET status = ?").run(status);
      expect(filters(), status).toEqual(["product.*"]);
    }
    db.exec("INSERT INTO products VALUES ('while_stopped')");
    expect(eventCount()).toBe(1);
    db.exec("DELETE FROM plugin_installations");
    expect(filters()).toEqual([]);
  });

  it("tracks registration feature changes, topic edits and uninstall", () => {
    db.exec(`INSERT INTO plugin_installations VALUES ('acme.app', 'active', '{}');
      INSERT INTO plugin_registrations VALUES ('acme.app', 'function', 'buyer.ui');`);
    expect(filters()).toEqual([]);
    db.exec("INSERT INTO plugin_registrations VALUES ('acme.app', 'event', 'order.*')");
    db.exec("UPDATE plugin_registrations SET name = 'product.created' WHERE kind = 'event'");
    expect(filters()).toEqual(["product.created"]);
    db.exec("DELETE FROM plugin_registrations WHERE kind = 'event'");
    expect(filters()).toEqual([]);
    db.exec("INSERT INTO plugin_registrations VALUES ('acme.app', 'event', '*')");
    db.exec("DELETE FROM plugin_installations");
    expect(filters()).toEqual([]);
  });

  it("rolls demand and events back with the transaction and ignores unrelated filters", () => {
    db.exec(`INSERT INTO webhook_subscriptions VALUES ('hook', 'active', '["order.*"]');
      INSERT INTO products VALUES ('unrelated');`);
    expect(eventCount()).toBe(0);
    db.exec(`BEGIN;
      UPDATE webhook_subscriptions SET topics = '["product.*"]';
      INSERT INTO products VALUES ('rolled_back');
      ROLLBACK;`);
    expect(filters()).toEqual(["order.*"]);
    expect(eventCount()).toBe(0);
  });

  it("keeps D1 maintenance bodies to one statement and PG demand reads inside functions", () => {
    for (const statement of eventDemandSqliteStatements().filter((sql) => sql.startsWith("CREATE TRIGGER"))) {
      const name = statement.split(" ")[2]!;
      expect(statement.slice(statement.indexOf("BEGIN") + 5, statement.lastIndexOf("END")).split(";").filter((part) => part.trim())).toHaveLength(1);
      // Compiled from the trigger as SQLite stores it (no final semicolon).
      expect(eventDemandPostgresTrigger(name, statement.replace(/;$/, ""))).toContain("LOCK TABLE event_demand IN SHARE ROW EXCLUSIVE MODE");
    }
    for (const trigger of generateEventOutboxTriggers()) {
      expect(EVENT_SOURCE_TABLES.has(trigger.table), trigger.table).toBe(true);
      expect(trigger.sqlite).toContain("EXISTS (SELECT 1 FROM event_demand WHERE filter IN");
      expect(trigger.postgres.indexOf("IF NOT EXISTS (SELECT 1 FROM event_demand")).toBeLessThan(trigger.postgres.indexOf("CREATE TRIGGER"));
    }
  });

  it("compiles every schema version's PostgreSQL demand triggers from its own SQLite form", async () => {
    const demandBlocks = (file: string) => readFileSync(join(import.meta.dirname, "../migrations/postgres", file), "utf8")
      .split("--> statement-breakpoint")
      .map((block) => block.trim())
      .filter((block) => block.startsWith('CREATE OR REPLACE FUNCTION scalius_compat."demand_'));
    const before = (await compileCanonicalPostgresSchema({ beforeMigration: "0176_" })).sql;
    const v0155 = demandBlocks("0155_v2_beta_contract.sql");
    expect(v0155).toHaveLength(14);
    for (const block of v0155) expect(before).toContain(block);
    const current = (await compileCanonicalPostgresSchema()).sql;
    const v0176 = demandBlocks("0176_event_demand_approved_apps.sql");
    expect(v0176).toHaveLength(14);
    for (const block of v0176) expect(current).toContain(block);
    expect(current).not.toContain("demand_installation_status");
  }, 120_000);
});
