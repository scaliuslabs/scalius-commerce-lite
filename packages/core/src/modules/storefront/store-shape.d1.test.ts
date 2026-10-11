// Wave B store-shape facts (design §8): `hasReviews` needs the reviews
// setting on AND a published review; `hasDigitalLines` needs a live digital
// SKU on a live product. Both come from the one counts statement.
import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { reviewsDocument } from "../settings/documents";
import { rebuildCatalogProjections } from "../products/catalog-projections";
import { readStoreShape, selectStoreShapeCounts } from "./store-shape";

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

    it("matches the original digital-SKU join across product and SKU lifecycle states", async () => {
        const { sqlite, db } = setup();
        try {
            const original = sqlite.prepare(`SELECT count(*) AS present FROM (
                SELECT 1 FROM product_variants v
                INNER JOIN products p ON p.id = v.product_id
                WHERE v.fulfillment_kind = 'digital' AND v.deleted_at IS NULL
                  AND p.deleted_at IS NULL AND p.is_active = 1
                LIMIT 1
            )`);
            const product = sqlite.prepare("UPDATE products SET is_active = ?, deleted_at = ? WHERE id = 'p_off'");
            const variant = sqlite.prepare("UPDATE product_variants SET fulfillment_kind = ?, deleted_at = ? WHERE id = 'v_off'");
            for (const kind of ["physical", "digital", "service"]) {
                for (const active of [0, 1]) {
                    for (const productDeleted of [null, 1780000000]) {
                        for (const skuDeleted of [null, 1780000000]) {
                            product.run(active, productDeleted);
                            variant.run(kind, skuDeleted);
                            const [row] = await selectStoreShapeCounts(db);
                            const expected = Number(kind === "digital" && active === 1 && productDeleted === null && skuDeleted === null);
                            expect(original.get()).toEqual({ present: expected });
                            expect(row?.digitalSkuCount).toBe(expected);
                        }
                    }
                }
            }
        } finally {
            sqlite.close();
        }
    });

    it("starts digital detection from the partial SKU index before looking up products", () => {
        const { sqlite, db } = setup();
        try {
            const query = selectStoreShapeCounts(db).toSQL();
            const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params) as Array<{ detail: string }>;
            const start = plan.findIndex(({ detail }) => detail === "CO-ROUTINE capped_digital_skus");
            const end = plan.findIndex(({ detail }) => detail === "SCAN capped_digital_skus");
            expect(start).toBeGreaterThanOrEqual(0);
            expect(end).toBeGreaterThan(start);
            const digitalPlan = plan.slice(start + 1, end).map(({ detail }) => detail);
            expect(digitalPlan[0]).toMatch(/^SCAN v USING (?:COVERING )?INDEX product_variants_digital_live_idx$/);
            expect(digitalPlan).toEqual(expect.arrayContaining([
                expect.stringMatching(/^SEARCH p(?: EXISTS)? USING INDEX \S+ \(id=\?/),
            ]));
            expect(digitalPlan.some((detail) => /products_public_newest_idx|product_variants_product_stock_idx/.test(detail))).toBe(false);
        } finally {
            sqlite.close();
        }
    });

    it("matches the original content-block join through placement, publication and deletion changes", async () => {
        const { sqlite, db } = setup();
        try {
            const original = sqlite.prepare(`SELECT count(*) AS present FROM (
                SELECT 1 FROM product_content_blocks block
                INNER JOIN product_buyer_state p ON p.product_id = block.product_id AND p.is_public = 1
                WHERE block.type IN ('rich-text', 'feature-list', 'faq', 'video', 'statement')
                  AND NOT (block.type = 'rich-text' AND block.placement = 'tabs') LIMIT 1
            )`);
            for (const [write, expected] of [
                ["SELECT 1", 0],
                ["INSERT INTO product_content_blocks (id, product_id, placement, position, type, version, settings) VALUES ('pcb_shape_test', 'p_live', 'tabs', 0, 'rich-text', 1, '{}')", 0],
                ["UPDATE product_content_blocks SET placement = 'after-description'", 1],
                ["UPDATE product_content_blocks SET type = 'pack-picker'", 0],
                ["UPDATE product_content_blocks SET type = 'faq', placement = 'tabs'", 1],
                ["UPDATE products SET is_active = 0 WHERE id = 'p_live'", 0],
                ["UPDATE products SET is_active = 1 WHERE id = 'p_live'", 1],
                ["UPDATE products SET deleted_at = 1780000000 WHERE id = 'p_live'", 0],
                ["UPDATE products SET deleted_at = NULL WHERE id = 'p_live'", 1],
                ["DELETE FROM product_content_blocks", 0],
            ] as const) {
                sqlite.exec(write);
                await rebuildCatalogProjections(db);
                expect(original.get()).toEqual({ present: expected });
                expect((await selectStoreShapeCounts(db))[0]?.contentBlockCount).toBe(expected);
            }
        } finally {
            sqlite.close();
        }
    });

    it("starts content detection from blocks before looking up public products", () => {
        const { sqlite, db } = setup();
        try {
            const query = selectStoreShapeCounts(db).toSQL();
            const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params) as Array<{ detail: string }>;
            const start = plan.findIndex(({ detail }) => detail === "CO-ROUTINE capped_content_blocks");
            const end = plan.findIndex(({ detail }) => detail === "SCAN capped_content_blocks");
            expect(start).toBeGreaterThanOrEqual(0);
            expect(end).toBeGreaterThan(start);
            const blockPlan = plan.slice(start + 1, end).map(({ detail }) => detail);
            expect(blockPlan[0]).toMatch(/^SCAN block(?: |$)/);
            expect(blockPlan).toEqual(expect.arrayContaining([
                expect.stringMatching(/^SEARCH block_product(?: EXISTS)? USING INDEX \S+ \(product_id=\?/),
            ]));
            expect(blockPlan.some((detail) => /product_buyer_state_category_newest_idx/.test(detail))).toBe(false);
        } finally {
            sqlite.close();
        }
    });
});
