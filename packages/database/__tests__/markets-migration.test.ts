// Migration 0112 (Markets step 2): markets, market countries and presences,
// orders.market_id, and the one backup market created from today's store. It
// applies over a populated 0111 store: the backup market carries the currency
// document's price increment exactly as step 1 resolved it (the field leaves
// the document), every existing order is placed in it, the database refuses a
// second backup, deleting or demoting it, and a second market per country,
// and the generated cache dependency triggers advance the market keys.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { normalizeSupportedCurrencyCode } from "../../shared/src/currency";
import { resolvePriceIncrementMinor } from "../../shared/src/currency-policy";
import { CACHE_DEP_LATER_TABLES, cacheDepTriggersForMigration } from "../scripts/cache-dep-triggers";
import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";

const NAME = "0112_markets";
const BREAKPOINT = "--> statement-breakpoint";
const migration = (dir = "") => readFileSync(join(import.meta.dirname, `../migrations/${dir}${NAME}.sql`), "utf8");

describe(`${NAME} files`, () => {
  it("installs the generated cache dependency triggers of the market tables verbatim on every provider", () => {
    const triggers = cacheDepTriggersForMigration(NAME);
    const tables = ["markets", "market_countries", "market_presences"];
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
    expect(sqlite).not.toMatch(/^\s*PRAGMA/im);
    expect(migration("postgres/")).not.toMatch(/GLOB|PRAGMA|randomblob|json_remove/i);
    for (const statement of sqlite.split(BREAKPOINT)) {
      const trigger = /CREATE TRIGGER[\s\S]*?\bBEGIN\b([\s\S]*)\bEND;\s*$/.exec(statement.trim());
      if (!trigger) continue;
      expect(trigger[1], statement.slice(0, 80)).not.toMatch(/SELECT\s+CASE\s+WHEN/i);
      expect(trigger[1]!.split(";").filter((part) => part.trim()).length, statement.slice(0, 80)).toBe(1);
    }
  });
});

/** What step 1 read as the store's price increment from a currency document (`priceIncrementOf`). */
function stepOneIncrement(document: Record<string, unknown> | null): number {
  const code = normalizeSupportedCurrencyCode(document?.currencyCode);
  if (!code) return resolvePriceIncrementMinor("BDT", undefined);
  return resolvePriceIncrementMinor(code, document?.priceIncrementMinor);
}

