// A migrated store for the reviews tests: products, a verified account and a
// guest, and helpers that create orders, hand lines over through the real
// fulfilment ledger (its triggers keep `fulfilled_quantity`) and deliver them
// (the delivered trigger records the review request).
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

type Row = Record<string, SQLInputValue>;

export interface ReviewStore {
  sqlite: DatabaseSync;
  db: Database;
  insert(table: string, row: Row): void;
  /** An order with one line per product id (type `ship` unless given). */
  order(id: string, lines: Array<{ item: string; product: string; type?: string; quantity?: number }>, owner?: { account?: string | null; customer?: string | null; name?: string }): void;
  /** Hands `quantity` of the line over (an active fulfilment of the line's type). */
  fulfil(orderId: string, itemId: string, quantity?: number, createdAt?: number): void;
  deliver(orderId: string): void;
  /** order + fulfil every line + deliver. */
  deliveredOrder(id: string, lines: Array<{ item: string; product: string; type?: string }>, owner?: { account?: string | null; customer?: string | null; name?: string }): void;
  scalar(sql: string, ...params: SQLInputValue[]): unknown;
  rows(sql: string, ...params: SQLInputValue[]): Array<Record<string, unknown>>;
  /** Σ published reviews per product, computed from the reviews themselves. */
  expectedStats(productId: string): { review_count: number; rating_sum: number } ;
  close(): void;
}

export function createReviewStore(): ReviewStore {
  const { sqlite, db } = createSqliteD1Database();
  const insert = (table: string, row: Row) => {
    const columns = Object.keys(row);
    sqlite
      .prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .run(...Object.values(row));
  };
  sqlite.exec(`
    INSERT INTO customers (id, name, phone, email, origin, account_claimed_at, phone_verified_at)
      VALUES ('acct_rahim', 'Abdur Rahim', '+8801711111111', 'rahim@example.test', 'account', 1780000000, 1780000000),
             ('acct_karim', 'Karim Uddin', '+8801722222222', NULL, 'account', 1780000000, 1780000000),
             ('cus_guest', 'Guest Buyer', '+8801733333333', NULL, 'order', NULL, NULL);
    INSERT INTO products (id, name, price_minor, slug, is_active) VALUES
      ('prod_shirt', 'Linen Shirt', 150000, 'linen-shirt', 1),
      ('prod_mug', 'Clay Mug', 50000, 'clay-mug', 1),
      ('prod_card', 'Gift Card', 100000, 'gift-card', 1);
    INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory) VALUES
      ('var_shirt', 'prod_shirt', 'SHIRT-1', 150000, 10, 0, 1, 1),
      ('var_mug', 'prod_mug', 'MUG-1', 50000, 10, 0, 1, 1),
      ('var_card', 'prod_card', 'CARD-1', 100000, 10, 0, 1, 0);
    INSERT INTO user (id, name, email, email_verified, role) VALUES ('staff_1', 'Nadia', 'nadia@shop.test', 1, 'admin');
  `);
  const variantOf: Record<string, string> = { prod_shirt: "var_shirt", prod_mug: "var_mug", prod_card: "var_card" };
  const nameOf: Record<string, string> = { prod_shirt: "Linen Shirt", prod_mug: "Clay Mug", prod_card: "Gift Card" };
  const typeOf = new Map<string, string>();
  let fulfilments = 0;

  const store: ReviewStore = {
    sqlite,
    db,
    insert,
    order(id, lines, owner = {}) {
      insert("orders", {
        id,
        customer_name: owner.name ?? "Abdur Rahim",
        customer_phone: "+8801711111111",
        customer_email: "rahim@example.test",
        shipping_address: "House 1, Road 2",
        city: "c",
        zone: "z",
        total_amount_minor: 200000,
        subtotal_amount_minor: 200000,
        status: "confirmed",
        account_owner_customer_id: owner.account === undefined ? "acct_rahim" : owner.account,
        customer_id: owner.customer === undefined ? (owner.account === undefined ? "acct_rahim" : owner.account) : owner.customer,
      });
      for (const line of lines) {
        const type = line.type ?? "ship";
        typeOf.set(line.item, type);
        insert("order_items", {
          id: line.item,
          order_id: id,
          product_id: line.product,
          variant_id: variantOf[line.product] ?? null,
          product_name: nameOf[line.product] ?? line.product,
          variant_label: line.product === "prod_shirt" ? "Size M" : null,
          quantity: line.quantity ?? 1,
          unit_price_minor: 100000,
          fulfillment_type: type,
        });
      }
    },
    fulfil(orderId, itemId, quantity = 1, createdAt) {
      fulfilments += 1;
      const fulfilmentId = `ful_${fulfilments}`;
      insert("order_fulfillments", {
        id: fulfilmentId,
        order_id: orderId,
        kind: typeOf.get(itemId) ?? "ship",
        request_key: `key_${fulfilmentId}`,
        actor_type: "admin",
        ...(createdAt === undefined ? {} : { created_at: createdAt }),
      });
      insert("order_fulfillment_lines", {
        id: `fln_${fulfilments}`,
        fulfillment_id: fulfilmentId,
        order_id: orderId,
        order_item_id: itemId,
        quantity,
        ...(createdAt === undefined ? {} : { created_at: createdAt }),
      });
    },
    deliver(orderId) {
      sqlite.prepare("UPDATE orders SET status = 'delivered' WHERE id = ?").run(orderId);
    },
    deliveredOrder(id, lines, owner) {
      store.order(id, lines, owner);
      for (const line of lines) store.fulfil(id, line.item);
      store.deliver(id);
    },
    scalar(sql, ...params) {
      const row = sqlite.prepare(sql).get(...params) as Record<string, unknown> | undefined;
      return row ? Object.values(row)[0] : undefined;
    },
    rows(sql, ...params) {
      return sqlite.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    },
    expectedStats(productId) {
      return sqlite.prepare(`
        SELECT count(*) AS review_count, coalesce(sum(rating), 0) AS rating_sum
        FROM product_reviews WHERE product_id = ? AND status = 'published'
      `).get(productId) as { review_count: number; rating_sum: number };
    },
    close() {
      sqlite.close();
    },
  };
  return store;
}
