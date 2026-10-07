// Migration 0120 (Markets step 4a): price lists, their prices and how each
// market prices. It applies over a populated 0119 store without changing a
// price: every market stays `fixed` and no list exists. The database refuses
// a market or sale list on the backup market, an FX backup market, broken
// FX policies and broken prices; every write that can change a checkout
// price fences priced checkouts; and the generated cache dependency triggers
// advance only the keys of active public lists.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { CACHE_DEP_LATER_TABLES, CACHE_DEP_LATER_TRIGGERS, cacheDepTriggersForMigration } from "../scripts/cache-dep-triggers";
import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";

const NAME = "0120_price_lists";
const BREAKPOINT = "--> statement-breakpoint";
const migration = (dir = "") => readFileSync(join(import.meta.dirname, `../migrations/${dir}${NAME}.sql`), "utf8");

describe(`${NAME} files`, () => {
  it("installs the generated cache dependency triggers verbatim on every provider", () => {
    const triggers = cacheDepTriggersForMigration(NAME);
    expect(Object.entries(CACHE_DEP_LATER_TABLES).filter(([, name]) => name === NAME).map(([table]) => table))
      .toEqual(["price_lists", "price_list_prices"]);
    expect(Object.entries(CACHE_DEP_LATER_TRIGGERS).filter(([, name]) => name === NAME).map(([trigger]) => trigger))
      .toEqual(["cdep_markets_pricing", "cdep_markets_pricing_old"]);
    expect([...new Set(triggers.map((trigger) => trigger.table))]).toEqual(["markets", "price_lists", "price_list_prices"]);
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

describe(`${NAME} over a populated 0119 database`, () => {
  let db: DatabaseSync | null = null;
  afterEach(() => db?.close());

  function migrate(seed: (database: DatabaseSync) => void = () => undefined): DatabaseSync {
    db = createMigratedSqlite({ beforeMigration: "0120_" });
    seed(db);
    db.exec(compiledMigrationSql("d1", undefined, "0120_"));
    db.exec(`
      INSERT INTO markets (id, handle, name, status) VALUES ('mkt_in', 'india', 'India', 'active');
      INSERT INTO products (id, name, price_minor, slug, is_active) VALUES ('p_tee', 'Tee', 50000, 'tee', 1), ('p_cap', 'Cap', 20000, 'cap', 1);
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory)
        VALUES ('v_tee', 'p_tee', 'TEE-1', 50000, 5, 0, 1, 1), ('v_cap', 'p_cap', 'CAP-1', 20000, 5, 0, 1, 1);
      INSERT INTO customer_segments (id, name, definition) VALUES ('seg_vip001', 'VIP', '{"version":1,"match":"all","conditions":[]}');
    `);
    return db;
  }

  const dep = (key: string) => (db!.prepare("SELECT seq FROM cache_dep WHERE dep = ?").get(key) as { seq: number } | undefined)?.seq ?? 0;

  it("keeps every market fixed with no adjustment, so every price stays today's", () => {
    const database = migrate((seeded) => {
      seeded.exec("INSERT INTO markets (id, handle, name, status) VALUES ('mkt_np', 'nepal', 'Nepal', 'draft')");
    });
    expect(database.prepare("SELECT id, price_mode, fx_rate, price_adjustment_bps, price_rounding_minor, price_ending_minor FROM markets ORDER BY id").all()).toEqual([
      { id: "mkt_backup", price_mode: "fixed", fx_rate: null, price_adjustment_bps: 0, price_rounding_minor: null, price_ending_minor: null },
      { id: "mkt_in", price_mode: "fixed", fx_rate: null, price_adjustment_bps: 0, price_rounding_minor: null, price_ending_minor: null },
      { id: "mkt_np", price_mode: "fixed", fx_rate: null, price_adjustment_bps: 0, price_rounding_minor: null, price_ending_minor: null },
    ]);
    expect(database.prepare("SELECT count(*) AS n FROM price_lists").get()).toEqual({ n: 0 });
  });

  it("refuses an FX backup market and broken FX policies", () => {
    const database = migrate();
    expect(() => database.exec("UPDATE markets SET price_mode = 'fx' WHERE id = 'mkt_backup'")).toThrow(/CHECK/);
    expect(() => database.exec("UPDATE markets SET price_mode = 'auto' WHERE id = 'mkt_in'")).toThrow(/CHECK/);
    for (const rate of ["", "-1", "1,5", "abc", ".5"]) {
      expect(() => database.prepare("UPDATE markets SET fx_rate = ? WHERE id = 'mkt_in'").run(rate), rate).toThrow(/CHECK/);
    }
    expect(() => database.exec("UPDATE markets SET price_adjustment_bps = -10000 WHERE id = 'mkt_in'")).toThrow(/CHECK/);
    expect(() => database.exec("UPDATE markets SET price_rounding_minor = 0 WHERE id = 'mkt_in'")).toThrow(/CHECK/);
    expect(() => database.exec("UPDATE markets SET price_ending_minor = 99 WHERE id = 'mkt_in'")).toThrow(/CHECK/);
    expect(() => database.exec("UPDATE markets SET price_rounding_minor = 100, price_ending_minor = 100 WHERE id = 'mkt_in'")).toThrow(/CHECK/);
    database.exec("UPDATE markets SET price_mode = 'fx', fx_rate = '1.25', price_adjustment_bps = 1500, price_rounding_minor = 1000, price_ending_minor = 900 WHERE id = 'mkt_in'");
    expect(database.prepare("SELECT price_mode, fx_rate FROM markets WHERE id = 'mkt_in'").get()).toEqual({ price_mode: "fx", fx_rate: "1.25" });
  });

  it("keeps market and sale lists off the backup market and checks every price", () => {
    const database = migrate();
    expect(() => database.exec("INSERT INTO price_lists (id, name, kind, market_id) VALUES ('pl_back', 'Back', 'market', 'mkt_backup')")).toThrow(/PRICE_LIST_BACKUP_MARKET/);
    expect(() => database.exec("INSERT INTO price_lists (id, name, kind, market_id) VALUES ('pl_back', 'Back', 'sale', 'mkt_backup')")).toThrow(/PRICE_LIST_BACKUP_MARKET/);
    // Wholesale prices for a segment in the backup market are fine.
    database.exec("INSERT INTO price_lists (id, name, kind, market_id, segment_id) VALUES ('pl_vip', 'Wholesale', 'segment', 'mkt_backup', 'seg_vip001')");
    expect(() => database.exec("UPDATE price_lists SET kind = 'sale', segment_id = NULL WHERE id = 'pl_vip'")).toThrow(/PRICE_LIST_BACKUP_MARKET/);
    database.exec("INSERT INTO price_lists (id, name, kind, market_id) VALUES ('pl_india', 'India', 'market', 'mkt_in')");
    expect(() => database.exec("UPDATE price_lists SET market_id = 'mkt_backup' WHERE id = 'pl_india'")).toThrow(/PRICE_LIST_BACKUP_MARKET/);
    // A segment list names its segment, and only a segment list does.
    expect(() => database.exec("INSERT INTO price_lists (id, name, kind, market_id) VALUES ('pl_xx1', 'X', 'segment', 'mkt_in')")).toThrow(/CHECK/);
    expect(() => database.exec("INSERT INTO price_lists (id, name, kind, market_id, segment_id) VALUES ('pl_xx2', 'X', 'market', 'mkt_in', 'seg_vip001')")).toThrow(/CHECK/);
    expect(() => database.exec("INSERT INTO price_lists (id, name, kind, market_id, segment_id) VALUES ('pl_xx3', 'X', 'segment', 'mkt_in', 'seg_missing')")).toThrow(/FOREIGN KEY/);
    expect(() => database.exec("INSERT INTO price_lists (id, name, kind, market_id, starts_at, ends_at) VALUES ('pl_xx4', 'X', 'sale', 'mkt_in', 200, 100)")).toThrow(/CHECK/);
    expect(() => database.exec("INSERT INTO price_lists (id, name, kind, market_id, priority) VALUES ('pl_xx5', 'X', 'sale', 'mkt_in', 1001)")).toThrow(/CHECK/);
    expect(() => database.exec("INSERT INTO price_lists (id, name, kind, market_id) VALUES ('list_x6', 'X', 'sale', 'mkt_in')")).toThrow(/CHECK/);

    database.exec("INSERT INTO price_list_prices (price_list_id, variant_id, currency_code, amount_minor, compare_at_minor) VALUES ('pl_india', 'v_tee', 'BDT', 45000, 50000)");
    database.exec("INSERT INTO price_list_prices (price_list_id, variant_id, currency_code, amount_minor, min_quantity) VALUES ('pl_india', 'v_tee', 'BDT', 40000, 10)");
    expect(() => database.exec("INSERT INTO price_list_prices (price_list_id, variant_id, currency_code, amount_minor) VALUES ('pl_india', 'v_tee', 'BDT', 1)")).toThrow(/UNIQUE|PRIMARY/);
    expect(() => database.exec("INSERT INTO price_list_prices (price_list_id, variant_id, currency_code, amount_minor) VALUES ('pl_india', 'v_cap', 'bdt', 1)")).toThrow(/CHECK/);
    expect(() => database.exec("INSERT INTO price_list_prices (price_list_id, variant_id, currency_code, amount_minor) VALUES ('pl_india', 'v_cap', 'BDT', 0)")).toThrow(/CHECK/);
    expect(() => database.exec("INSERT INTO price_list_prices (price_list_id, variant_id, currency_code, amount_minor, compare_at_minor) VALUES ('pl_india', 'v_cap', 'BDT', 100, 100)")).toThrow(/CHECK/);
    expect(() => database.exec("INSERT INTO price_list_prices (price_list_id, variant_id, currency_code, amount_minor, min_quantity) VALUES ('pl_india', 'v_cap', 'BDT', 100, 0)")).toThrow(/CHECK/);
    expect(() => database.exec("INSERT INTO price_list_prices (price_list_id, variant_id, currency_code, amount_minor) VALUES ('pl_india', 'v_missing', 'BDT', 100)")).toThrow(/FOREIGN KEY/);

    // A deleted SKU or list takes its prices with it; a deleted market its lists.
    database.exec("DELETE FROM product_variants WHERE id = 'v_tee'");
    expect(database.prepare("SELECT count(*) AS n FROM price_list_prices").get()).toEqual({ n: 0 });
    database.exec("DELETE FROM markets WHERE id = 'mkt_in'");
    expect(database.prepare("SELECT id FROM price_lists").all()).toEqual([{ id: "pl_vip" }]);
  });

  it("fences a priced checkout when an active list, its prices or a market's pricing change", () => {
    const database = migrate();
    const revision = () => (database.prepare("SELECT revision FROM checkout_authority WHERE id = 'default'").get() as { revision: number }).revision;
    let last = revision();
    const advances = (sql: string) => {
      database.exec(sql);
      const next = revision();
      const moved = next > last;
      last = next;
      return moved;
    };
    // A draft list prices nothing.
    expect(advances("INSERT INTO price_lists (id, name, kind, market_id) VALUES ('pl_india', 'India', 'market', 'mkt_in')")).toBe(false);
    expect(advances("INSERT INTO price_list_prices (price_list_id, variant_id, currency_code, amount_minor) VALUES ('pl_india', 'v_tee', 'BDT', 45000)")).toBe(false);
    expect(advances("UPDATE price_lists SET status = 'active' WHERE id = 'pl_india'")).toBe(true);
    expect(advances("UPDATE price_lists SET name = 'India retail', revision = revision + 1 WHERE id = 'pl_india'")).toBe(false);
    expect(advances("UPDATE price_lists SET priority = 5 WHERE id = 'pl_india'")).toBe(true);
    expect(advances("UPDATE price_lists SET ends_at = 2000000000 WHERE id = 'pl_india'")).toBe(true);
    expect(advances("UPDATE price_list_prices SET amount_minor = 44000 WHERE price_list_id = 'pl_india'")).toBe(true);
    expect(advances("INSERT INTO price_list_prices (price_list_id, variant_id, currency_code, amount_minor) VALUES ('pl_india', 'v_cap', 'BDT', 18000)")).toBe(true);
    expect(advances("DELETE FROM price_list_prices WHERE variant_id = 'v_cap'")).toBe(true);
    expect(advances("UPDATE markets SET price_mode = 'fx' WHERE id = 'mkt_in'")).toBe(true);
    expect(advances("UPDATE markets SET price_adjustment_bps = 500 WHERE id = 'mkt_in'")).toBe(true);
    expect(advances("UPDATE markets SET name = 'India (IN)' WHERE id = 'mkt_in'")).toBe(false);
    expect(advances("DELETE FROM price_lists WHERE id = 'pl_india'")).toBe(true);
  });

  it("advances a market's pricing keys only for active public lists", () => {
    const database = migrate();
    const advanced = (sql: string, keys: readonly string[]) => {
      const before = keys.map(dep);
      database.exec(sql);
      return keys.filter((key, index) => dep(key) > before[index]!);
    };
    const keys = ["pl:mkt_in", "pl:mkt_in:p_tee", "pl:mkt_in:p_cap", "pl:mkt_backup", "mk:mkt_in", "mk:*"];
    // Drafts and segment lists are never public.
    expect(advanced("INSERT INTO price_lists (id, name, kind, market_id) VALUES ('pl_india', 'India', 'market', 'mkt_in')", keys)).toEqual([]);
    expect(advanced("INSERT INTO price_list_prices (price_list_id, variant_id, currency_code, amount_minor) VALUES ('pl_india', 'v_tee', 'BDT', 45000)", keys)).toEqual([]);
    expect(advanced("INSERT INTO price_lists (id, name, kind, market_id, segment_id, status) VALUES ('pl_vip', 'VIP', 'segment', 'mkt_in', 'seg_vip001', 'active')", keys)).toEqual([]);
    expect(advanced("INSERT INTO price_list_prices (price_list_id, variant_id, currency_code, amount_minor) VALUES ('pl_vip', 'v_tee', 'BDT', 30000)", keys)).toEqual([]);
    // Activating a list, or changing an active one, advances its market only.
    expect(advanced("UPDATE price_lists SET status = 'active' WHERE id = 'pl_india'", keys)).toEqual(["pl:mkt_in"]);
    expect(advanced("UPDATE price_lists SET name = 'India retail' WHERE id = 'pl_india'", keys)).toEqual([]);
    expect(advanced("UPDATE price_list_prices SET amount_minor = 44000 WHERE price_list_id = 'pl_india'", keys)).toEqual(["pl:mkt_in:p_tee"]);
    expect(advanced("INSERT INTO price_list_prices (price_list_id, variant_id, currency_code, amount_minor) VALUES ('pl_india', 'v_cap', 'BDT', 18000)", keys)).toEqual(["pl:mkt_in:p_cap"]);
    expect(advanced("UPDATE price_lists SET status = 'draft' WHERE id = 'pl_india'", keys)).toEqual(["pl:mkt_in"]);
    // A market's pricing advances its own key; a rename advances the market keys only.
    expect(advanced("UPDATE markets SET price_mode = 'fx', price_adjustment_bps = 1000 WHERE id = 'mkt_in'", keys)).toEqual(["pl:mkt_in"]);
    expect(advanced("UPDATE markets SET name = 'India (IN)' WHERE id = 'mkt_in'", keys)).toEqual(["mk:mkt_in", "mk:*"]);
  });
});
