// Migration 0115 (Markets step 3b follow-up): the set of countries the active
// markets sell to has its own cache dependency, `mk:selling`, so the checkout
// config (which carries them as accepted phone countries) is not revalidated
// by a market's rename, handle or presence edit. Only a country of an active
// market (added, removed, moved) or a market's status advances it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { CACHE_DEP_LATER_TRIGGERS, cacheDepTriggersForMigration } from "../scripts/cache-dep-triggers";
import { createMigratedSqlite } from "../src/testing/sqlite-d1";

const NAME = "0115_selling_countries_dependency";
const BREAKPOINT = "--> statement-breakpoint";
const migration = (dir = "") => readFileSync(join(import.meta.dirname, `../migrations/${dir}${NAME}.sql`), "utf8");

describe(`${NAME} files`, () => {
  it("installs the generated selling-countries triggers verbatim on every provider, and nothing else", () => {
    const triggers = cacheDepTriggersForMigration(NAME);
    expect(triggers.map((trigger) => trigger.name).sort()).toEqual(
      Object.entries(CACHE_DEP_LATER_TRIGGERS).filter(([, name]) => name === NAME).map(([trigger]) => trigger).sort(),
    );
    expect(triggers).toHaveLength(5);
    const sqlite = migration();
    const postgres = migration("postgres/");
    for (const trigger of triggers) {
      expect(sqlite, trigger.name).toContain(`${trigger.sqlite};`);
      expect(postgres, trigger.name).toContain(`${trigger.postgres};`);
    }
    // The deployed 0112 stays as it was: none of these triggers is in it.
    const markets = readFileSync(join(import.meta.dirname, "../migrations/0112_markets.sql"), "utf8");
    for (const trigger of triggers) expect(markets).not.toContain(trigger.name);
  });

  it("keeps every statement remote-D1 safe and transaction-safe", () => {
    const sqlite = migration();
    expect(sqlite).not.toMatch(/^\s*PRAGMA/im);
    for (const statement of sqlite.split(BREAKPOINT)) {
      const trigger = /CREATE TRIGGER[\s\S]*?\bBEGIN\b([\s\S]*)\bEND;\s*$/.exec(statement.trim());
      if (!trigger) continue;
      expect(trigger[1], statement.slice(0, 80)).not.toMatch(/SELECT\s+CASE\s+WHEN/i);
      expect(trigger[1]!.split(";").filter((part) => part.trim()).length, statement.slice(0, 80)).toBe(1);
    }
  });
});

describe("mk:selling", () => {
  let db: DatabaseSync | null = null;
  afterEach(() => db?.close());
  const dep = (key: string) => (db!.prepare("SELECT seq FROM cache_dep WHERE dep = ?").get(key) as { seq: number } | undefined)?.seq ?? 0;

  function store(): DatabaseSync {
    db = createMigratedSqlite();
    db.exec(`
      INSERT INTO markets (id, handle, name, status) VALUES ('mkt_in', 'india', 'India', 'active'), ('mkt_pk', 'pakistan', 'Pakistan', 'draft');
      INSERT INTO market_countries (country_code, market_id) VALUES ('IN', 'mkt_in');
      INSERT INTO market_presences (id, market_id, kind, value, locale) VALUES ('mkp_in', 'mkt_in', 'subfolder', 'en-in', 'en');
    `);
    return db;
  }

  it("moves with a country of an active market and with a market's status, not with a rename or a presence edit", () => {
    const database = store();
    const start = dep("mk:selling");
    expect(start).toBeGreaterThan(0);

    // Identity and presence edits advance the market keys, never the selling set.
    database.exec("UPDATE markets SET name = 'India store', handle = 'india-store' WHERE id = 'mkt_in'");
    database.exec("UPDATE market_presences SET value = 'bn-in', locale = 'bn' WHERE id = 'mkp_in'");
    database.exec("INSERT INTO market_presences (id, market_id, kind, value, locale) VALUES ('mkp_in2', 'mkt_in', 'subfolder', 'hi-in', 'hi')");
    database.exec("UPDATE markets SET price_increment_minor = 1 WHERE id = 'mkt_backup'");
    expect(dep("mk:selling")).toBe(start);
    expect(dep("mk:mkt_in")).toBeGreaterThan(0);

    // A draft market sells nothing: its countries stay out of the set.
    database.exec("INSERT INTO market_countries (country_code, market_id) VALUES ('PK', 'mkt_pk')");
    database.exec("DELETE FROM market_countries WHERE country_code = 'PK'");
    expect(dep("mk:selling")).toBe(start);

    // A country of an active market: added, moved, removed.
    database.exec("INSERT INTO market_countries (country_code, market_id) VALUES ('LK', 'mkt_in')");
    const added = dep("mk:selling");
    expect(added).toBeGreaterThan(start);
    database.exec("UPDATE market_countries SET country_code = 'NP' WHERE country_code = 'LK'");
    const moved = dep("mk:selling");
    expect(moved).toBeGreaterThan(added);
    database.exec("DELETE FROM market_countries WHERE country_code = 'NP'");
    expect(dep("mk:selling")).toBeGreaterThan(moved);

    // A status change publishes or withdraws a market's countries.
    const removed = dep("mk:selling");
    database.exec("UPDATE markets SET status = 'draft' WHERE id = 'mkt_in'");
    const withdrawn = dep("mk:selling");
    expect(withdrawn).toBeGreaterThan(removed);
    database.exec("UPDATE markets SET status = 'active' WHERE id = 'mkt_in'");
    expect(dep("mk:selling")).toBeGreaterThan(withdrawn);
  });

  it("moves when an active market goes with its countries", () => {
    const database = store();
    database.exec("DELETE FROM market_presences WHERE market_id = 'mkt_in'");
    const before = dep("mk:selling");
    database.exec("DELETE FROM markets WHERE id = 'mkt_in'");
    expect(dep("mk:selling")).toBeGreaterThan(before);
  });
});
