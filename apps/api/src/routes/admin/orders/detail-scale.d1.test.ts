// A large order must not read every other buyer's reviews of a popular product.
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { getOrderDetails } from "@scalius/core/modules/orders";
import { createReviewStore } from "../../../../../../packages/core/src/modules/reviews/testing/fixture";
import type { CapturedQuery } from "../../../../../../packages/core/src/testing/list-plans";
import { composeOrderLineExtras, withOrderLineExtras } from "../../shared/order-line-extras";

let sqlite: DatabaseSync | undefined;
afterEach(() => sqlite?.close());

describe("admin order detail read budget", () => {
  it("enriches 99 lines in 90-id chunks with buyer-and-product review lookups", async () => {
    const store = createReviewStore();
    sqlite = store.sqlite;
    const lines = Array.from({ length: 99 }, (_, i) => ({ item: `item_large_${i}`, product: `prod_large_${i}` }));
    for (const line of lines) store.insert("products", { id: line.product, name: line.product, slug: line.product, price_minor: 100 });
    store.deliveredOrder("ord_large", lines);
    store.deliveredOrder("ord_prior", [{ item: "item_prior", product: lines[1]!.product }]);
    const review = (id: string, order: string, item: string, product: string, status: string) => store.insert("product_reviews", {
      id, order_id: order, order_item_id: item, product_id: product, reviewer_key: "acct_rahim",
      author_type: "customer", author_display_name: "Rahim", rating: 4, status,
      published_at: status === "published" ? Math.floor(Date.now() / 1000) : null,
    });
    review("rev_large_own000", "ord_large", lines[0]!.item, lines[0]!.product, "pending");
    review("rev_large_prior0", "ord_prior", "item_prior", lines[1]!.product, "published");
    review("rev_large_old000", "ord_large", lines[2]!.item, lines[2]!.product, "withdrawn");

    // Bulk-load unrelated buyers of the same popular product; these must never be read.
    for (const row of sqlite.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger'").all()) {
      sqlite.exec(`DROP TRIGGER "${row.name}"`);
    }
    sqlite.exec("BEGIN");
    const item = sqlite.prepare("INSERT INTO order_items (id, order_id, product_id, quantity, unit_price_minor) VALUES (?, 'ord_prior', ?, 1, 100)");
    const other = sqlite.prepare(`INSERT INTO product_reviews (id, order_id, order_item_id, product_id, reviewer_key, author_type, author_display_name, rating, status, published_at)
      VALUES (?, 'ord_prior', ?, ?, ?, 'customer', 'Buyer', 5, 'published', 1780000000)`);
    for (let i = 0; i < 20_000; i += 1) {
      const id = `other_item_${i}`;
      item.run(id, lines[1]!.product);
      other.run(`rev_other_${String(i).padStart(6, "0")}`, id, lines[1]!.product, `buyer_${i}`);
    }
    sqlite.exec("COMMIT");
    const queries: CapturedQuery[] = [];
    const { db } = createSqliteD1Database({ sqlite, onQuery: (query, values) => queries.push({ query, values }) });
    const detail = await getOrderDetails(db, "ord_large");
    expect(detail?.items).toHaveLength(99);
    const extras = await composeOrderLineExtras(db, {
      orderId: "ord_large", orderItemIds: detail!.items.map((line) => line.id), audience: "staff", currencyDecimalPlaces: 2,
    });
    const items = detail!.items.map((line) => withOrderLineExtras(line, extras));
    expect(items.find((line) => line.id === lines[0]!.item)?.extras?.review).toEqual({ eligible: false, review: { id: "rev_large_own000", rating: 4, status: "pending" } });
    expect(items.find((line) => line.id === lines[1]!.item)?.extras?.review).toEqual({ eligible: false, review: { id: "rev_large_prior0", rating: 4, status: "published" } });
    expect(items.find((line) => line.id === lines[2]!.item)?.extras?.review).toEqual({ eligible: false, review: { id: "rev_large_old000", rating: 4, status: "withdrawn" } });
    expect(items.filter((line) => line.extras?.review?.eligible)).toHaveLength(96);
    expect(queries.length).toBeLessThanOrEqual(24);
    expect(Math.max(...queries.map((query) => query.values.length))).toBeLessThanOrEqual(100);
    const live = queries.filter(({ query }) => /from "product_reviews" where/.test(query));
    expect(live.map(({ values }) => values.length)).toEqual([93, 12]);
    for (const { query, values } of live) {
      const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...values as never[]).map((row) => row.detail).join(" | ");
      expect(plan).toContain("product_reviews_reviewer_product_idx (reviewer_key=? AND product_id=? AND status=?)");
      expect(plan).not.toMatch(/SCAN |TEMP B-TREE/);
    }
  });
});
