import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVENT_DEMAND_CREATE_SQL, eventDemandPostgresTrigger, eventDemandSqliteStatements } from "../scripts/event-demand-triggers";
import { generateEventOutboxTriggers } from "../scripts/event-outbox-triggers";
import { EVENT_SOURCE_TABLES } from "../../../apps/api/src/events/source-tables";

// Small relational fixture: the actual generated triggers, without unrelated domain constraints.
describe("transactional event demand", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE webhook_subscriptions (id TEXT PRIMARY KEY, status TEXT, topics TEXT);
      CREATE TABLE plugin_installations (plugin_id TEXT PRIMARY KEY, status TEXT);
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

  it("keeps shared demand until the final webhook or active app removes it", () => {
    db.exec(`INSERT INTO webhook_subscriptions VALUES ('hook', 'active', '["product.*"]');
      INSERT INTO plugin_installations VALUES ('acme.app', 'disabled');
      INSERT INTO plugin_registrations VALUES ('acme.app', 'event', 'product.*');
      DELETE FROM webhook_subscriptions;`);
    expect(filters()).toEqual([]);
    db.exec("UPDATE plugin_installations SET status = 'active'");
    expect(filters()).toEqual(["product.*"]);
    db.exec(`INSERT INTO webhook_subscriptions VALUES ('other', 'active', '["product.*"]');
      UPDATE plugin_installations SET status = 'failed';`);
    expect(filters()).toEqual(["product.*"]);
    db.exec("DELETE FROM webhook_subscriptions");
    expect(filters()).toEqual([]);
  });

  it("tracks registration feature changes, topic edits and uninstall", () => {
    db.exec(`INSERT INTO plugin_installations VALUES ('acme.app', 'active');
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
      expect(eventDemandPostgresTrigger(name)).toContain("LOCK TABLE event_demand IN SHARE ROW EXCLUSIVE MODE");
    }
    for (const trigger of generateEventOutboxTriggers()) {
      expect(EVENT_SOURCE_TABLES.has(trigger.table), trigger.table).toBe(true);
      expect(trigger.sqlite).toContain("EXISTS (SELECT 1 FROM event_demand WHERE filter IN");
      expect(trigger.postgres.indexOf("IF NOT EXISTS (SELECT 1 FROM event_demand")).toBeLessThan(trigger.postgres.indexOf("CREATE TRIGGER"));
    }
  });
});
