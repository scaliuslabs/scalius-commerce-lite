import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, describe, expect, it } from "vitest";

import { resolvePublicAttributeFilters } from "../attributes/attributes.public";
import { resolveCollectionProductsBatch } from "../collections/collections.service";
import { search } from "../../search";
import { getProductsByIds, listProducts } from "../products/admin/read";
import {
    getStorefrontCategoryProducts,
    getStorefrontCollectionProducts,
    getStorefrontProducts,
} from "./listing";
import { getStorefrontFeedProducts } from "./feed";

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

describe("catalogue-scale query plans", () => {
    it("ranks only the category's SKUs for a category listing", async () => {
        const { db, plans } = setup();
        const result = await getStorefrontCategoryProducts(db, {
            id: "cat_laptop", name: "Laptop", slug: "laptop", description: null, imageUrl: null,
            metaTitle: null, metaDescription: null, canonicalPath: null, noIndex: false,
            excludeFromSitemap: false, createdAt: null, updatedAt: null,
        }, { page: 1, limit: 20 });

        expect(result.products.map((product) => product.id)).toEqual(["prod_a", "prod_b"]);
        const pricingPlans = plans(joinsPricing);
        expect(pricingPlans.length).toBeGreaterThan(0);
        for (const plan of pricingPlans) expect(plan).not.toMatch(/SCAN buyer_pricing_sku/);
    });

    it("drives collection membership from its product and category sets", async () => {
        const { db, plans } = setup();
        const result = await getStorefrontCollectionProducts(db, {
            productIds: ["prod_c"],
            categoryIds: ["cat_laptop"],
        }, { page: 1, limit: 20 });

        expect(result.products.map((product) => product.id).sort()).toEqual(["prod_a", "prod_b", "prod_c"]);
        const pricingPlans = plans(joinsPricing);
        for (const plan of pricingPlans) {
            expect(plan).not.toMatch(/SCAN buyer_pricing_sku/);
            expect(plan).not.toMatch(/SCAN collection_membership/);
        }
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
        const { db, plans } = setup();
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

        const listing = await getStorefrontProducts(db, { page: 1, limit: 100 });
        const feed = await getStorefrontFeedProducts(db, { limit: 100 });

        expect(new Set(listing.products.map((product) => product.category?.id)).size).toBeGreaterThanOrEqual(99);
        expect(feed.products).toHaveLength(100);
        expect(Math.max(...queries.map((query) => query.params.length))).toBeLessThanOrEqual(100);
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
