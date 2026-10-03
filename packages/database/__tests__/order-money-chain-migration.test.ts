// Migration 0111 (Markets step 1): the order money chain and payment
// settlement. Applied over a populated 0110 store, every existing order
// becomes a same-currency order (rate "1", shop amounts equal to its
// presentment amounts) and every payment movement settled as presented,
// without firing a single event, cache dependency or customer-stat trigger.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";

const NAME = "0111_order_money_chain";
const BREAKPOINT = "--> statement-breakpoint";
const migration = (dir = "") => readFileSync(join(import.meta.dirname, `../migrations/${dir}${NAME}.sql`), "utf8");

describe(`${NAME} files`, () => {
  it("adds the same columns on every provider and stays remote-D1 safe", () => {
    const sqlite = migration();
    const postgres = migration("postgres/");
    expect(sqlite).not.toMatch(/SELECT\s+CASE\s+WHEN|^\s*PRAGMA|CREATE TABLE `__new_/im);
    expect(postgres).not.toMatch(/GLOB|PRAGMA|randomblob/i);
    const columns = (text: string) => [...text.matchAll(/ADD (?:COLUMN )?[`"](\w+)[`"]/g)].map((match) => match[1]);
    expect(columns(sqlite)).toEqual(columns(postgres));
    expect(columns(sqlite)).toEqual([
      "settlement_currency", "settlement_amount_minor", "settlement_rate", "exchange_adjustment_minor",
      "shop_currency", "fx_rate", "fx_source", "fx_as_of", "fx_locked_until",
      "subtotal_shop_minor", "shipping_shop_minor", "discount_shop_minor", "tax_shop_minor", "total_shop_minor",
    ]);
    expect(sqlite.split(BREAKPOINT)).toHaveLength(postgres.split(BREAKPOINT).length);
  });
});

