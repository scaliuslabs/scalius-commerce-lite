import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, describe, expect, it } from "vitest";

import { resolvePublicAttributeFilters } from "../attributes/attributes.public";
import { resolveCollectionProductsBatch } from "../collections/collections.service";
import { search } from "../../search";
import { getHomepageData } from "../storefront/storefront.service";
import { getProductsByIds, listProducts } from "../products/admin/read";
import {
    getStorefrontCategoryProducts,
    getStorefrontCollectionProducts,
    getStorefrontProducts,
} from "./listing";
import { getStorefrontFeedProducts } from "./feed";
import { getStorefrontSitemapProducts } from "./sitemap";
import { refreshProductSalesStats } from "./recommendation-refresh";
import {
    catalogBuyerStateRefreshStatementsForSkus,
    catalogProjectionRefreshStatements,
    rebuildCatalogProjections,
} from "../products/catalog-projections";
import { safeBatch } from "@scalius/database/client";

/**
 * Query-plan guards for reads that grow with the catalogue. D1 carries no
 * ANALYZE statistics, so SQLite plans these by shape alone, exactly as here.
 * On a 30k-product / 80k-SKU store each regression below cost 0.3-17 s of D1
 * time per request (audit/rewrite-2026-09-23/CATALOG-SCALE.md).
 */

type Captured = { sql: string; params: readonly SQLInputValue[] };

let sqlite: DatabaseSync | null = null;
afterEach(() => {
    sqlite?.close();
    sqlite = null;
});

function setup() {
    const queries: Captured[] = [];
    const harness = createSqliteD1Database({ onQuery: (sql, params) => queries.push({ sql, params }) });
    sqlite = harness.sqlite;
    sqlite.exec(`
        INSERT INTO categories (id, name, slug, status) VALUES
            ('cat_laptop', 'Laptop', 'laptop', 'published'),
            ('cat_phone', 'Gaming Phone', 'gaming-phone', 'published');
        INSERT INTO products (id, name, price_minor, slug, category_id, is_active, created_at) VALUES
            ('prod_a', 'Asus Vivobook', 5000000, 'asus-vivobook', 'cat_laptop', 1, 1700000003),
            ('prod_b', 'Lenovo IdeaPad', 6000000, 'lenovo-ideapad', 'cat_laptop', 1, 1700000002),
            ('prod_c', 'Xiaomi Phone', 3000000, 'xiaomi-phone', 'cat_phone', 1, 1700000001);
        INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory) VALUES
            ('var_a', 'prod_a', 'SKU-A', 5000000, 3, 1, 1),
            ('var_b', 'prod_b', 'SKU-B', 6000000, 0, 1, 1),
            ('var_c', 'prod_c', 'SKU-C', 3000000, 2, 1, 1);
        INSERT INTO media (id, filename, kind, object_key, size, mime_type, status) VALUES
            ('med_a', 'a.webp', 'image', 'media/a.webp', 1, 'image/webp', 'ready'),
            ('med_b', 'b.webp', 'image', 'media/b.webp', 1, 'image/webp', 'ready'),
            ('med_c', 'c.webp', 'image', 'media/c.webp', 1, 'image/webp', 'ready');
        INSERT INTO product_media (id, product_id, media_id, is_primary, sort_order) VALUES
            ('pmed_aaaaa', 'prod_a', 'med_a', 1, 0),
            ('pmed_bbbbb', 'prod_b', 'med_b', 1, 0),
            ('pmed_ccccc', 'prod_c', 'med_c', 1, 0);
    `);
    const plans = (match: (sql: string) => boolean) => queries
        .filter((query) => match(query.sql))
        .map((query) => sqlite!.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
            .all(...query.params)
            .map((step) => String(step.detail))
            .join("\n"));
    return { db: harness.db, queries, plans };
}

const joinsPricing = (sql: string) => sql.includes("buyer_ranked_skus");
const readsBuyerState = (sql: string) => sql.includes("product_buyer_state") && !sql.startsWith("insert");

/** Fills the stored projections for the raw-SQL seed (as a release does), then forgets those statements. */
async function project(db: Parameters<typeof rebuildCatalogProjections>[0], queries: Captured[]) {
    let cursor: string | null = null;
    for (;;) {
        const chunk = await rebuildCatalogProjections(db, { afterProductId: cursor });
        if (chunk.done) break;
        cursor = chunk.nextAfterProductId;
    }
    queries.length = 0;
}

