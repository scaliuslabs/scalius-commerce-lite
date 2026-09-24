// 0079_whole_taka_amounts on a real pre-0079 schema: in a BDT store every
// merchant-entered amount becomes whole taka (half-up, never zero when it was
// not), receipts of past orders stay exactly as charged, and a store in
// another currency keeps its minor units.
import { describe, expect, it } from "vitest";

import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";

function seed(currencyCode: string | null) {
  return `
    ${currencyCode === null ? "" : `INSERT INTO settings (id, key, value, type, category)
      VALUES ('currency', 'document', '{"currencyCode":"${currencyCode}"}', 'json', 'currency');`}
    INSERT INTO settings (id, key, value, type, category, revision)
      VALUES ('checkout', 'document', '{"guestCheckoutEnabled":true,"checkoutMode":"all","partialPaymentEnabled":true,"partialPaymentAmount":99.5}', 'json', 'checkout', 3);
    INSERT INTO products (id, name, slug, price_minor, discount_type, discount_amount_minor)
      VALUES ('tee', 'Tee', 'tee', 99949, 'flat', 1050), ('pin', 'Pin', 'pin', 30, NULL, 0), ('cap', 'Cap', 'cap', 50000, NULL, 0);
    INSERT INTO product_variants (id, product_id, sku, price_minor, discount_type, discount_amount_minor, is_default)
      VALUES ('tee_sku', 'tee', 'TEE-1', 99950, 'flat', 1049, 1);
    INSERT INTO shipping_methods (id, name, fee_minor, free_over_minor, is_active)
      VALUES ('inside', 'Inside Dhaka', 6010, 99999, 1), ('outside', 'Outside Dhaka', 12000, NULL, 1);
    INSERT INTO promotions (id, name, method, max_discount_spend_minor, budget_currency_code)
      VALUES ('promo', 'Eid', 'automatic', 50050, 'BDT');
    INSERT INTO promotion_conditions (id, promotion_id, kind, config, position)
      VALUES ('cond', 'promo', 'minimum_merchandise_subtotal', '{"amountMinor":100050,"currencyCode":"BDT"}', 0);
    INSERT INTO promotion_effects (id, promotion_id, kind, target, allocation, config, position) VALUES
      ('fixed', 'promo', 'fixed_amount_off', 'order', 'once', '{"amountMinor":4050,"currencyCode":"BDT"}', 0),
      ('buy', 'promo', 'percentage_off', 'line', 'across', '{"basisPoints":1000,"buy":{"amountMinor":20020,"currencyCode":"BDT"}}', 1);
    INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone,
      subtotal_amount_minor, shipping_amount_minor, total_amount_minor, balance_due_minor)
      VALUES ('order', 'Buyer', '+8801700000000', 'Road 1', 'c', 'z', 99949, 6010, 105959, 105959);
  `;
}

describe.each(["d1", "turso"] as const)("0079 whole taka amounts (%s)", (provider) => {
  it("rounds merchant-entered taka to whole taka and leaves order receipts as charged", () => {
    const sqlite = createMigratedSqlite({ provider, beforeMigration: "0079_" });
    sqlite.exec(seed(null));

    sqlite.exec(compiledMigrationSql(provider, undefined, "0079_"));

    const all = (sql: string) => sqlite.prepare(sql).all();
    expect(all("SELECT id, price_minor, discount_amount_minor FROM products ORDER BY id")).toEqual([
      { id: "cap", price_minor: 50_000, discount_amount_minor: 0 },
      { id: "pin", price_minor: 100, discount_amount_minor: 0 },
      { id: "tee", price_minor: 99_900, discount_amount_minor: 1_100 },
    ]);
    expect(all("SELECT price_minor, discount_amount_minor FROM product_variants"))
      .toEqual([{ price_minor: 100_000, discount_amount_minor: 1_000 }]);
    expect(all("SELECT id, fee_minor, free_over_minor FROM shipping_methods ORDER BY id")).toEqual([
      { id: "inside", fee_minor: 6_000, free_over_minor: 100_000 },
      { id: "outside", fee_minor: 12_000, free_over_minor: null },
    ]);
    expect(all("SELECT max_discount_spend_minor FROM promotions")).toEqual([{ max_discount_spend_minor: 50_100 }]);
    expect(all("SELECT json_extract(config, '$.amountMinor') AS amount FROM promotion_conditions"))
      .toEqual([{ amount: 100_100 }]);
    expect(all("SELECT id, json_extract(config, '$.amountMinor') AS amount, json_extract(config, '$.buy.amountMinor') AS buy FROM promotion_effects ORDER BY id"))
      .toEqual([{ id: "buy", amount: null, buy: 20_000 }, { id: "fixed", amount: 4_100, buy: null }]);
    expect(all("SELECT json_extract(value, '$.partialPaymentAmount') AS amount, revision FROM settings WHERE category = 'checkout'"))
      .toEqual([{ amount: 100, revision: 4 }]);
    expect(all("SELECT subtotal_amount_minor, shipping_amount_minor, total_amount_minor FROM orders"))
      .toEqual([{ subtotal_amount_minor: 99_949, shipping_amount_minor: 6_010, total_amount_minor: 105_959 }]);
    sqlite.close();
  });

  it("leaves a store in another currency with its minor units", () => {
    const sqlite = createMigratedSqlite({ provider, beforeMigration: "0079_" });
    sqlite.exec(seed("USD").replaceAll('"currencyCode":"BDT"', '"currencyCode":"USD"').replace("'BDT');", "'USD');"));

    sqlite.exec(compiledMigrationSql(provider, undefined, "0079_"));

    const all = (sql: string) => sqlite.prepare(sql).all();
    expect(all("SELECT price_minor FROM products WHERE id = 'tee'")).toEqual([{ price_minor: 99_949 }]);
    expect(all("SELECT fee_minor FROM shipping_methods WHERE id = 'inside'")).toEqual([{ fee_minor: 6_010 }]);
    expect(all("SELECT max_discount_spend_minor FROM promotions")).toEqual([{ max_discount_spend_minor: 50_050 }]);
    expect(all("SELECT json_extract(config, '$.amountMinor') AS amount FROM promotion_effects WHERE id = 'fixed'"))
      .toEqual([{ amount: 4_050 }]);
    expect(all("SELECT json_extract(value, '$.partialPaymentAmount') AS amount FROM settings WHERE category = 'checkout'"))
      .toEqual([{ amount: 99.5 }]);
    sqlite.close();
  });
});