describe(`${NAME} over a populated 0110 database`, () => {
  let db: DatabaseSync;

  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

  beforeEach(() => {
    db = createMigratedSqlite({ beforeMigration: "0111_" });
    db.exec(`
      INSERT INTO customers (id, name, phone) VALUES ('cus_1', 'Rahim', '+8801711111111');
      INSERT INTO orders (id, customer_name, customer_phone, customer_id, shipping_address, city, zone, requires_shipping,
        status, payment_method, payment_status, currency_code, currency_decimal_places, subtotal_amount_minor,
        shipping_amount_minor, discount_amount_minor, tax_amount_minor, total_amount_minor, paid_amount_minor,
        balance_due_minor, created_at, updated_at)
      VALUES
        ('ord_bdt', 'Rahim', '+8801711111111', 'cus_1', 'House 1', 'city_1', 'zone_1', 1, 'delivered', 'cod', 'paid',
          'BDT', 2, 250000, 6000, 10000, 12000, 258000, 258000, 0, 1790000000, 1790000100),
        ('ord_usd', 'Karim', '+8801722222222', NULL, 'House 2', 'city_1', 'zone_1', 1, 'pending', 'stripe', 'unpaid',
          'USD', 2, 1999, 500, 0, 0, 2499, 0, 2499, 1790000200, 1790000300),
        ('ord_kwd', 'Fatima', '+8801733333333', NULL, NULL, NULL, NULL, 0, 'confirmed', 'stripe', 'paid',
          'KWD', 3, 12345, 0, 345, 0, 12000, 12000, 0, 1790000400, 1790000500);
      INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status, provider_ref)
      VALUES
        ('pay_cod', 'ord_bdt', 258000, 'BDT', 'cod', 'full', 'succeeded', NULL),
        ('pay_refund', 'ord_bdt', 5000, 'BDT', 'cod', 'refund', 'refunded', NULL),
        ('pay_kwd', 'ord_kwd', 12000, 'KWD', 'stripe', 'full', 'succeeded', 'pi_1');
    `);
  });
  afterEach(() => db.close());

  it("backfills every order as same-currency and every movement as settled in its own currency", () => {
    const outbox = count("SELECT count(*) AS n FROM event_outbox");
    const deps = count("SELECT count(*) AS n FROM cache_dep");
    const stats = db.prepare("SELECT * FROM customer_order_stats").all();
    db.exec(compiledMigrationSql("d1", undefined, "0111_"));

    expect(db.prepare(`SELECT id, currency_code, shop_currency, fx_rate, fx_source, fx_as_of, fx_locked_until,
        subtotal_shop_minor, shipping_shop_minor, discount_shop_minor, tax_shop_minor, total_shop_minor, updated_at
      FROM orders ORDER BY id`).all()).toEqual([
      {
        id: "ord_bdt", currency_code: "BDT", shop_currency: "BDT", fx_rate: "1", fx_source: "same_currency",
        fx_as_of: null, fx_locked_until: null, subtotal_shop_minor: 250000, shipping_shop_minor: 6000,
        discount_shop_minor: 10000, tax_shop_minor: 12000, total_shop_minor: 258000, updated_at: 1790000100,
      },
      {
        id: "ord_kwd", currency_code: "KWD", shop_currency: "KWD", fx_rate: "1", fx_source: "same_currency",
        fx_as_of: null, fx_locked_until: null, subtotal_shop_minor: 12345, shipping_shop_minor: 0,
        discount_shop_minor: 345, tax_shop_minor: 0, total_shop_minor: 12000, updated_at: 1790000500,
      },
      {
        id: "ord_usd", currency_code: "USD", shop_currency: "USD", fx_rate: "1", fx_source: "same_currency",
        fx_as_of: null, fx_locked_until: null, subtotal_shop_minor: 1999, shipping_shop_minor: 500,
        discount_shop_minor: 0, tax_shop_minor: 0, total_shop_minor: 2499, updated_at: 1790000300,
      },
    ]);
    expect(db.prepare(`SELECT id, currency, amount_minor, settlement_currency, settlement_amount_minor, settlement_rate,
        exchange_adjustment_minor FROM order_payments ORDER BY id`).all()).toEqual([
      { id: "pay_cod", currency: "BDT", amount_minor: 258000, settlement_currency: "BDT", settlement_amount_minor: 258000, settlement_rate: "1", exchange_adjustment_minor: 0 },
      { id: "pay_kwd", currency: "KWD", amount_minor: 12000, settlement_currency: "KWD", settlement_amount_minor: 12000, settlement_rate: "1", exchange_adjustment_minor: 0 },
      { id: "pay_refund", currency: "BDT", amount_minor: 5000, settlement_currency: "BDT", settlement_amount_minor: 5000, settlement_rate: "1", exchange_adjustment_minor: 0 },
    ]);
    // No buyer- or app-visible fact changed: no event, no dependency advance, the same customer stats.
    expect(count("SELECT count(*) AS n FROM event_outbox")).toBe(outbox);
    expect(count("SELECT count(*) AS n FROM cache_dep")).toBe(deps);
    expect(db.prepare("SELECT * FROM customer_order_stats").all()).toEqual(stats);
    expect(db.prepare("SELECT version, name FROM scalius_schema_migrations ORDER BY version DESC LIMIT 1").get())
      .toEqual({ version: 111, name: NAME });
    // The order search index still finds the orders it found.
    expect(count("SELECT count(*) AS n FROM orders_fts WHERE orders_fts MATCH 'Rahim'")).toBe(1);
  });

  it("gives a row written without the new columns the same-currency defaults", () => {
    db.exec(compiledMigrationSql("d1", undefined, "0111_"));
    db.exec(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone)
      VALUES ('ord_raw', 'Raw', '+8801744444444', 'House 4', 'city_1', 'zone_1')`);
    expect(db.prepare("SELECT shop_currency, fx_rate, fx_source, total_shop_minor FROM orders WHERE id = 'ord_raw'").get())
      .toEqual({ shop_currency: "BDT", fx_rate: "1", fx_source: "same_currency", total_shop_minor: 0 });
  });
});
