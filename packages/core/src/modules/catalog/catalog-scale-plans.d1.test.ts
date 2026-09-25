import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, describe, expect, it } from "vitest";

import { resolvePublicAttributeFilters } from "./facets";
import { resolveCollectionProductsBatch } from "../collections/collections.service";
import { search } from "../../search";
import { getHomepageData } from "../storefront/storefront.service";
import { getProductsByIds, listProducts } from "../products/admin/read";
import {
    getStorefrontBrandProducts,
    getStorefrontCategoryProducts,
    getStorefrontCollectionProducts,
    getStorefrontProducts,
} from "./listing";
import { getStorefrontFeedProducts } from "./feed";
import { getStorefrontSitemapProducts } from "./sitemap";
import { getStorefrontProductComparison } from "./compare";
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
            excludeFromSitemap: false, createdAt: null,
        }, { page: 1, limit: 20 });

        expect(result.products.map((product) => product.id)).toEqual(["prod_a", "prod_b"]);
        const statePlans = plans(readsBuyerState);
        expect(statePlans.length).toBeGreaterThanOrEqual(3); // page, count, the facet counts
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

    it("reads a brand page and a category subtree from the buyer state's brand and category indexes", async () => {
        const { db, queries, plans } = setup();
        sqlite!.exec(`
            INSERT INTO brands (id, name, slug, status) VALUES ('brd_asus0001', 'Asus', 'asus', 'published');
            UPDATE products SET brand_id = 'brd_asus0001' WHERE id IN ('prod_a', 'prod_c');
            INSERT INTO categories (id, name, slug, status, parent_id) VALUES ('cat_gaming', 'Gaming', 'gaming', 'published', 'cat_laptop');
            UPDATE products SET category_id = 'cat_gaming' WHERE id = 'prod_b';
        `);
        await project(db, queries);
        const brand = await getStorefrontBrandProducts(db, { id: "brd_asus0001" }, { page: 1, limit: 20 });
        const brandPlans = plans(readsBuyerState);
        queries.length = 0;
        const laptop = {
            id: "cat_laptop", name: "Laptop", slug: "laptop", description: null, imageUrl: null,
            metaTitle: null, metaDescription: null, canonicalPath: null, noIndex: false,
            excludeFromSitemap: false, createdAt: null, updatedAt: null,
        };
        const subtree = await getStorefrontCategoryProducts(db, laptop, { page: 1, limit: 20 }, { includeDescendants: true });
        const subtreePlans = plans(readsBuyerState);

        expect(brand.products.map((product) => product.id)).toEqual(["prod_a", "prod_c"]);
        expect(subtree.products.map((product) => [product.id, product.category?.id])).toEqual([
            ["prod_a", "cat_laptop"],
            ["prod_b", "cat_gaming"],
        ]);
        for (const plan of brandPlans) {
            expect(plan).toContain("product_buyer_state_brand_newest_idx (is_public=? AND brand_id=?)");
            expectBuyerStateListing(plan);
        }
        for (const plan of subtreePlans) {
            expect(plan).toContain("product_buyer_state_category_newest_idx (is_public=? AND category_id=?)");
            expect(plan).not.toMatch(/SCAN (subtree|category_closure)\b/);
            expectBuyerStateListing(plan);
        }
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
            INSERT INTO product_attributes (id, name, slug, filterable) VALUES ('attr_maker', 'Maker', 'maker', 1);
            INSERT INTO product_attribute_values (id, product_id, attribute_id, value) VALUES ('val_a', 'prod_a', 'attr_maker', 'Asus');
        `);
        await project(db, queries);
        const small = await getStorefrontProducts(db, { page: 1, limit: 2 });
        // The shop-all categories the products sit in come first (the category-tree facet).
        expect(small.facets.map((facet) => facet.slug)).toEqual(["category", "maker"]);
        expect(queries.filter((query) => query.sql.includes("product_facet_values")).length).toBe(1);

        // 2,001 public products: the unscoped count stops at the limit and the
        // facet statement never runs; a category still counts its own.
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
        expect(queries.filter((query) => query.sql.includes("product_facet_values"))).toEqual([]);
        const scoped = await getStorefrontProducts(db, { page: 1, limit: 2, category: "laptop" });
        expect(scoped.facets.map((facet) => facet.slug)).toEqual(["maker"]);
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
        expect(popularPlans.length).toBe(3); // the cards, their media and the members the list depends on
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

    it("resolves facet filters by slug, enum value and brand slug indexes in one statement", async () => {
        const { db, queries, plans } = setup();
        sqlite!.exec(`
            INSERT INTO brands (id, name, slug, status) VALUES ('brd_asus0001', 'Asus', 'asus', 'published');
            INSERT INTO product_attributes (id, name, slug, filterable, value_type) VALUES
                ('attr_ram', 'RAM', 'ram', 1, 'enum'),
                ('attr_display', 'Display', 'display', 1, 'number');
            INSERT INTO attribute_values (id, attribute_id, value, normalized_value) VALUES
                ('atv_ram00008', 'attr_ram', '8GB', '8gb');
        `);

        await expect(resolvePublicAttributeFilters(db, {
            ram: ["8GB", "64GB"],
            "display.min": ["13"],
            brand: ["Asus", "dell"],
        }, [])).resolves.toEqual([
            { kind: "brand", id: "brand", name: "Brand", slug: "brand", values: ["asus"], labels: ["Asus"], keys: ["brd_asus0001"] },
            { kind: "attribute", id: "attr_ram", name: "RAM", slug: "ram", values: ["8gb"], labels: ["8GB"], keys: ["atv_ram00008"] },
            { kind: "attribute", id: "attr_display", name: "Display", slug: "display", values: [], labels: [], keys: [], range: { min: 13, max: null } },
        ]);
        expect(queries).toHaveLength(1);
        const [plan] = plans(() => true);
        expect(plan).toContain("SEARCH product_attributes USING INDEX product_attributes_slug_unique (slug=?)");
        expect(plan).toContain("SEARCH brands USING INDEX brands_slug_unique (slug=?)");
        expect(plan).toContain("SEARCH attribute_values USING INDEX");
        expect(plan).not.toMatch(/SCAN (product_attributes|attribute_values|brands|product_attribute_values)\b/);
    });

    it("filters and counts a category's facets by probing the facet rows of its own products", async () => {
        const { db, queries, plans } = setup();
        sqlite!.exec(`
            INSERT INTO brands (id, name, slug, status) VALUES ('brd_asus0001', 'Asus', 'asus', 'published');
            UPDATE products SET brand_id = 'brd_asus0001' WHERE id = 'prod_a';
            INSERT INTO product_attributes (id, name, slug, filterable, value_type, facet_display, unit) VALUES
                ('attr_ram', 'RAM', 'ram', 1, 'text', 'checkbox', NULL),
                ('attr_display', 'Display', 'display', 1, 'number', 'range', 'in');
            INSERT INTO product_attribute_values (id, product_id, attribute_id, value, value_number) VALUES
                ('val_ram_a', 'prod_a', 'attr_ram', '8GB', NULL),
                ('val_ram_b', 'prod_b', 'attr_ram', '16GB', NULL),
                ('val_display_a', 'prod_a', 'attr_display', '15.6 in', 15.6),
                ('val_display_b', 'prod_b', 'attr_display', '14 in', 14);
            INSERT INTO category_attribute_sets (category_id, attribute_id, sort_order) VALUES
                ('cat_laptop', 'attr_ram', 0), ('cat_laptop', 'attr_display', 1);
        `);
        await project(db, queries);
        const filters = await resolvePublicAttributeFilters(db, { ram: ["8gb"], "display.min": ["13"], brand: ["asus"] }, []);
        queries.length = 0;
        const result = await getStorefrontCategoryProducts(db, {
            id: "cat_laptop", name: "Laptop", slug: "laptop", description: null, imageUrl: null,
            metaTitle: null, metaDescription: null, canonicalPath: null, noIndex: false,
            excludeFromSitemap: false, createdAt: null,
        }, { page: 1, limit: 20, attributeFilters: filters });

        expect(result.products.map((product) => product.id)).toEqual(["prod_a"]);
        // Brand first, then the category's spec order.
        expect(result.facets.map((facet) => [facet.slug, facet.display])).toEqual([
            ["brand", "checkbox"], ["ram", "checkbox"], ["display", "range"],
        ]);
        expect(result.facets.find((facet) => facet.slug === "ram")?.values).toEqual([
            { value: "8gb", label: "8GB", count: 1, swatch: null },
            { value: "16gb", label: "16GB", count: 0, swatch: null },
        ]);
        expect(result.facets.find((facet) => facet.slug === "display"))
            .toMatchObject({ unit: "in", values: [], range: { min: 15.6, max: 15.6 } });
        const statePlans = plans(readsBuyerState);
        expect(statePlans).toHaveLength(3); // page, count + price range, every facet
        for (const plan of statePlans) {
            expect(plan).toContain("product_buyer_state_category_newest_idx (is_public=? AND category_id=?)");
            expect(plan).not.toContain("product_buyer_state_brand_newest_idx");
            expect(plan).not.toMatch(/SCAN (product_facet_values|attribute_row|option_row|attribute_selected_row|range_selected_row|option_selected_row|option_sku)\b/);
            expect(plan).not.toMatch(/SCAN product_attribute_values\b/);
            expectBuyerStateListing(plan);
        }
        expect(statePlans.join("\n"))
            .toContain("SEARCH attribute_selected_row USING INDEX sqlite_autoindex_product_facet_values_1 (owner_id=? AND facet_key=?)");
        expect(Math.max(...queries.map((query) => query.params.length))).toBeLessThanOrEqual(90);
    });

    it("drives option filters from the product's own SKU facet rows", async () => {
        const { db, queries, plans } = setup();
        sqlite!.exec(`
            INSERT INTO product_option_definitions (id, product_id, name, normalized_name, position) VALUES ('axis_a', 'prod_a', 'RAM', 'ram', 0);
            INSERT INTO product_option_values (id, option_definition_id, value, normalized_value, position) VALUES ('ov_a8', 'axis_a', '8GB', '8gb', 0);
            UPDATE product_variants SET deleted_at = unixepoch() WHERE id = 'var_a';
            INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory, option_combination_key) VALUES
                ('var_a8', 'prod_a', 'SKU-A8', 5000000, 1, 0, 1, 'ov_a8');
            INSERT INTO product_variant_option_values (variant_id, option_definition_id, option_value_id) VALUES ('var_a8', 'axis_a', 'ov_a8');
        `);
        await project(db, queries);
        const filters = await resolvePublicAttributeFilters(db, { "option.ram": ["8GB"] }, []);
        queries.length = 0;
        const result = await getStorefrontProducts(db, { page: 1, limit: 20, category: "laptop", attributeFilters: filters });

        expect(result.products.map((product) => product.id)).toEqual(["prod_a"]);
        expect(result.facets).toEqual([{
            id: "option.ram", name: "RAM", slug: "option.ram", kind: "option", display: "checkbox", unit: null, range: null,
            values: [{ value: "8gb", label: "8GB", count: 1, swatch: null }],
        }]);
        const joined = plans(readsBuyerState).join("\n");
        // Either facet index answers (product, axis, value) with three equalities.
        expect(joined).toMatch(/SEARCH option_sku (EXISTS )?USING INDEX product_facet_values_(product_idx \(product_id=\? AND facet_key=\? AND value_key=\?|value_idx \(facet_key=\? AND value_key=\? AND product_id=\?)\)/);
        expect(joined).toContain("SEARCH option_row USING INDEX product_facet_values_product_idx (product_id=? AND facet_key>? AND facet_key<?)");
        expect(joined).not.toMatch(/SCAN (product_facet_values|option_row|option_sku|option_selected_row|product_variant_option_values)\b/);
    });

    it("compares products by primary key and their specs by product index, in one wave", async () => {
        const { db, queries, plans } = setup();
        sqlite!.exec(`
            INSERT INTO attribute_groups (id, name, sort_order) VALUES ('atg_display01', 'Display', 0);
            INSERT INTO product_attributes (id, name, slug, filterable, group_id, key_spec) VALUES ('attr_screen', 'Screen', 'screen', 1, 'atg_display01', 1);
            INSERT INTO product_attribute_values (id, product_id, attribute_id, value) VALUES
                ('val_screen_a', 'prod_a', 'attr_screen', '15.6 in'),
                ('val_screen_c', 'prod_c', 'attr_screen', '6.7 in');
        `);
        await project(db, queries);
        const result = await getStorefrontProductComparison(db, ["prod_c", "prod_missing", "prod_a"]);

        expect(result.products.map((product) => product.id)).toEqual(["prod_c", "prod_a"]);
        expect(result.groups).toEqual([{
            id: "atg_display01",
            name: "Display",
            rows: [{ attributeId: "attr_screen", name: "Screen", slug: "screen", unit: null, keySpec: true, highlight: false, values: ["6.7 in", "15.6 in"] }],
        }]);
        expect(queries).toHaveLength(3);
        for (const plan of plans(() => true)) {
            expect(plan).not.toMatch(/SCAN (products|product_buyer_state|product_attribute_values|product_media|media)\b/);
        }
        expect(plans((sql) => sql.includes("product_attribute_values"))[0])
            .toContain("product_attribute_values_product_id_attribute_id_unique (product_id=?)");
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
        // Newest and category lists take their members from the buyer state.
        await project(db, queries);
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
        // Newest and category members walk the buyer state's newest indexes.
        const memberPlans = plans((sql) => sql.startsWith('select "product_id" from "product_buyer_state"'));
        expect(memberPlans).toHaveLength(2);
        for (const plan of memberPlans) {
            expect(plan).toMatch(/product_buyer_state_(category_)?newest_idx/);
            expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
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
        expect(onSalePlans.length).toBe(3); // the cards, their media and the candidate window
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

    // Wave B R9: listing rating sort, filter, facet and card ratings read only
    // `product_review_stats`, by primary key after the listing's own index.
    // Stats rows are written directly here (the review triggers that own them
    // are covered in packages/database and listing-rating.d1.test.ts).
    const insertStats = (productId: string, fives: number, fours: number) => sqlite!
        .prepare(`INSERT INTO product_review_stats
            (product_id, review_count, rating_sum, count_4, count_5, rating_avg_centi, rating_rank_milli)
            VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(productId, fives + fours, 5 * fives + 4 * fours, fours, fives,
            Math.floor(((5 * fives + 4 * fours) * 100) / (fives + fours)),
            Math.floor(((5 * fives + 4 * fours + 15) * 1000) / (fives + fours + 5)));
    const neverReadsReviews = (queries: Captured[], statementPlans: string[]) => {
        for (const query of queries) expect(query.sql).not.toMatch(/\bproduct_reviews\b/);
        for (const plan of statementPlans) {
            expect(plan).not.toMatch(/SCAN (product_review_stats|facet_rating|rating_filter)\b/);
            // The stats never drive a listing: no walk of their rank or average index.
            expect(plan).not.toMatch(/product_review_stats_(rank|avg)_idx/);
        }
    };
    const laptopCategory = {
        id: "cat_laptop", name: "Laptop", slug: "laptop", description: null, imageUrl: null,
        metaTitle: null, metaDescription: null, canonicalPath: null, noIndex: false,
        excludeFromSitemap: false, createdAt: null, updatedAt: null,
    };

    it("sorts, filters and counts a category by rating from the stats by primary key, never the reviews", async () => {
        const { db, queries, plans } = setup();
        sqlite!.exec(`
            INSERT INTO brands (id, name, slug, status) VALUES ('brd_asus0001', 'Asus', 'asus', 'published');
            UPDATE products SET brand_id = 'brd_asus0001' WHERE id IN ('prod_a', 'prod_b');
        `);
        insertStats("prod_a", 1, 0); // 5.00, rank 3333
        insertStats("prod_c", 8, 2); // 4.80, rank 4200
        await project(db, queries);

        const sorted = await getStorefrontCategoryProducts(db, laptopCategory, { page: 1, limit: 20, sort: "rating" });
        const sortedPlans = plans(readsBuyerState);
        const sortedQueries = [...queries];
        queries.length = 0;
        const filtered = await getStorefrontCategoryProducts(db, laptopCategory, { page: 1, limit: 20, sort: "rating", minRating: 4 });
        const filteredPlans = plans(readsBuyerState);
        const filteredQueries = [...queries];

        expect(sorted.products.map((product) => [product.id, product.rating])).toEqual([
            ["prod_a", { average: 5, count: 1 }],
            ["prod_b", null],
        ]);
        expect(filtered.products.map((product) => product.id)).toEqual(["prod_a"]);
        expect(filtered.ratingFacet).toEqual([{ min: 4, count: 1 }, { min: 3, count: 1 }, { min: 2, count: 1 }]);
        expect(filtered.facets.find((facet) => facet.slug === "brand")?.values.map(({ count }) => count)).toEqual([1]);
        // Still page, count + price range, and every facet (rating included): no new statement.
        expect(sortedPlans).toHaveLength(3);
        expect(filteredPlans).toHaveLength(3);
        for (const plan of [...sortedPlans, ...filteredPlans]) {
            expect(plan).toContain("product_buyer_state_category_newest_idx (is_public=? AND category_id=?)");
            expectBuyerStateListing(plan);
        }
        const joined = [...sortedPlans, ...filteredPlans].join("\n");
        expect(joined).toContain("SEARCH product_review_stats USING INDEX sqlite_autoindex_product_review_stats_1 (product_id=?) LEFT-JOIN");
        expect(joined).toContain("SEARCH facet_rating USING INDEX sqlite_autoindex_product_review_stats_1 (product_id=?) LEFT-JOIN");
        expect(filteredPlans.join("\n"))
            .toContain("SEARCH rating_filter EXISTS USING INDEX sqlite_autoindex_product_review_stats_1 (product_id=?)");
        neverReadsReviews([...sortedQueries, ...filteredQueries], [...sortedPlans, ...filteredPlans]);
        expect(Math.max(...filteredQueries.map((query) => query.params.length))).toBeLessThanOrEqual(90);
    });

    it("sorts shop-all, a subtree, a brand and a collection by rating, and rates homepage cards, by primary key", async () => {
        const { db, queries, plans } = setup();
        sqlite!.exec(`
            INSERT INTO brands (id, name, slug, status) VALUES ('brd_asus0001', 'Asus', 'asus', 'published');
            UPDATE products SET brand_id = 'brd_asus0001';
            INSERT INTO categories (id, name, slug, status, parent_id) VALUES ('cat_gaming', 'Gaming', 'gaming', 'published', 'cat_laptop');
            UPDATE products SET category_id = 'cat_gaming' WHERE id = 'prod_b';
        `);
        insertStats("prod_a", 1, 0);
        insertStats("prod_c", 8, 2);
        insertStats("prod_b", 2, 3); // 4.40, rank 3700
        await project(db, queries);

        const shopAll = await getStorefrontProducts(db, { page: 1, limit: 2, sort: "rating" });
        const subtree = await getStorefrontCategoryProducts(db, laptopCategory, { page: 1, limit: 20, sort: "rating" }, { includeDescendants: true });
        const brand = await getStorefrontBrandProducts(db, { id: "brd_asus0001" }, { page: 1, limit: 20, sort: "rating", minRating: 4 });
        const collection = await getStorefrontCollectionProducts(db, { productIds: ["prod_a"], categoryIds: ["cat_gaming"] }, { page: 1, limit: 20, sort: "rating" });
        const listingPlans = plans(readsBuyerState);
        const listingQueries = [...queries];
        queries.length = 0;
        const home = await getHomepageData(db, {
            requests: { lists: [{ key: "newest", source: { kind: "newest" }, limit: 4 }], mediaIds: [] },
            sectionsOnly: true,
        });
        const cardPlans = plans(joinsPricing);

        expect(shopAll.products.map((product) => product.id)).toEqual(["prod_c", "prod_b"]);
        expect(shopAll.pagination.total).toBe(3);
        expect(subtree.products.map((product) => product.id)).toEqual(["prod_b", "prod_a"]);
        expect(brand.products.map((product) => product.id)).toEqual(["prod_c", "prod_b", "prod_a"]);
        expect(brand.ratingFacet).toEqual([{ min: 4, count: 3 }, { min: 3, count: 3 }, { min: 2, count: 3 }]);
        expect(collection.products.map((product) => product.id)).toEqual(["prod_b", "prod_a"]);
        expect(home.sections.lists[0]?.products.map((product) => [product.id, product.rating?.count ?? null]))
            .toEqual([["prod_a", 1], ["prod_b", 5], ["prod_c", 10]]);
        for (const plan of listingPlans) expectBuyerStateListing(plan);
        const joined = listingPlans.join("\n");
        expect(joined).toContain("SEARCH product_buyer_state USING INDEX product_buyer_state_brand_newest_idx (is_public=? AND brand_id=?)");
        expect(joined).toContain("SEARCH collection_member USING COVERING INDEX product_buyer_state_category_newest_idx");
        expect(cardPlans.length).toBeGreaterThanOrEqual(1);
        for (const plan of cardPlans) {
            expect(plan).toContain("SEARCH product_review_stats USING INDEX sqlite_autoindex_product_review_stats_1 (product_id=?)");
            expect(plan).not.toMatch(/SCAN buyer_pricing_sku/);
        }
        neverReadsReviews([...listingQueries, ...queries], [...listingPlans, ...cardPlans]);
    });

    it("keeps a rating sort, filter and facet over a 3,000-product category bounded by the category", async () => {
        const { db, queries, plans } = setup();
        const insertProduct = sqlite!.prepare("INSERT INTO products (id, name, price_minor, slug, category_id, is_active, created_at) VALUES (?, ?, 10000, ?, ?, 1, ?)");
        const insertSku = sqlite!.prepare("INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory) VALUES (?, ?, ?, 10000, 1, 1, 0)");
        sqlite!.exec("INSERT INTO categories (id, name, slug, status) VALUES ('cat_bulk', 'Bulk', 'bulk', 'published')");
        sqlite!.exec("BEGIN");
        for (let index = 0; index < 3_000; index += 1) {
            // 2,000 in the bulk category, 1,000 elsewhere; half of each reviewed.
            insertProduct.run(`prod_bulk_${index}`, `Bulk ${index}`, `bulk-${index}`, index % 3 === 2 ? "cat_phone" : "cat_bulk", 1_600_000_000 + index);
            insertSku.run(`var_bulk_${index}`, `prod_bulk_${index}`, `BULK-${index}`);
            if (index % 2 === 0) insertStats(`prod_bulk_${index}`, index % 7, 1 + (index % 5));
        }
        sqlite!.exec("COMMIT");
        await project(db, queries);
        const bulk = { ...laptopCategory, id: "cat_bulk", name: "Bulk", slug: "bulk" };

        const started = performance.now();
        const sorted = await getStorefrontCategoryProducts(db, bulk, { page: 1, limit: 20, sort: "rating", minRating: 4 });
        const categoryMs = performance.now() - started;
        const categoryPlans = plans(readsBuyerState);
        const categoryQueries = [...queries];
        queries.length = 0;
        const shopStarted = performance.now();
        const shopAll = await getStorefrontProducts(db, { page: 3, limit: 20, sort: "rating" });
        const shopAllMs = performance.now() - shopStarted;

        const expected = sqlite!.prepare(`SELECT s.product_id FROM product_review_stats s
            JOIN products p ON p.id = s.product_id
            WHERE p.category_id = 'cat_bulk' AND s.rating_avg_centi >= 400
            ORDER BY s.rating_rank_milli DESC, s.review_count DESC, p.created_at DESC, p.id LIMIT 20`).all()
            .map((row) => row.product_id);
        expect(sorted.products.map((product) => product.id)).toEqual(expected);
        expect(sorted.ratingFacet.map((value) => value.min)).toEqual([4, 3, 2]);
        expect(shopAll.products).toHaveLength(20);
        expect(shopAll.facets).toEqual([]); // above the shop-all live-facet cap
        expect(shopAll.ratingFacet).toEqual([]);
        for (const plan of categoryPlans) {
            expect(plan).toContain("product_buyer_state_category_newest_idx (is_public=? AND category_id=?)");
            expectBuyerStateListing(plan);
        }
        neverReadsReviews([...categoryQueries, ...queries], [...categoryPlans, ...plans(readsBuyerState)]);
        // Local SQLite; a scan of product_reviews or a stats-driven walk shows up as seconds here.
        expect(categoryMs).toBeLessThan(1_500);
        expect(shopAllMs).toBeLessThan(1_500);
    }, 60_000);

    it("looks SKUs up by their identity index", async () => {
        const { db, plans } = setup();
        const result = await getStorefrontFeedProducts(db, { ids: "sku-b", limit: 10 });

        expect(result.products.map((product) => product.id)).toEqual(["prod_b"]);
        const [lookupPlan] = plans((sql) => sql.includes("lookup_sku"));
        expect(lookupPlan).toContain("product_variants_sku_identity_uidx");
        expect(lookupPlan).not.toMatch(/SCAN lookup_sku/);
    });
});