describe(`${NAME} over a populated 0111 database`, () => {
  let db: DatabaseSync | null = null;
  afterEach(() => db?.close());

  function migrate(seed: (database: DatabaseSync) => void): DatabaseSync {
    db = createMigratedSqlite({ beforeMigration: "0112_" });
    seed(db);
    db.exec(compiledMigrationSql("d1", undefined, "0112_"));
    return db;
  }

  const dep = (key: string) => (db!.prepare("SELECT seq FROM cache_dep WHERE dep = ?").get(key) as { seq: number } | undefined)?.seq ?? 0;

  it.each([
    ["no currency document", null],
    ["BDT without a choice", { currencyCode: "BDT", currencySymbol: "৳" }],
    ["BDT in paisa", { currencyCode: "BDT", currencySymbol: "৳", priceIncrementMinor: 1 }],
    ["BDT in whole taka", { currencyCode: "BDT", currencySymbol: "৳", priceIncrementMinor: 100 }],
    ["USD without a choice", { currencyCode: "USD", currencySymbol: "$" }],
    ["USD in whole dollars", { currencyCode: "usd", currencySymbol: "$", priceIncrementMinor: 100 }],
    ["JPY with an invalid whole unit", { currencyCode: "JPY", currencySymbol: "¥", priceIncrementMinor: 100 }],
    ["KWD in whole dinars", { currencyCode: "KWD", currencySymbol: "KD", priceIncrementMinor: 1000 }],
    ["KWD with a two-decimal unit", { currencyCode: "KWD", currencySymbol: "KD", priceIncrementMinor: 100 }],
    ["an unsupported code", { currencyCode: "XYZ", currencySymbol: "?", priceIncrementMinor: 1 }],
    ["a string increment", { currencyCode: "BDT", currencySymbol: "৳", priceIncrementMinor: "1" }],
  ] as const)("carries the price increment of %s to the backup market and removes it from the document", (_label, document) => {
    const database = migrate((seeded) => {
      if (document) {
        seeded.prepare("INSERT INTO settings (id, category, key, value, type, revision) VALUES ('set_currency', 'currency', 'document', ?, 'json', 3)").run(JSON.stringify(document));
      }
    });
    expect(database.prepare("SELECT id, handle, name, status, is_backup, price_increment_minor, revision FROM markets").all()).toEqual([{
      id: "mkt_backup",
      handle: "bangladesh",
      name: "Bangladesh",
      status: "active",
      is_backup: 1,
      price_increment_minor: stepOneIncrement(document as Record<string, unknown> | null),
      revision: 1,
    }]);
    if (document) {
      const row = database.prepare("SELECT value, revision FROM settings WHERE category = 'currency'").get() as { value: string; revision: number };
      const { priceIncrementMinor: _removed, ...rest } = document as Record<string, unknown>;
      expect(JSON.parse(row.value)).toEqual(rest);
      expect(row.revision).toBe(3);
    }
  });

  it("sells to Bangladesh at the root in the store's checkout language, and places every order there", () => {
    const database = migrate((seeded) => {
      seeded.exec(`
        INSERT INTO checkout_languages (id, name, code, is_active, is_default, language_data, field_visibility)
          VALUES ('lang_en', 'English', 'en', 0, 1, '{}', '{}'), ('lang_bn', 'Bangla', 'bn-BD', 1, 0, '{}', '{}');
        INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status)
          VALUES ('ord_1', 'Rahim', '+8801711111111', 'House 1', 'city_1', 'zone_1', 'pending'),
                 ('ord_2', 'Karim', '+8801711111112', 'House 2', 'city_1', 'zone_1', 'delivered');
      `);
    });
    expect(database.prepare("SELECT country_code, market_id FROM market_countries").all()).toEqual([{ country_code: "BD", market_id: "mkt_backup" }]);
    expect(database.prepare("SELECT id, market_id, kind, value, locale FROM market_presences").all()).toEqual([
      { id: "mkp_backup_root", market_id: "mkt_backup", kind: "subfolder", value: "", locale: "bn" },
    ]);
    expect(database.prepare("SELECT id, market_id FROM orders ORDER BY id").all()).toEqual([
      { id: "ord_1", market_id: "mkt_backup" },
      { id: "ord_2", market_id: "mkt_backup" },
    ]);
    // The backfill writes only the new column: no order event fires.
    expect(database.prepare("SELECT count(*) AS n FROM event_outbox WHERE topic = 'order.updated'").get()).toEqual({ n: 0 });
  });

  it("uses English for the root presence when no checkout language is active", () => {
    const database = migrate(() => undefined);
    expect(database.prepare("SELECT locale FROM market_presences").get()).toEqual({ locale: "en" });
  });

  it("keeps exactly one backup market and one market per country", () => {
    const database = migrate(() => undefined);
    database.exec("INSERT INTO markets (id, handle, name, status) VALUES ('mkt_in', 'india', 'India', 'active')");
    expect(() => database.exec("INSERT INTO markets (id, handle, name, status, is_backup, price_increment_minor) VALUES ('mkt_x', 'other', 'Other', 'active', 1, 100)")).toThrow(/UNIQUE/);
    expect(() => database.exec("DELETE FROM markets WHERE id = 'mkt_backup'")).toThrow(/MARKET_BACKUP_REQUIRED/);
    expect(() => database.exec("UPDATE markets SET is_backup = 0, price_increment_minor = NULL WHERE id = 'mkt_backup'")).toThrow(/MARKET_BACKUP_REQUIRED/);
    expect(() => database.exec("UPDATE markets SET is_backup = 1, price_increment_minor = 100 WHERE id = 'mkt_in'")).toThrow(/MARKET_BACKUP_REQUIRED|UNIQUE/);
    expect(() => database.exec("UPDATE markets SET status = 'draft' WHERE id = 'mkt_backup'")).toThrow(/CHECK/);
    // Only the backup market has an increment; the others use it.
    expect(() => database.exec("UPDATE markets SET price_increment_minor = 1 WHERE id = 'mkt_in'")).toThrow(/CHECK/);
    expect(() => database.exec("UPDATE markets SET price_increment_minor = NULL WHERE id = 'mkt_backup'")).toThrow(/CHECK/);
    expect(() => database.exec("UPDATE markets SET price_increment_minor = 50 WHERE id = 'mkt_backup'")).toThrow(/CHECK/);
    expect(() => database.exec("INSERT INTO markets (id, handle, name) VALUES ('mkt_y', 'India', 'Upper')")).toThrow(/CHECK/);
    expect(() => database.exec("INSERT INTO markets (id, handle, name) VALUES ('mkt_y', 'india', 'Again')")).toThrow(/UNIQUE/);

    database.exec("INSERT INTO market_countries (country_code, market_id) VALUES ('IN', 'mkt_in')");
    expect(() => database.exec("INSERT INTO market_countries (country_code, market_id) VALUES ('BD', 'mkt_in')")).toThrow(/UNIQUE|PRIMARY/);
    expect(() => database.exec("INSERT INTO market_countries (country_code, market_id) VALUES ('in', 'mkt_in')")).toThrow(/CHECK/);
    expect(() => database.exec("INSERT INTO market_countries (country_code, market_id) VALUES ('NP', 'mkt_missing')")).toThrow(/FOREIGN KEY/);
  });

  it("gives the root URL only to the backup market and checks every subfolder's shape", () => {
    const database = migrate(() => undefined);
    database.exec("INSERT INTO markets (id, handle, name, status) VALUES ('mkt_in', 'india', 'India', 'active')");
    expect(() => database.exec("INSERT INTO market_presences (id, market_id, kind, value, locale) VALUES ('mkp_x', 'mkt_in', 'subfolder', '', 'en')")).toThrow(/MARKET_ROOT_PRESENCE_BACKUP_ONLY|UNIQUE/);
    database.exec("INSERT INTO market_presences (id, market_id, kind, value, locale) VALUES ('mkp_in', 'mkt_in', 'subfolder', 'en-in', 'en')");
    expect(() => database.exec("UPDATE market_presences SET value = '', locale = 'en' WHERE id = 'mkp_in'")).toThrow(/MARKET_ROOT_PRESENCE_BACKUP_ONLY|UNIQUE/);
    expect(() => database.exec("INSERT INTO market_presences (id, market_id, kind, value, locale) VALUES ('mkp_y', 'mkt_in', 'subfolder', 'en-in', 'en')")).toThrow(/UNIQUE/);
    for (const [value, locale] of [["hi-in", "en"], ["en_in", "en"], ["EN-IN", "en"], ["eng-in", "en"], ["in", "en"], ["hi-in", "HI"]]) {
      expect(() => database.prepare("INSERT INTO market_presences (id, market_id, kind, value, locale) VALUES ('mkp_z', 'mkt_in', 'subfolder', ?, ?)").run(value, locale), `${value} ${locale}`).toThrow(/CHECK/);
    }
    database.exec("INSERT INTO market_presences (id, market_id, kind, value, locale) VALUES ('mkp_hi', 'mkt_in', 'subfolder', 'hi-in', 'hi')");
    // Deleting a market takes its countries and presences with it.
    database.exec("INSERT INTO market_countries (country_code, market_id) VALUES ('IN', 'mkt_in')");
    database.exec("DELETE FROM markets WHERE id = 'mkt_in'");
    expect(database.prepare("SELECT count(*) AS n FROM market_presences WHERE market_id = 'mkt_in'").get()).toEqual({ n: 0 });
    expect(database.prepare("SELECT count(*) AS n FROM market_countries WHERE market_id = 'mkt_in'").get()).toEqual({ n: 0 });
  });

  it("fences a priced checkout when the backup's increment, a market's status or a country's market changes", () => {
    const database = migrate(() => undefined);
    const revision = () => (database.prepare("SELECT revision FROM checkout_authority WHERE id = 'default'").get() as { revision: number }).revision;
    let last = revision();
    const advances = (sql: string) => {
      database.exec(sql);
      const next = revision();
      const moved = next > last;
      last = next;
      return moved;
    };
    expect(advances("INSERT INTO markets (id, handle, name) VALUES ('mkt_in', 'india', 'India')")).toBe(false);
    expect(advances("UPDATE markets SET name = 'India store', revision = 2 WHERE id = 'mkt_in'")).toBe(false);
    expect(advances("UPDATE markets SET status = 'active' WHERE id = 'mkt_in'")).toBe(true);
    expect(advances("INSERT INTO market_countries (country_code, market_id) VALUES ('IN', 'mkt_in')")).toBe(true);
    expect(advances("UPDATE market_countries SET market_id = 'mkt_backup' WHERE country_code = 'IN'")).toBe(true);
    expect(advances("DELETE FROM market_countries WHERE country_code = 'IN'")).toBe(true);
    expect(advances("INSERT INTO market_presences (id, market_id, kind, value, locale) VALUES ('mkp_in', 'mkt_in', 'subfolder', 'en-in', 'en')")).toBe(false);
    expect(advances("UPDATE markets SET price_increment_minor = 1 WHERE id = 'mkt_backup'")).toBe(true);
  });

  it("keeps a market with orders", () => {
    const database = migrate(() => undefined);
    database.exec(`
      INSERT INTO markets (id, handle, name, status) VALUES ('mkt_in', 'india', 'India', 'active');
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status, market_id)
        VALUES ('ord_in', 'Asha', '+8801711111113', 'House 3', 'city_1', 'zone_1', 'pending', 'mkt_in');
    `);
    expect(() => database.exec("DELETE FROM markets WHERE id = 'mkt_in'")).toThrow(/FOREIGN KEY/);
    expect(() => database.exec("UPDATE orders SET market_id = 'mkt_missing' WHERE id = 'ord_in'")).toThrow(/FOREIGN KEY/);
  });

  it("advances one market's keys and the backup's pricing key only for its increment", () => {
    const database = migrate(() => undefined);
    database.exec("INSERT INTO markets (id, handle, name, status) VALUES ('mkt_in', 'india', 'India', 'draft')");
    const before = { market: dep("mk:mkt_in"), any: dep("mk:*"), backup: dep("mk:backup"), store: dep("mk:mkt_backup") };
    expect(before.market).toBeGreaterThan(0);
    expect(before.any).toBe(before.market);

    database.exec("UPDATE markets SET revision = revision + 1, updated_at = updated_at + 1 WHERE id = 'mkt_in'");
    expect(dep("mk:mkt_in")).toBe(before.market);

    database.exec("UPDATE markets SET status = 'active' WHERE id = 'mkt_in'");
    expect(dep("mk:mkt_in")).toBeGreaterThan(before.market);
    expect(dep("mk:backup")).toBe(before.backup);

    const countryMove = dep("mk:mkt_in");
    database.exec("INSERT INTO market_countries (country_code, market_id) VALUES ('IN', 'mkt_backup')");
    expect(dep("mk:mkt_backup")).toBeGreaterThan(before.store);
    const left = dep("mk:mkt_backup");
    database.exec("UPDATE market_countries SET market_id = 'mkt_in' WHERE country_code = 'IN'");
    // The market it joined and, through the old-image companion, the one it left.
    expect(dep("mk:mkt_in")).toBeGreaterThan(countryMove);
    expect(dep("mk:mkt_backup")).toBeGreaterThan(left);
    expect(dep("mk:backup")).toBe(before.backup);

    database.exec("INSERT INTO market_presences (id, market_id, kind, value, locale) VALUES ('mkp_in', 'mkt_in', 'subfolder', 'en-in', 'en')");
    expect(dep("mk:*")).toBe(dep("mk:mkt_in"));
    expect(dep("mk:backup")).toBe(before.backup);

    database.exec("UPDATE markets SET name = 'Bangladesh store' WHERE id = 'mkt_backup'");
    expect(dep("mk:backup")).toBe(before.backup);
    const renamed = dep("mk:mkt_backup");
    database.exec("UPDATE markets SET price_increment_minor = 1 WHERE id = 'mkt_backup'");
    expect(dep("mk:backup")).toBeGreaterThan(before.backup);
    expect(dep("mk:mkt_backup")).toBeGreaterThan(renamed);
  });
});
