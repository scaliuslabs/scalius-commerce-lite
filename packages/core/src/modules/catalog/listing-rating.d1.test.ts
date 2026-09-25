// Review ratings on buyer listings (Wave B §2.4): the card rating, the
// `rating` sort (Bayesian rank, unreviewed last), the `minRating` filter and
// the "N★ & up" facet, all read from the `product_review_stats` trigger
// projection. Reviews are inserted through SQL on delivered, fulfilled lines,
// so the real stats triggers compute the aggregates.
import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rebuildCatalogProjections } from "../products/catalog-projections";
import { getHomepageData } from "../storefront/storefront.service";
import { resolvePublicAttributeFilters } from "./facets";
import { getStorefrontCategoryProducts, getStorefrontProducts } from "./listing";

let sqlite: DatabaseSync | null = null;
afterAll(() => {
    sqlite?.close();
    sqlite = null;
});

const CATEGORY = {
    id: "cat_main", name: "Main", slug: "main", description: null, imageUrl: null,
    metaTitle: null, metaDescription: null, canonicalPath: null, noIndex: false,
    excludeFromSitemap: false, createdAt: null, updatedAt: null,
};

async function setup() {
    const harness = createSqliteD1Database();
    sqlite = harness.sqlite;
    const s = harness.sqlite;
    s.exec(`
        INSERT INTO categories (id, name, slug, status) VALUES
            ('cat_main', 'Main', 'main', 'published'),
            ('cat_quiet', 'Quiet', 'quiet', 'published');
        INSERT INTO brands (id, name, slug, status) VALUES
            ('brd_xenon001', 'Xenon', 'xenon', 'published'),
            ('brd_yotta001', 'Yotta', 'yotta', 'published');
        INSERT INTO products (id, name, price_minor, slug, category_id, brand_id, is_active, created_at) VALUES
            ('prod_a', 'One five star', 10000, 'one-five-star', 'cat_main', 'brd_xenon001', 1, 1700000001),
            ('prod_b', 'Ten reviews', 10000, 'ten-reviews', 'cat_main', 'brd_yotta001', 1, 1700000002),
            ('prod_c', 'Three reviews', 10000, 'three-reviews', 'cat_main', 'brd_xenon001', 1, 1700000003),
            ('prod_d', 'Never reviewed', 10000, 'never-reviewed', 'cat_main', 'brd_xenon001', 1, 1700000006),
            ('prod_e', 'Low rated', 10000, 'low-rated', 'cat_main', NULL, 1, 1700000004),
            ('prod_f', 'Pending only', 10000, 'pending-only', 'cat_main', NULL, 1, 1700000005),
            ('prod_q', 'Quiet', 10000, 'quiet', 'cat_quiet', NULL, 1, 1700000007);
        INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory) VALUES
            ('var_a', 'prod_a', 'SKU-A', 10000, 5, 1, 1),
            ('var_b', 'prod_b', 'SKU-B', 10000, 5, 1, 1),
            ('var_c', 'prod_c', 'SKU-C', 10000, 5, 1, 1),
            ('var_d', 'prod_d', 'SKU-D', 10000, 5, 1, 1),
            ('var_e', 'prod_e', 'SKU-E', 10000, 5, 1, 1),
            ('var_f', 'prod_f', 'SKU-F', 10000, 5, 1, 1),
            ('var_q', 'prod_q', 'SKU-Q', 10000, 5, 1, 1);
    `);

    // One delivered order per review: a shipped, handed-over line (the
    // product_reviews_line_eligible guard), then the review itself.
    s.exec("PRAGMA foreign_keys = OFF"); // fulfilment parents are irrelevant here
    let n = 0;
    const review = (productId: string, rating: number, status: "published" | "pending" = "published") => {
        n += 1;
        const id = String(n).padStart(4, "0");
        const variantId = productId.replace("prod_", "var_");
        s.prepare(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, total_amount_minor, status)
            VALUES (?, 'Buyer', '01700000000', 'House 1', 'c', 'z', 10000, 'confirmed')`).run(`ord_${id}`);
        s.prepare(`INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, unit_price_minor, fulfillment_type)
            VALUES (?, ?, ?, ?, 1, 10000, 'ship')`).run(`item_${id}`, `ord_${id}`, productId, variantId);
        s.prepare(`INSERT INTO order_fulfillments (id, order_id, kind, request_key, actor_type) VALUES (?, ?, 'ship', ?, 'admin')`)
            .run(`ful_${id}`, `ord_${id}`, `key_${id}`);
        s.prepare(`INSERT INTO order_fulfillment_lines (id, fulfillment_id, order_id, order_item_id, quantity) VALUES (?, ?, ?, ?, 1)`)
            .run(`fln_${id}`, `ful_${id}`, `ord_${id}`, `item_${id}`);
        s.prepare("UPDATE orders SET status = 'delivered' WHERE id = ?").run(`ord_${id}`);
        s.prepare(`INSERT INTO product_reviews (id, product_id, variant_id, order_id, order_item_id, reviewer_key, author_type,
                author_display_name, rating, status, published_at)
            VALUES (?, ?, ?, ?, ?, ?, 'customer', 'Buyer B.', ?, ?, ?)`)
            .run(`rev_listing_${id}`, productId, variantId, `ord_${id}`, `item_${id}`, `cus_${id}`, rating, status,
                status === "published" ? 1_790_000_000 : null);
    };
    review("prod_a", 5); // 5.00 avg, rank (5 + 15) * 1000 / 6 = 3333
    for (let index = 0; index < 8; index += 1) review("prod_b", 5);
    review("prod_b", 4);
    review("prod_b", 4); // 48 / 10 = 4.80, rank 63000 / 15 = 4200
    review("prod_c", 3);
    review("prod_c", 3);
    review("prod_c", 4); // 10 / 3 = 3.33, rank 25000 / 8 = 3125
    review("prod_e", 2);
    review("prod_e", 1); // 1.50, rank 18000 / 7 = 2571
    review("prod_f", 5, "pending"); // a stats row with no published review
    review("prod_q", 5, "pending");

    let cursor: string | null = null;
    for (;;) {
        const chunk = await rebuildCatalogProjections(harness.db, { afterProductId: cursor });
        if (chunk.done) break;
        cursor = chunk.nextAfterProductId;
    }
    return harness;
}

describe("review ratings on buyer listings", () => {
    // One store for every case: each only reads (the migrations dominate the cost).
    let harness: Awaited<ReturnType<typeof setup>>;
    beforeAll(async () => {
        harness = await setup();
    }, 120_000);

    it("reads the stats the triggers wrote", async () => {
        const s = harness.sqlite;
        expect(s.prepare(`SELECT product_id, review_count, rating_avg_centi, rating_rank_milli
            FROM product_review_stats ORDER BY product_id`).all()).toEqual([
            { product_id: "prod_a", review_count: 1, rating_avg_centi: 500, rating_rank_milli: 3333 },
            { product_id: "prod_b", review_count: 10, rating_avg_centi: 480, rating_rank_milli: 4200 },
            { product_id: "prod_c", review_count: 3, rating_avg_centi: 333, rating_rank_milli: 3125 },
            { product_id: "prod_e", review_count: 2, rating_avg_centi: 150, rating_rank_milli: 2571 },
            { product_id: "prod_f", review_count: 0, rating_avg_centi: null, rating_rank_milli: null },
            { product_id: "prod_q", review_count: 0, rating_avg_centi: null, rating_rank_milli: null },
        ]);
    });

    it("puts each card's rating on the listing, null without a published review", async () => {
        const { db } = harness;
        const result = await getStorefrontCategoryProducts(db, CATEGORY, { page: 1, limit: 20 });

        expect(Object.fromEntries(result.products.map((product) => [product.id, product.rating]))).toEqual({
            prod_a: { average: 5, count: 1 },
            prod_b: { average: 4.8, count: 10 },
            prod_c: { average: 3.33, count: 3 },
            prod_d: null,
            prod_e: { average: 1.5, count: 2 },
            prod_f: null,
        });
    });

    it("sorts by the Bayesian rank: many 4.8★ reviews outrank one 5★, unreviewed products last and newest first", async () => {
        const { db } = harness;
        const category = await getStorefrontCategoryProducts(db, CATEGORY, { page: 1, limit: 20, sort: "rating" });
        const shopAll = await getStorefrontProducts(db, { page: 1, limit: 20, sort: "rating" });
        const secondPage = await getStorefrontProducts(db, { page: 2, limit: 3, sort: "rating" });

        expect(category.products.map((product) => product.id))
            .toEqual(["prod_b", "prod_a", "prod_c", "prod_e", "prod_d", "prod_f"]);
        expect(shopAll.products.map((product) => product.id))
            .toEqual(["prod_b", "prod_a", "prod_c", "prod_e", "prod_q", "prod_d", "prod_f"]);
        expect(secondPage.products.map((product) => product.id)).toEqual(["prod_e", "prod_q", "prod_d"]);
    });

    it("filters by minRating on the average, and counts pages and prices over the filtered set", async () => {
        const { db } = harness;
        const ids = async (minRating: number) => (await getStorefrontCategoryProducts(db, CATEGORY, { page: 1, limit: 20, minRating }))
            .products.map((product) => product.id).sort();

        expect(await ids(4)).toEqual(["prod_a", "prod_b"]);
        expect(await ids(3)).toEqual(["prod_a", "prod_b", "prod_c"]);
        expect(await ids(2)).toEqual(["prod_a", "prod_b", "prod_c"]);
        expect(await ids(1)).toEqual(["prod_a", "prod_b", "prod_c", "prod_e"]);
        const four = await getStorefrontProducts(db, { page: 1, limit: 20, minRating: 4, sort: "rating" });
        expect(four.products.map((product) => product.id)).toEqual(["prod_b", "prod_a"]);
        expect(four.pagination.total).toBe(2);
        // Out-of-range values never reach SQL (the route rejects them first).
        expect((await getStorefrontProducts(db, { page: 1, limit: 20, minRating: 5 })).pagination.total).toBe(7);
    });

    it("counts the rating facet against every other selection, and the other facets against the rating", async () => {
        const { db } = harness;
        const plain = await getStorefrontCategoryProducts(db, CATEGORY, { page: 1, limit: 20 });
        expect(plain.ratingFacet).toEqual([{ min: 4, count: 2 }, { min: 3, count: 3 }, { min: 2, count: 3 }]);
        expect(plain.facets.find((facet) => facet.slug === "brand")?.values.map(({ value, count }) => [value, count]))
            .toEqual([["xenon", 3], ["yotta", 1]]);

        // The selected rating narrows the brand counts, never its own facet's.
        const rated = await getStorefrontCategoryProducts(db, CATEGORY, { page: 1, limit: 20, minRating: 4 });
        expect(rated.ratingFacet).toEqual([{ min: 4, count: 2 }, { min: 3, count: 3 }, { min: 2, count: 3 }]);
        expect(rated.facets.find((facet) => facet.slug === "brand")?.values.map(({ value, count }) => [value, count]))
            .toEqual([["xenon", 1], ["yotta", 1]]);

        // A brand selection narrows the rating counts; a selected 1★ keeps its own row.
        const filters = await resolvePublicAttributeFilters(db, { brand: ["xenon"] }, []);
        const xenon = await getStorefrontCategoryProducts(db, CATEGORY, { page: 1, limit: 20, attributeFilters: filters, minRating: 1 });
        expect(xenon.products.map((product) => product.id).sort()).toEqual(["prod_a", "prod_c"]);
        expect(xenon.ratingFacet).toEqual([
            { min: 4, count: 1 }, { min: 3, count: 2 }, { min: 2, count: 2 }, { min: 1, count: 2 },
        ]);
    });

    it("offers no rating facet where nothing in scope has a published review", async () => {
        const { db } = harness;
        const quiet = { ...CATEGORY, id: "cat_quiet", name: "Quiet", slug: "quiet" };
        expect((await getStorefrontCategoryProducts(db, quiet, { page: 1, limit: 20 })).ratingFacet).toEqual([]);
        // A selection with nothing to show keeps its row so the buyer can untick it.
        expect((await getStorefrontCategoryProducts(db, quiet, { page: 1, limit: 20, minRating: 4 })).ratingFacet)
            .toEqual([{ min: 4, count: 0 }]);
    });

    it("puts the rating on homepage cards", async () => {
        const { db } = harness;
        const home = await getHomepageData(db, {
            requests: { lists: [{ key: "newest", source: { kind: "newest" }, limit: 8 }], mediaIds: [] },
            sectionsOnly: true,
        });
        const cards = home.sections.lists[0]?.products ?? [];
        expect(Object.fromEntries(cards.map((card) => [card.id, card.rating]))).toMatchObject({
            prod_b: { average: 4.8, count: 10 },
            prod_d: null,
            prod_f: null,
        });
    });

    // Last: it turns reviews off for the shared store.
    it("publishes no card rating, rating facet or rating order while reviews are off", async () => {
        const { db, sqlite } = harness;
        sqlite.prepare(`INSERT INTO settings (id, category, key, type, value) VALUES ('set_reviews_off', 'reviews', 'document', 'json', ?)`)
            .run(JSON.stringify({ enabled: false, moderation: "auto", requestsEnabled: true, requestDelayDays: 7, blockWords: [] }));
        const result = await getStorefrontCategoryProducts(db, CATEGORY, { page: 1, limit: 20 });
        expect(result.products.every((product) => product.rating === null)).toBe(true);
        expect(result.ratingFacet).toEqual([]);
        const home = await getHomepageData(db, {
            requests: { lists: [{ key: "newest", source: { kind: "newest" }, limit: 8 }], mediaIds: [] },
            sectionsOnly: true,
        });
        expect((home.sections.lists[0]?.products ?? []).every((card) => card.rating === null)).toBe(true);
    });
});