/** A listing statement over the buyer state never ranks SKUs or evaluates eligibility per request. */
function expectBuyerStateListing(plan: string) {
    expect(plan).not.toContain("buyer_ranked_skus");
    expect(plan).not.toMatch(/SCAN (products|product_variants|product_buyer_state)\b/);
    expect(plan).not.toContain("buyer_active_sku");
}

describe("catalogue-scale query plans", () => {
    it("reads a category listing from the buyer state's category index", async () => {
        const { db, queries, plans } = setup();
        await project(db, queries);
        const result = await getStorefrontCategoryProducts(db, {
            id: "cat_laptop", name: "Laptop", slug: "laptop", description: null, imageUrl: null,
            metaTitle: null, metaDescription: null, canonicalPath: null, noIndex: false,
            excludeFromSitemap: false, createdAt: null, updatedAt: null,
        }, { page: 1, limit: 20 });

        expect(result.products.map((product) => product.id)).toEqual(["prod_a", "prod_b"]);
        const statePlans = plans(readsBuyerState);
        expect(statePlans.length).toBeGreaterThanOrEqual(4); // page, count, two facet counts
        for (const plan of statePlans) {
            expect(plan).toContain("product_buyer_state_category_newest_idx (is_public=? AND category_id=?)");
            expectBuyerStateListing(plan);
        }
        expect(plans(joinsPricing)).toEqual([]);
    });

    it("drives collection membership from its product and category sets by primary key", async () => {
        const { db, queries, plans } = setup();
        await project(db, queries);
        const result = await getStorefrontCollectionProducts(db, {
            productIds: ["prod_c"],
            categoryIds: ["cat_laptop"],
        }, { page: 1, limit: 20 });

        expect(result.products.map((product) => product.id)).toEqual(["prod_c", "prod_a", "prod_b"]);
        for (const plan of plans(readsBuyerState)) {
            expectBuyerStateListing(plan);
            // Never the public walk: the member set drives by id.
            expect(plan).not.toMatch(/SEARCH product_buyer_state USING (COVERING )?INDEX product_buyer_state_(price|newest)_idx/);
            expect(plan).toContain("SEARCH collection_member USING COVERING INDEX product_buyer_state_category_newest_idx");
        }
        expect(plans(joinsPricing)).toEqual([]);
    });

    it("walks the public newest and price indexes for the unscoped shop-all pages", async () => {
        const { db, queries, plans } = setup();
        await project(db, queries);
        const newest = await getStorefrontProducts(db, { page: 1, limit: 2 });
        const [newestPage, newestCount] = plans(readsBuyerState);
        queries.length = 0;
        const cheapest = await getStorefrontProducts(db, { page: 1, limit: 2, sort: "price-asc" });
        const [pricePage] = plans(readsBuyerState);
        queries.length = 0;
        const deepest = await getStorefrontProducts(db, { page: 1, limit: 2, sort: "discount" });

        expect(newest.products.map((product) => product.id)).toEqual(["prod_a", "prod_b"]);
        expect(newest.pagination.total).toBe(3);
        expect(cheapest.products.map((product) => product.id)).toEqual(["prod_c", "prod_a"]);
        expect(deepest.products).toHaveLength(2);
        expect(newestPage).toContain("SEARCH product_buyer_state USING INDEX product_buyer_state_newest_idx (is_public=?)");
        expect(newestPage).not.toContain("USE TEMP B-TREE FOR ORDER BY");
        expect(pricePage).toContain("SEARCH product_buyer_state USING INDEX product_buyer_state_price_idx (is_public=?)");
        expect(pricePage).not.toContain("USE TEMP B-TREE FOR ORDER BY");
        // The count reads the buyer state alone: no products join, no pricing.
        expect(newestCount).not.toMatch(/SEARCH products\b/);
        for (const plan of [newestPage!, newestCount!, pricePage!]) expectBuyerStateListing(plan);
    });

    it("counts facets live on shop-all only while the public catalogue is small", async () => {
        const { db, queries } = setup();
        sqlite!.exec(`
            INSERT INTO product_attributes (id, name, slug, filterable) VALUES ('attr_brand', 'Brand', 'brand', 1);
            INSERT INTO product_attribute_values (id, product_id, attribute_id, value) VALUES ('val_a', 'prod_a', 'attr_brand', 'Asus');
        `);
        await project(db, queries);
        const small = await getStorefrontProducts(db, { page: 1, limit: 2 });
        expect(small.facets.map((facet) => facet.slug)).toEqual(["brand"]);
        expect(queries.filter((query) => query.sql.includes("product_attribute_values")).length).toBe(1);

        // 2,001 public products: the unscoped count stops at the limit and the
        // facet statements never run; a category still counts its own.
        const insertProduct = sqlite!.prepare("INSERT INTO products (id, name, price_minor, slug, category_id, is_active, created_at) VALUES (?, ?, 10000, ?, 'cat_phone', 1, 1600000000)");
        const insertSku = sqlite!.prepare("INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory) VALUES (?, ?, ?, 10000, 1, 1, 0)");
        for (let index = 0; index < 1_998; index += 1) {
            insertProduct.run(`prod_bulk_${index}`, `Bulk ${index}`, `bulk-${index}`);
            insertSku.run(`var_bulk_${index}`, `prod_bulk_${index}`, `BULK-${index}`);
        }
        await project(db, queries);
        const large = await getStorefrontProducts(db, { page: 1, limit: 2 });
        expect(large.pagination.total).toBe(2_001);
        expect(large.facets).toEqual([]);
        expect(queries.filter((query) => query.sql.includes("product_attribute_values"))).toEqual([]);
        const scoped = await getStorefrontProducts(db, { page: 1, limit: 2, category: "laptop" });
        expect(scoped.facets.map((facet) => facet.slug)).toEqual(["brand"]);
    });

    it("pages and counts the product sitemap from the buyer state's newest index", async () => {
        const { db, queries, plans } = setup();
        sqlite!.exec("UPDATE products SET no_index = 1 WHERE id = 'prod_b'");
        await project(db, queries);
        const result = await getStorefrontSitemapProducts(db, { page: 1, limit: 100 });

        expect(result.products.map((product) => product.slug)).toEqual(["asus-vivobook", "xiaomi-phone"]);
        expect(result.pagination.total).toBe(2);
        const [page, count] = plans(readsBuyerState);
        expect(page).toContain("SEARCH product_buyer_state USING COVERING INDEX product_buyer_state_newest_idx (is_public=?)");
        expect(page).not.toContain("USE TEMP B-TREE FOR ORDER BY");
        for (const plan of [page!, count!]) expectBuyerStateListing(plan);
    });

    it("reads home 'popular' from the sales stats index, public products only", async () => {
        const { db, queries, plans } = setup();
        const now = Math.floor(Date.now() / 1000);
        sqlite!.exec(`
            INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status, created_at, updated_at) VALUES
                ('ord_1', 'A', '01711000001', 'Road', 'c', 'z', 'confirmed', ${now - 3_600}, ${now - 3_600}),
                ('ord_2', 'B', '01711000002', 'Road', 'c', 'z', 'cancelled', ${now - 3_600}, ${now - 3_600});
            INSERT INTO order_items (id, order_id, product_id, quantity) VALUES
                ('line_1', 'ord_1', 'prod_b', 3), ('line_2', 'ord_1', 'prod_c', 2), ('line_3', 'ord_2', 'prod_a', 9);
            UPDATE products SET is_active = 0 WHERE id = 'prod_c';
        `);
        await project(db, queries);
        await expect(refreshProductSalesStats(db)).resolves.toEqual({ products: 2 });
        expect(sqlite!.prepare("SELECT product_id, sold_30d FROM product_sales_stats ORDER BY product_id").all())
            .toEqual([{ product_id: "prod_b", sold_30d: 3 }, { product_id: "prod_c", sold_30d: 2 }]);
        queries.length = 0;

        const home = await getHomepageData(db, {
            requests: { lists: [{ key: "popular", source: { kind: "popular" }, limit: 4 }], mediaIds: [] },
            sectionsOnly: true,
        });

        expect(home.sections.lists[0]?.products.map((product) => product.id)).toEqual(["prod_b"]);
        const popularPlans = plans((sql) => sql.includes("product_sales_stats"));
        expect(popularPlans.length).toBe(2); // the cards and their media
        for (const plan of popularPlans) {
            expect(plan).toContain("product_sales_stats_popular_idx");
            expect(plan).not.toMatch(/SCAN (orders|order_items|products|product_sales_stats)\b/);
            expect(plan).not.toMatch(/SCAN buyer_pricing_sku/);
        }
    });

    it("refreshes the projections of the written products only, by index", async () => {
        const { db, queries, plans } = setup();
        await project(db, queries);
        await safeBatch(db, [
            ...catalogProjectionRefreshStatements(db, ["prod_a"]),
            ...catalogBuyerStateRefreshStatementsForSkus(db, ["var_b"]),
        ] as never);

        const refreshPlans = plans((sql) => /^(insert into|delete from) "product_(buyer_state|facet_values)"/.test(sql));
        expect(refreshPlans).toHaveLength(5);
        for (const plan of refreshPlans) {
            expect(plan).not.toMatch(/SCAN (products|product_variants|product_attribute_values|product_facet_values|buyer_pricing_sku|buyer_pricing_product)\b/);
        }
        expect(Math.max(...queries.map((query) => query.params.length))).toBeLessThanOrEqual(90);
    });

    it("scopes every homepage collection statement to its own products", async () => {
        const { db, plans } = setup();
        const resolved = await resolveCollectionProductsBatch(db, [
            { id: "col_manual", config: { source: "manual", productIds: ["prod_c"], categoryIds: [], maxProducts: 8 } },
            { id: "col_dynamic", config: { source: "dynamic", productIds: [], categoryIds: ["cat_laptop"], maxProducts: 8 } },
        ]);

        expect(resolved.get("col_manual")?.products.map((product) => product.id)).toEqual(["prod_c"]);
        expect(resolved.get("col_dynamic")?.products.map((product) => product.id)).toEqual(["prod_a", "prod_b"]);
        const pricingPlans = plans(joinsPricing);
        expect(pricingPlans.length).toBe(2);
        for (const plan of pricingPlans) expect(plan).not.toMatch(/SCAN buyer_pricing_sku/);
    });

    it("prices only the page in admin lists and id lookups", async () => {
        const { db, plans } = setup();
        const list = await listProducts(db, { page: 1, limit: 2, sort: "name", order: "asc" });
        const picked = await getProductsByIds(db, ["prod_c"]);

        expect(list.products.map((product) => product.priceRange?.from)).toEqual([50000, 60000]);
        expect(picked[0]?.priceRange?.from).toBe(30000);
        for (const plan of plans(joinsPricing)) expect(plan).not.toMatch(/SCAN buyer_pricing_sku/);
    });

    it("ranks search hits by bm25 once per statement, not once per candidate", async () => {
        const { db, queries, plans } = setup();
        await project(db, queries);
        const listing = await getStorefrontProducts(db, { search: "gaming", sort: "relevance", page: 1, limit: 20 });
        const predictive = await search(db, "asus");

        expect(listing.products.map((product) => product.id)).toEqual(["prod_c"]);
        expect(predictive.products.map((product) => product.id)).toEqual(["prod_a"]);
        const rankedPlans = plans((sql) => sql.includes("bm25("));
        expect(rankedPlans.length).toBe(2);
        for (const plan of rankedPlans) {
            expect(plan).toContain("MATERIALIZE search_rank");
            expect(plan).not.toMatch(/products_fts VIRTUAL TABLE INDEX 0:=/);
            expect(plan).not.toMatch(/SCAN buyer_pricing_sku/);
        }
    });

    it("pages the feed by the stored created_at index and prices only the page", async () => {
        const { db, queries, plans } = setup();
        const first = await getStorefrontFeedProducts(db, { limit: 1 });
        queries.length = 0;
        const second = await getStorefrontFeedProducts(db, { limit: 1, cursor: first.pagination.cursor });

        expect(first.products.map((product) => product.id)).toEqual(["prod_a"]);
        expect(second.products.map((product) => ({ id: product.id, availableForSale: product.availableForSale })))
            .toEqual([{ id: "prod_b", availableForSale: false }]);
        const [pagePlan] = plans((sql) => sql.includes("exclude_from_product_feed"));
        expect(pagePlan).toContain("products_public_newest_idx");
        expect(pagePlan).not.toContain("buyer_ranked_skus");
        for (const plan of plans(joinsPricing)) expect(plan).not.toMatch(/SCAN buyer_pricing_sku/);
    });

    it("resolves attribute filters from the requested values, not from every value row", async () => {
        const { db, plans } = setup();
        sqlite!.exec(`
            INSERT INTO product_attributes (id, name, slug, filterable) VALUES ('attr_brand', 'Brand', 'brand', 1);
            INSERT INTO product_attribute_values (id, product_id, attribute_id, value) VALUES
                ('val_a', 'prod_a', 'attr_brand', 'Asus'),
                ('val_b', 'prod_b', 'attr_brand', 'Lenovo');
        `);

        await expect(resolvePublicAttributeFilters(db, { brand: ["Asus", "Dell"] }, []))
            .resolves.toEqual([{ id: "attr_brand", name: "Brand", slug: "brand", values: ["Asus"] }]);
        const [plan] = plans((sql) => sql.includes("requested_filter"));
        expect(plan).toContain("product_attribute_values_attr_value_product_idx");
        expect(plan).not.toMatch(/SCAN product_attribute_values/);
    });

    it("keeps a 100-card page from 100 categories under D1's 100 bound parameters", async () => {
        const { db, queries } = setup();
        const insertCategory = sqlite!.prepare("INSERT INTO categories (id, name, slug, status) VALUES (?, ?, ?, 'published')");
        const insertProduct = sqlite!.prepare("INSERT INTO products (id, name, price_minor, slug, category_id, is_active) VALUES (?, ?, 10000, ?, ?, 1)");
        const insertSku = sqlite!.prepare("INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory) VALUES (?, ?, ?, 10000, 1, 1, 1)");
        const insertMedia = sqlite!.prepare("INSERT INTO media (id, filename, kind, object_key, size, mime_type, status) VALUES (?, 'x.webp', 'image', ?, 1, 'image/webp', 'ready')");
        const insertProductMedia = sqlite!.prepare("INSERT INTO product_media (id, product_id, media_id, is_primary, sort_order) VALUES (?, ?, ?, 1, 0)");
        for (let index = 0; index < 100; index += 1) {
            insertCategory.run(`cat_many_${index}`, `Many ${index}`, `many-${index}`);
            insertProduct.run(`prod_many_${index}`, `Many ${index}`, `many-product-${index}`, `cat_many_${index}`);
            insertSku.run(`var_many_${index}`, `prod_many_${index}`, `MANY-${index}`);
            insertMedia.run(`med_many_${index}`, `media/many-${index}.webp`);
            insertProductMedia.run(`pmed_many_${index}`, `prod_many_${index}`, `med_many_${index}`);
        }
        await project(db, queries);

        const listing = await getStorefrontProducts(db, { page: 1, limit: 100 });
        const feed = await getStorefrontFeedProducts(db, { limit: 100 });

        expect(new Set(listing.products.map((product) => product.category?.id)).size).toBeGreaterThanOrEqual(99);
        expect(feed.products).toHaveLength(100);
        expect(Math.max(...queries.map((query) => query.params.length))).toBeLessThanOrEqual(100);
    });

    it("reads homepage section lists and their card media scoped to the cards they show", async () => {
        const { db, queries, plans } = setup();
        sqlite!.exec(`
            UPDATE products SET discount_type = 'percentage', discount_bps = 1000 WHERE id = 'prod_b';
            INSERT INTO collections (id, name, presentation, config) VALUES
                ('col_dyn', 'Laptops', 'grid', '{"source":"dynamic","categoryIds":["cat_laptop"],"maxProducts":8}');
        `);
        const home = await getHomepageData(db, {
            requests: {
                lists: [
                    { key: "newest", source: { kind: "newest" }, limit: 2 },
                    { key: "on-sale", source: { kind: "on-sale" }, limit: 4 },
                    { key: "popular", source: { kind: "popular" }, limit: 4 },
                    { key: "category:cat_phone", source: { kind: "category", categoryId: "cat_phone" }, limit: 4 },
                    { key: "collection:col_dyn", source: { kind: "collection", collectionId: "col_dyn" }, limit: 4 },
                ],
                mediaIds: ["med_a"],
            },
        });

        const ids = (key: string) => home.sections.lists.find((list) => list.key === key)?.products.map((product) => product.id);
        expect(ids("newest")).toEqual(["prod_a", "prod_b"]);
        expect(ids("on-sale")).toEqual(["prod_b"]);
        expect(ids("popular")).toEqual([]);
        expect(ids("category:cat_phone")).toEqual(["prod_c"]);
        expect(ids("collection:col_dyn")).toEqual(["prod_a", "prod_b"]);
        expect(home.sections.lists.find((list) => list.key === "newest")?.products[0]?.imageUrl).toContain("media/a.webp");
        const pricingPlans = plans(joinsPricing);
        expect(pricingPlans.length).toBeGreaterThanOrEqual(5);
        for (const plan of pricingPlans) {
            expect(plan).not.toMatch(/SCAN buyer_pricing_sku/);
            expect(plan).not.toMatch(/SCAN (products|product_media|media)\b/);
        }
        for (const plan of plans((sql) => sql.includes("product_media_poster"))) {
            expect(plan).not.toMatch(/SCAN (product_media|media)\b/);
        }
        expect(Math.max(...queries.map((query) => query.params.length))).toBeLessThanOrEqual(90);
    });

    it("finds a rare sale from the discounted-row indexes, never walking the catalogue", async () => {
        const { db, queries, plans } = setup();
        const insertProduct = sqlite!.prepare("INSERT INTO products (id, name, price_minor, slug, is_active, created_at, discount_type, discount_bps) VALUES (?, ?, 10000, ?, 1, ?, 'percentage', ?)");
        const insertSku = sqlite!.prepare("INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory, discount_type, discount_bps, created_at) VALUES (?, ?, ?, 10000, 1, 1, 1, 'percentage', ?, ?)");
        // 300 newer products at full price; the only sales are the oldest two,
        // one discounted on the product and one on its SKU.
        for (let index = 0; index < 300; index += 1) {
            insertProduct.run(`prod_full_${index}`, `Full ${index}`, `full-${index}`, 1_800_000_000 + index, 0);
            insertSku.run(`var_full_${index}`, `prod_full_${index}`, `FULL-${index}`, 0, 1_800_000_000 + index);
        }
        insertProduct.run("prod_sale_product", "Sale on product", "sale-product", 1_600_000_001, 1500);
        insertSku.run("var_sale_product", "prod_sale_product", "SALE-P", 0, 1_600_000_001);
        insertProduct.run("prod_sale_sku", "Sale on SKU", "sale-sku", 1_600_000_000, 0);
        insertSku.run("var_sale_sku", "prod_sale_sku", "SALE-S", 2000, 1_600_000_000);
        queries.length = 0;

        const home = await getHomepageData(db, {
            requests: { lists: [{ key: "on-sale", source: { kind: "on-sale" }, limit: 4 }], mediaIds: [] },
            sectionsOnly: true,
        });

        expect(home.sections.lists[0]?.products.map((product) => product.id)).toEqual(["prod_sale_product", "prod_sale_sku"]);
        const onSalePlans = plans((sql) => sql.includes("sale_sku_product"));
        expect(onSalePlans.length).toBe(2); // the cards and their media
        for (const plan of onSalePlans) {
            expect(plan).toContain("products_on_sale_newest_idx");
            expect(plan).toContain("product_variants_on_sale_newest_idx");
            // Only the partial index is walked (in order, to its window);
            // products are reached by id, never scanned.
            expect(plan).not.toMatch(/SCAN (products|product_variants)$/m);
            expect(plan).not.toMatch(/SEARCH \w+ USING INDEX products_active_idx/);
            expect(plan).not.toContain("products_public_newest_idx");
            expect(plan).not.toMatch(/SCAN buyer_pricing_sku/);
        }
    });

    it("keeps the catalogue's own reads off the on-sale indexes", async () => {
        const { db, plans } = setup();
        await getStorefrontProducts(db, { page: 1, limit: 20, sort: "discount" });
        await getStorefrontProducts(db, { page: 1, limit: 20, hasDiscount: "true" });
        await getStorefrontFeedProducts(db, { limit: 10 });
        await listProducts(db, { page: 1, limit: 2, sort: "name", order: "asc" });
        const all = plans(() => true).join("\n");
        expect(all).not.toContain("products_on_sale_newest_idx");
        expect(all).not.toContain("product_variants_on_sale_newest_idx");
    });

    it("looks SKUs up by their identity index", async () => {
        const { db, plans } = setup();
        const result = await getStorefrontFeedProducts(db, { ids: "sku-b", limit: 10 });

        expect(result.products.map((product) => product.id)).toEqual(["prod_b"]);
        const [lookupPlan] = plans((sql) => sql.includes("lookup_sku"));
        expect(lookupPlan).toContain("product_variants_sku_identity_uidx");
        expect(lookupPlan).not.toMatch(/SCAN lookup_sku/);
    });
});
