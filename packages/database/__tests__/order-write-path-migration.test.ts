import { describe, expect, it } from "vitest";
import { analyticsFactsDriftSql } from "../src/analytics-rollup";
import { recommendationPairsDriftSql } from "../src/derived-projections";
import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";

describe("0146_order_write_path over a populated store", () => {
  it("fills the new facts from every existing order, equal to a full rebuild", () => {
    const db = createMigratedSqlite({ beforeMigration: "0146_" });
    try {
      db.exec(`
        INSERT INTO customers (id, name, phone) VALUES ('cus_old', 'Old', '+8801711000001');
        INSERT INTO products (id, name, slug, price_minor) VALUES ('p_old', 'Old', 'old', 100);
        INSERT INTO orders (id, customer_name, customer_phone, customer_id, shipping_address, city, zone, status, payment_method,
          currency_code, shop_currency, fx_rate, shipping_amount_minor, discount_amount_minor, tax_amount_minor, created_at)
        VALUES
          ('ord_old_a', 'Old', '+8801711000001', 'cus_old', 'Road', 'city', 'zone', 'delivered', 'cod', 'BDT', 'BDT', '1', 60, 5, 0, 1700000000),
          ('ord_old_b', 'Guest', '', NULL, 'Road', 'city', 'zone', 'returned', 'stripe', 'USD', 'BDT', '117.5', 2, 0, 1, 1700090000),
          ('ord_old_c', 'Old', '+8801711000001', 'cus_old', 'Road', 'city', 'zone', 'cancelled', 'cod', 'BDT', 'BDT', '1', 0, 0, 0, 1700180000);
        INSERT INTO order_items (id, order_id, product_id, quantity, line_subtotal_minor, discount_amount_minor, tax_amount_minor, fulfillment_type)
        VALUES ('it_a', 'ord_old_a', 'p_old', 3, 300, 5, 0, 'digital'), ('it_b', 'ord_old_b', 'p_old', 2, 7, 0, 1, 'digital'),
          ('it_c', 'ord_old_c', 'p_old', 1, 100, 0, 0, 'digital');
        INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status)
        VALUES ('ref_old', 'ord_old_a', 40, 'BDT', 'cod', 'refund', 'refunded');
        INSERT INTO cod_tracking (id, order_id, cod_status) VALUES ('cod_old', 'ord_old_a', 'collected');
      `);
      db.exec(compiledMigrationSql("d1", undefined, "0146_"));
      expect(db.prepare("SELECT count(*) AS n FROM analytics_order_facts").get()).toEqual({ n: 3 });
      expect(db.prepare(analyticsFactsDriftSql("1 = 1")).get()).toEqual({ drift: 0 });
      expect(db.prepare(recommendationPairsDriftSql("SELECT id FROM orders")).get()).toEqual({ drift: 0 });
      expect(db.prepare("SELECT identity, refund_sum, cod_collected FROM analytics_order_facts WHERE order_id = 'ord_old_a'").get())
        .toEqual({ identity: "c:cus_old", refund_sum: 40, cod_collected: 1 });
      // Days are sealed later by maintenance; until then reports read these facts.
      expect(db.prepare("SELECT count(*) AS n FROM analytics_sealed_days").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
