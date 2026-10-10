// Migration 0128 (scale reads) over a populated 0127 database: the replaced
// indexes give way to their successors, every customer gets a
// customer_order_stats row (backfilled, then by trigger), the review FTS
// index is rebuilt from existing reviews and follows every write, and a
// replay changes nothing. The plans the readers rely on are proved in
// packages/core (customer list, inventory, collection picker, reports).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";

const NAME = "0128_scale_reads";
const BREAKPOINT = "--> statement-breakpoint";
const migration = () => readFileSync(join(import.meta.dirname, `../migrations/${NAME}.sql`), "utf8");
const statements = (sql: string) => sql.split(BREAKPOINT).map((statement) => statement.trim()).filter(Boolean);

const CREATED = [
  "orders_sales_rollup_idx", "product_variants_product_live_idx",
  "customer_order_stats_orders_list_idx", "customer_order_stats_spent_list_idx", "customer_order_stats_last_order_list_idx",
];
const DROPPED = [
  "orders_dashboard_agg_idx", "product_variants_product_id_idx",
  "customer_order_stats_orders_idx", "customer_order_stats_spent_idx", "customer_order_stats_last_order_idx",
];

describe(`${NAME} over a populated 0127 database`, () => {
  let db: DatabaseSync | null = null;
  afterEach(() => db?.close());

  const indexNames = () => new Set((db!.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>)
    .map((row) => row.name));
  const statsOf = (customerId: string) => db!.prepare("SELECT orders_count, total_spent_minor, last_order_at FROM customer_order_stats WHERE customer_id = ?").get(customerId);
  const reviewSearch = (term: string) => (db!.prepare("SELECT r.id FROM product_reviews_fts f JOIN product_reviews r ON r.rowid = f.rowid WHERE product_reviews_fts MATCH ? ORDER BY r.id").all(term) as Array<{ id: string }>)
    .map((row) => row.id);

  it("replaces the indexes, gives every customer a stats row, indexes reviews and replays harmlessly", () => {
    db = createMigratedSqlite({ beforeMigration: "0128_" });
    db.exec(`
      INSERT INTO customers (id, name, phone) VALUES ('cus_buyer', 'Rahim', '+8801711000001'), ('cus_new', 'Karim', '+8801711000002');
      INSERT INTO orders (id, customer_id, customer_name, customer_phone, shipping_address, city, zone, total_amount_minor,
        shipping_amount_minor, payment_method, status, payment_status, paid_amount_minor, balance_due_minor, currency_code,
        currency_decimal_places, created_at, updated_at)
      VALUES ('ord_1', 'cus_buyer', 'Rahim', '+8801711000001', 'Mirpur', 'c', 'z', 5000, 0, 'cod', 'delivered', 'paid', 5000, 0, 'BDT', 2, 1700000000, 1700000000);
      INSERT INTO products (id, name, slug, price_minor) VALUES ('prod_1', 'Kettle', 'kettle', 1000);
      INSERT INTO order_items (id, order_id, product_id, quantity, fulfilled_quantity, product_name)
        VALUES ('item_1', 'ord_1', 'prod_1', 1, 1, 'Kettle');
      INSERT INTO product_reviews (id, product_id, order_id, order_item_id, rating, title, body, author_display_name, author_type, reviewer_key, status)
        VALUES ('rev_kettle01', 'prod_1', 'ord_1', 'item_1', 5, 'Boils quickly', 'A sturdy kettle', 'Nadia', 'customer', 'cus_buyer', 'pending');
    `);
    const before = indexNames();
    for (const name of DROPPED) expect(before.has(name), name).toBe(true);
    expect(statsOf("cus_new")).toBeUndefined();

    db.exec(compiledMigrationSql("d1", undefined, "0128_"));
    const after = indexNames();
    for (const name of CREATED) expect(after.has(name), name).toBe(true);
    for (const name of DROPPED) expect(after.has(name), name).toBe(false);
    // The buyer keeps the stats the order triggers wrote; the customer without orders gets a zero row.
    expect(statsOf("cus_buyer")).toEqual({ orders_count: 1, total_spent_minor: 5000, last_order_at: 1700000000 });
    expect(statsOf("cus_new")).toEqual({ orders_count: 0, total_spent_minor: 0, last_order_at: null });
    db.exec("INSERT INTO customers (id, name, phone) VALUES ('cus_later', 'Zarin', '+8801711000003')");
    expect(statsOf("cus_later")).toEqual({ orders_count: 0, total_spent_minor: 0, last_order_at: null });

    // Existing reviews are searchable; an edit and a delete follow.
    expect(reviewSearch("sturdy")).toEqual(["rev_kettle01"]);
    db.exec("UPDATE product_reviews SET body = 'A shiny kettle' WHERE id = 'rev_kettle01'");
    expect(reviewSearch("sturdy")).toEqual([]);
    expect(reviewSearch("shiny")).toEqual(["rev_kettle01"]);
    db.exec("UPDATE product_reviews SET rating = 4 WHERE id = 'rev_kettle01'");
    expect(reviewSearch("shiny")).toEqual(["rev_kettle01"]);
    db.exec("DELETE FROM product_reviews WHERE id = 'rev_kettle01'");
    expect(reviewSearch("shiny")).toEqual([]);

    // A replay (a lost response) changes nothing but the ledger row it repeats.
    db.exec(statements(migration()).slice(0, -1).join(";\n"));
    expect(indexNames()).toEqual(after);
    expect((db.prepare("SELECT count(*) AS n FROM customer_order_stats").get() as { n: number }).n).toBe(3);
  });
});
