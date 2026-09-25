// Wave B store-shape facts (design §8): `hasReviews` needs the reviews
// setting on AND a published review; `hasDigitalLines` needs a live digital
// SKU on a live product. Both come from the one counts statement.
import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { reviewsDocument } from "../settings/documents";
import { readStoreShape } from "./store-shape";

function setup() {
    const harness = createSqliteD1Database();
    harness.sqlite.exec(`
      INSERT INTO products (id, name, price_minor, slug, is_active) VALUES
        ('p_live', 'Live', 1000, 'live', 1), ('p_off', 'Off', 1000, 'off', 0);
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory, fulfillment_kind) VALUES
        ('v_live', 'p_live', 'LIVE-1', 1000, 1, 0, 1, 1, 'physical'),
        ('v_off', 'p_off', 'OFF-1', 1000, 0, 0, 1, 0, 'digital');
    `);
    return harness;
}

function addReview(sqlite: ReturnType<typeof setup>["sqlite"], status: "pending" | "published") {
    // The delivered-line guard (R1) is covered by the trigger tests; this test only needs a row.
    sqlite.exec(`
      DROP TRIGGER IF EXISTS product_reviews_line_eligible;
      INSERT OR IGNORE INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, city_name, zone_name,
          total_amount_minor, subtotal_amount_minor, status)
        VALUES ('o_1', 'Rahim', '+8801711111111', 'House 1', 'c', 'z', 'Dhaka', 'Mirpur', 1000, 1000, 'delivered');
      INSERT OR IGNORE INTO order_items (id, order_id, product_id, variant_id, quantity, product_name, unit_price_minor)
        VALUES ('oi_1', 'o_1', 'p_live', 'v_live', 1, 'Live', 1000);
      INSERT INTO product_reviews (id, product_id, variant_id, order_id, order_item_id, reviewer_key, author_type,
          author_display_name, rating, status, published_at)
        VALUES ('rev_review_0001', 'p_live', 'v_live', 'o_1', 'oi_1', 'cust_1', 'customer', 'Rahim', 5, '${status}',
          ${status === "published" ? "1780000000" : "NULL"});
    `);
}

describe("store shape: reviews and digital lines", () => {
    it("hasReviews needs the setting on and a published review", async () => {
        const { sqlite, db } = setup();
        expect((await readStoreShape(db)).hasReviews).toBe(false);

        addReview(sqlite, "pending");
        await reviewsDocument.write(db, { enabled: true });
        expect((await readStoreShape(db)).hasReviews).toBe(false);

        sqlite.exec("UPDATE product_reviews SET status = 'published', published_at = 1780000000");
        expect((await readStoreShape(db)).hasReviews).toBe(true);

        await reviewsDocument.write(db, { enabled: false });
        expect((await readStoreShape(db)).hasReviews).toBe(false);

        // A malformed document reads as disabled rather than failing the layout read.
        sqlite.exec("UPDATE settings SET value = '{not json' WHERE key = 'document' AND category = 'reviews'");
        expect((await readStoreShape(db)).hasReviews).toBe(false);
    });

    it("hasDigitalLines needs a live digital SKU on a live product", async () => {
        const { sqlite, db } = setup();
        expect((await readStoreShape(db)).hasDigitalLines).toBe(false);

        sqlite.exec("UPDATE products SET is_active = 1 WHERE id = 'p_off'");
        expect((await readStoreShape(db)).hasDigitalLines).toBe(true);

        sqlite.exec("UPDATE product_variants SET deleted_at = unixepoch() WHERE id = 'v_off'");
        expect((await readStoreShape(db)).hasDigitalLines).toBe(false);
    });
});
