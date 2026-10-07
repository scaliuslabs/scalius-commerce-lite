// Migration 0123 (Markets step 6): a market's own currency. It applies over a
// populated store without changing a row a buyer or a report reads: every
// market keeps the shop currency, a manual rate keeps the time it was set, the
// database keeps the backup market in the shop currency and a market in its
// own currency in `fx` mode, a currency or lock change fences checkout and
// advances the market's cache keys, and customer spend is kept in the shop
// currency.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { cacheDepTriggersForMigration } from "../scripts/cache-dep-triggers";
import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";

const NAME = "0123_market_currencies";
const BREAKPOINT = "--> statement-breakpoint";
const migration = (dir = "") => readFileSync(join(import.meta.dirname, `../migrations/${dir}${NAME}.sql`), "utf8");

describe(`${NAME} files`, () => {
  it("re-installs the market's generated cache trigger verbatim on every provider", () => {
    const triggers = cacheDepTriggersForMigration(NAME);
    expect(triggers.map((trigger) => trigger.name)).toEqual(["cdep_markets_upd"]);
    for (const trigger of triggers) {
      expect(migration(), trigger.name).toContain(`${trigger.sqlite};`);
      expect(migration("postgres/"), trigger.name).toContain(`${trigger.postgres};`);
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

describe(`${NAME} over a populated store`, () => {
  let db: DatabaseSync | null = null;
  afterEach(() => db?.close());

  function migrate(seed: (database: DatabaseSync) => void): DatabaseSync {
    db = createMigratedSqlite({ beforeMigration: "0123_" });
    seed(db);
    db.exec(compiledMigrationSql("d1", undefined, "0123_"));
    return db;
  }

  const dep = (key: string) => (db!.prepare("SELECT seq FROM cache_dep WHERE dep = ?").get(key) as { seq: number } | undefined)?.seq ?? 0;
  const fence = () => (db!.prepare("SELECT revision FROM checkout_authority WHERE id = 'default'").get() as { revision: number } | undefined)?.revision ?? 0;

  it("keeps every market in the shop currency, and dates a saved rate", () => {
    const database = migrate((seeded) => seeded.exec(`
      INSERT INTO markets (id, handle, name, status, price_mode, fx_rate, updated_at) VALUES
        ('mkt_in', 'india', 'India', 'active', 'fx', '1', 1790000000),
        ('mkt_np', 'nepal', 'Nepal', 'draft', 'fixed', NULL, 1790000001);
    `));
    expect(database.prepare("SELECT id, currency_code, fx_rate_as_of, fx_lock_minutes FROM markets ORDER BY id").all()).toEqual([
      { id: "mkt_backup", currency_code: null, fx_rate_as_of: null, fx_lock_minutes: 30 },
      { id: "mkt_in", currency_code: null, fx_rate_as_of: 1_790_000_000, fx_lock_minutes: 30 },
      { id: "mkt_np", currency_code: null, fx_rate_as_of: null, fx_lock_minutes: 30 },
    ]);
  });

  it("keeps the backup market in the shop currency and another market's currency in fx mode", () => {
    const database = migrate((seeded) => seeded.exec("INSERT INTO markets (id, handle, name, status) VALUES ('mkt_gb', 'uk', 'UK', 'active')"));
    expect(() => database.exec("UPDATE markets SET currency_code = 'USD' WHERE id = 'mkt_backup'")).toThrow(/MARKET_CURRENCY_INVALID/);
    expect(() => database.exec("UPDATE markets SET currency_code = 'GBP' WHERE id = 'mkt_gb'")).toThrow(/MARKET_CURRENCY_INVALID/);
    expect(() => database.exec("UPDATE markets SET currency_code = 'gbp', price_mode = 'fx' WHERE id = 'mkt_gb'")).toThrow(/markets_currency_shape/);
    expect(() => database.exec("UPDATE markets SET fx_lock_minutes = 2 WHERE id = 'mkt_gb'")).toThrow(/markets_fx_lock_minutes/);
    expect(() => database.exec("INSERT INTO markets (id, handle, name, status, currency_code) VALUES ('mkt_x', 'x', 'X', 'draft', 'EUR')")).toThrow(/MARKET_CURRENCY_INVALID/);

    const before = { fence: fence(), market: dep("mk:mkt_gb"), matrix: dep("mk:*") };
    database.exec("UPDATE markets SET currency_code = 'GBP', price_mode = 'fx', fx_rate = '0.0068' WHERE id = 'mkt_gb'");
    expect(fence()).toBeGreaterThan(before.fence);
    expect(dep("mk:mkt_gb")).toBeGreaterThan(before.market);
    expect(dep("mk:*")).toBeGreaterThan(before.matrix);
    // The rate's lock fences checkout; its as-of time is noise.
    const locked = { fence: fence(), market: dep("mk:mkt_gb") };
    database.exec("UPDATE markets SET fx_lock_minutes = 45 WHERE id = 'mkt_gb'");
    expect(fence()).toBeGreaterThan(locked.fence);
    database.exec("UPDATE markets SET fx_rate_as_of = 1790000500 WHERE id = 'mkt_gb'");
    expect(dep("mk:mkt_gb")).toBe(locked.market);
  });

  it("keeps what each customer spent in the shop currency", () => {
    const database = migrate((seeded) => seeded.exec(`
      INSERT INTO customers (id, name, phone) VALUES ('cust_1', 'Rahim', '+8801711111111');
      INSERT INTO orders (id, customer_id, customer_name, customer_phone, shipping_address, city, zone, status, paid_amount_minor, total_amount_minor, total_shop_minor)
        VALUES ('ord_1', 'cust_1', 'Rahim', '+8801711111111', 'House 1', 'city_1', 'zone_1', 'delivered', 36000, 36000, 36000);
    `));
    const spent = () => (database.prepare("SELECT total_spent_minor AS spent FROM customer_order_stats WHERE customer_id = 'cust_1'").get() as { spent: number }).spent;
    // A same-currency order adds what it paid, as before.
    expect(spent()).toBe(36_000);
    // A £10.20 order kept as ৳1,500.00, £6.80 of it paid: ৳1,000.00.
    database.exec(`
      INSERT INTO orders (id, customer_id, customer_name, customer_phone, shipping_address, city, zone, status,
        currency_code, shop_currency, fx_rate, paid_amount_minor, total_amount_minor, total_shop_minor)
      VALUES ('ord_2', 'cust_1', 'Rahim', '+8801711111111', 'House 1', 'city_1', 'zone_1', 'pending',
        'GBP', 'BDT', '147.058823529412', 680, 1020, 150000);
    `);
    expect(spent()).toBe(136_000);
    database.exec("UPDATE orders SET paid_amount_minor = 1020 WHERE id = 'ord_2'");
    expect(spent()).toBe(186_000);
  });
});
