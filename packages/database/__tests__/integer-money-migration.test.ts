// 0069_integer_money on a real pre-0069 schema: REAL amounts become exact
// integer minor units in the order's own currency (catalog and shipping in the
// store currency), percentages become basis points, and the checkout-authority
// triggers keep fencing the renamed catalog money columns.
import { describe, expect, it } from "vitest";

import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";

describe.each(["d1", "turso"] as const)("0069 integer money (%s)", (provider) => {
  it("leaves no floating-point column besides physical weight", () => {
    const sqlite = createMigratedSqlite({ provider });
    const tables = sqlite.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    const floating = tables.flatMap(({ name }) =>
      (sqlite.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string; type: string }>)
        .filter((column) => /real|double|float|numeric|decimal/i.test(column.type))
        .map((column) => `${name}.${column.name}`));
    expect(floating).toEqual(["product_variants.weight"]);
    sqlite.close();
  });

  it("converts every stored amount once, at the right precision", () => {
    const sqlite = createMigratedSqlite({ provider, beforeMigration: "0069_" });
    sqlite.exec(`
      INSERT INTO settings (id, key, value, type, category)
        VALUES ('currency', 'document', '{"currencyCode":"KWD"}', 'json', 'currency');
      INSERT INTO products (id, name, slug, price, discount_type, discount_percentage, discount_amount)
        VALUES ('p1', 'Tee', 'tee', 12.3456, 'percentage', 12.5, 1.0005);
      INSERT INTO product_variants (id, product_id, sku, price, discount_type, discount_percentage, is_default)
        VALUES ('v1', 'p1', 'TEE-1', 12.3456, 'percentage', 150, 1);
      INSERT INTO shipping_methods (id, name, fee, is_active) VALUES ('ship', 'Standard', 0.6, 1);
      INSERT INTO customers (id, name, phone, total_spent) VALUES ('c1', 'Buyer', '+8801700000000', 99.5);
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone,
        total_amount, shipping_charge, discount_amount, paid_amount, balance_due, currency_code, currency_decimal_places)
        VALUES ('bdt', 'Buyer', '+8801700000000', 'Road 1', 'c', 'z', 100.3, 60.1, 0.2, 50.15, 50.15, 'BDT', 2);
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone,
        total_amount, shipping_charge, paid_amount, balance_due)
        VALUES ('legacy', 'Buyer', '+8801700000001', 'Road 1', 'c', 'z', 1.2345, 0.6, 0, 1.2345);
      INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, price)
        VALUES ('item', 'bdt', 'p1', 'v1', 2, 20.2);
      INSERT INTO order_payments (id, order_id, amount, currency, payment_method, payment_type, status)
        VALUES ('pay', 'bdt', 50.15, 'BDT', 'cod', 'deposit', 'succeeded');
      INSERT INTO payment_plans (id, order_id, total_amount, deposit_amount, balance_due, status)
        VALUES ('plan', 'bdt', 100.3, 50.15, 50.15, 'deposit_paid');
      INSERT INTO cod_tracking (id, order_id, collected_amount) VALUES ('cod', 'bdt', 50.15);
    `);

    sqlite.exec(compiledMigrationSql(provider, undefined, "0069_"));

    const one = (sql: string) => sqlite.prepare(sql).get();
    expect(sqlite.prepare(`
      SELECT id, currency_code, currency_decimal_places, subtotal_amount_minor, shipping_amount_minor,
        discount_amount_minor, total_amount_minor, paid_amount_minor, balance_due_minor
      FROM orders ORDER BY id
    `).all()).toEqual([
      {
        id: "bdt", currency_code: "BDT", currency_decimal_places: 2, subtotal_amount_minor: 4040,
        shipping_amount_minor: 6010, discount_amount_minor: 20, total_amount_minor: 10030,
        paid_amount_minor: 5015, balance_due_minor: 5015,
      },
      {
        // A missing currency snapshot takes the store currency (KWD, 3 places).
        id: "legacy", currency_code: "KWD", currency_decimal_places: 3, subtotal_amount_minor: 0,
        shipping_amount_minor: 600, discount_amount_minor: 0, total_amount_minor: 1235,
        paid_amount_minor: 0, balance_due_minor: 1235,
      },
    ]);
    expect(one("SELECT unit_price_minor, line_subtotal_minor, taxable_amount_minor FROM order_items"))
      .toEqual({ unit_price_minor: 2020, line_subtotal_minor: 4040, taxable_amount_minor: 4040 });
    expect(one("SELECT amount_minor FROM order_payments")).toEqual({ amount_minor: 5015 });
    expect(one("SELECT total_amount_minor, deposit_amount_minor, balance_due_minor FROM payment_plans"))
      .toEqual({ total_amount_minor: 10030, deposit_amount_minor: 5015, balance_due_minor: 5015 });
    expect(one("SELECT collected_amount_minor FROM cod_tracking")).toEqual({ collected_amount_minor: 5015 });
    expect(one("SELECT fee_minor FROM shipping_methods")).toEqual({ fee_minor: 600 });
    expect(one("SELECT price_minor, discount_bps, discount_amount_minor FROM products"))
      .toEqual({ price_minor: 12346, discount_bps: 1250, discount_amount_minor: 1001 });
    // An out-of-range percentage is clamped to 100%.
    expect(one("SELECT price_minor, discount_bps, discount_amount_minor FROM product_variants"))
      .toEqual({ price_minor: 12346, discount_bps: 10000, discount_amount_minor: 0 });

    const columns = (table: string) => (sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
      .map((column) => column.name);
    expect(columns("orders")).not.toContain("total_amount");
    expect(columns("customers")).not.toContain("total_spent");
    expect(columns("order_tax_snapshots")).not.toContain("total_minor");
    expect(sqlite.prepare("SELECT name FROM sqlite_schema WHERE name = '_integer_money_store'").all()).toEqual([]);

    const revision = () => (one("SELECT revision FROM checkout_authority WHERE id = 'default'") as { revision: number }).revision;
    const before = revision();
    sqlite.exec("UPDATE product_variants SET price_minor = price_minor + 1");
    sqlite.exec("UPDATE products SET discount_bps = 500");
    expect(revision()).toBe(before + 2);
    sqlite.close();
  });
});
