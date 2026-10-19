// The feed (and the UCP catalogue built on it) carries a product's published
// review aggregate inside its one product statement, and nothing while the
// store's reviews are off (`reviewsEnabledSql`).
import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getStorefrontFeedProducts } from "./feed";

let sqlite: DatabaseSync;
let db: Database;

function insertProduct(id: string, createdAt: number): void {
    sqlite.prepare(
        `INSERT INTO products (id, name, description, price_minor, slug, created_at, updated_at)
         VALUES (?, ?, '', 100000, ?, ?, ?)`,
    ).run(id, `Product ${id}`, id.replace(/_/g, "-"), createdAt, createdAt);
    sqlite.prepare(
        `INSERT INTO media (id, filename, kind, object_key, size, mime_type, alt_text, status)
         VALUES (?, ?, 'image', ?, 1, 'image/jpeg', ?, 'ready')`,
    ).run(`media_${id}`, `${id}.jpg`, `products/${id}.jpg`, id);
    sqlite.prepare(
        `INSERT INTO product_media (id, product_id, media_id, alt_text, is_primary, sort_order)
         VALUES (?, ?, ?, ?, 1, 0)`,
    ).run(`pmed_${id}`, id, `media_${id}`, id);
    sqlite.prepare(
        `INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory)
         VALUES (?, ?, ?, 100000, 5, 1, 1)`,
    ).run(`var_${id}`, id, `SKU-${id}`);
}

let reviews = 0;
/** A published review on a delivered line (the product_reviews_line_eligible guard). */
function review(productId: string, rating: number): void {
    reviews += 1;
    const id = String(reviews).padStart(4, "0");
    sqlite.prepare(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, total_amount_minor, status)
        VALUES (?, 'Buyer', '01700000000', 'House 1', 'c', 'z', 100000, 'confirmed')`).run(`ord_${id}`);
    sqlite.prepare(`INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, unit_price_minor, fulfillment_type)
        VALUES (?, ?, ?, ?, 1, 100000, 'ship')`).run(`item_${id}`, `ord_${id}`, productId, `var_${productId}`);
    sqlite.prepare(`INSERT INTO order_fulfillments (id, order_id, kind, request_key, actor_type) VALUES (?, ?, 'ship', ?, 'admin')`)
        .run(`ful_${id}`, `ord_${id}`, `key_${id}`);
    sqlite.prepare(`INSERT INTO order_fulfillment_lines (id, fulfillment_id, order_id, order_item_id, quantity) VALUES (?, ?, ?, ?, 1)`)
        .run(`fln_${id}`, `ful_${id}`, `ord_${id}`, `item_${id}`);
    sqlite.prepare("UPDATE orders SET status = 'delivered' WHERE id = ?").run(`ord_${id}`);
    sqlite.prepare(`INSERT INTO product_reviews (id, product_id, variant_id, order_id, order_item_id, reviewer_key, author_type,
            author_display_name, rating, status, published_at)
        VALUES (?, ?, ?, ?, ?, ?, 'customer', 'Buyer B.', ?, 'published', 1790000000)`)
        .run(`rev_feed_${id}`, productId, `var_${productId}`, `ord_${id}`, `item_${id}`, `cus_${id}`, rating);
}

describe("feed product rating", () => {
    beforeEach(() => {
        ({ sqlite, db } = createSqliteD1Database());
        sqlite.exec("PRAGMA foreign_keys = OFF"); // fulfilment parents are irrelevant here
        insertProduct("prod_rated", 2);
        insertProduct("prod_unrated", 1);
        review("prod_rated", 5);
        review("prod_rated", 4);
    });

    afterEach(() => sqlite.close());

    it("carries the published average and count, and null without a review", async () => {
        const result = await getStorefrontFeedProducts(db, { limit: 10 });
        expect(result.products.map((product) => [product.id, product.rating])).toEqual([
            ["prod_rated", { average: 4.5, count: 2 }],
            ["prod_unrated", null],
        ]);
    });

    it("carries no rating while the store's reviews are off", async () => {
        sqlite.prepare(`INSERT INTO settings (id, category, key, type, value) VALUES ('set_reviews_off', 'reviews', 'document', 'json', ?)`)
            .run(JSON.stringify({ enabled: false, moderation: "auto", requestsEnabled: true, requestDelayDays: 7, blockWords: [] }));
        const result = await getStorefrontFeedProducts(db, { limit: 10 });
        expect(result.products.every((product) => product.rating === null)).toBe(true);
    });
});
