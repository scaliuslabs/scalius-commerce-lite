import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { planLimits } from "@scalius/shared/plan-limits";
import { rebuildCatalogProjections } from "../products/catalog-projections";
import { compareSqliteValues } from "../../testing/keyset-walk";
import { getStorefrontCategoryProducts, getStorefrontProducts } from "./listing";

type Captured = { sql: string; params: readonly SQLInputValue[] };

const PLANS = ["free", "paid"] as const;

/** Runs the describe's tests under one plan profile and returns that plan's list limits. */
function useProfile(plan: (typeof PLANS)[number]) {
    beforeEach(() => vi.stubGlobal("__SCALIUS_PLAN__", plan));
    afterEach(() => vi.unstubAllGlobals());
    return planLimits(plan).lists;
}

let sqlite: DatabaseSync | null = null;
afterEach(() => {
    sqlite?.close();
    sqlite = null;
});

interface Seeded {
    id: string;
    createdAt: number;
    price: number;
}

/**
 * `count` single-SKU products in one published category, with ties on both
 * the created time and the price so the id decides the order inside a tie.
 */
async function setup(count: number) {
    const queries: Captured[] = [];
    const harness = createSqliteD1Database({ onQuery: (sql, params) => queries.push({ sql, params }) });
    sqlite = harness.sqlite;
    sqlite.exec(`
        INSERT INTO categories (id, name, slug, status) VALUES ('cat_all', 'Everything', 'everything', 'published');
        WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < ${count - 1})
        INSERT INTO products (id, name, price_minor, slug, category_id, is_active, created_at)
            SELECT 'prd_' || printf('%05d', n), 'Product ' || n, 1000 + (n * 7 % 9) * 500, 'product-' || n,
                   'cat_all', 1, 1700000000 + (n % 11) * 60
            FROM seq;
        INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory)
            SELECT 'var_' || id, id, 'SKU-' || id, price_minor, 5, 1, 1 FROM products;
    `);
    const rows: Seeded[] = (sqlite.prepare("SELECT id, created_at AS createdAt, price_minor AS price FROM products").all() as unknown as Seeded[]);
    let cursor: string | null = null;
    for (;;) {
        const chunk: { done: boolean; nextAfterProductId: string | null } = await rebuildCatalogProjections(harness.db, { afterProductId: cursor });
        if (chunk.done) break;
        cursor = chunk.nextAfterProductId;
    }
    queries.length = 0;
    return { db: harness.db, queries, rows };
}

const SORTS = {
    newest: (a: Seeded, b: Seeded) => compareSqliteValues(b.createdAt, a.createdAt) || compareSqliteValues(a.id, b.id),
    "price-asc": (a: Seeded, b: Seeded) => compareSqliteValues(a.price, b.price) || compareSqliteValues(a.id, b.id),
    "price-desc": (a: Seeded, b: Seeded) => compareSqliteValues(b.price, a.price) || compareSqliteValues(a.id, b.id),
} as const;

const category = {
    id: "cat_all", name: "Everything", slug: "everything", description: null, imageUrl: null,
    metaTitle: null, metaDescription: null, canonicalPath: null, noIndex: false,
    excludeFromSitemap: false, createdAt: null,
};

describe.each(PLANS)("storefront listing cursors on the %s plan", (plan) => {
    const lists = useProfile(plan);

    for (const sort of Object.keys(SORTS) as Array<keyof typeof SORTS>) {
        it(`walks every product exactly once by ${sort}, shop-wide and in a category`, async () => {
            const { db, rows } = await setup(53);
            const expected = [...rows].sort(SORTS[sort]).map((row) => row.id);
            for (const read of [
                (cursor?: string) => getStorefrontProducts(db, { limit: 7, sort, cursor }),
                (cursor?: string) => getStorefrontCategoryProducts(db, category, { limit: 7, sort, cursor }),
            ]) {
                const seen: string[] = [];
                let cursor: string | undefined;
                let pages = 0;
                for (;;) {
                    const result = await read(cursor);
                    seen.push(...result.products.map((product) => product.id));
                    pages += 1;
                    expect(result.pagination.page).toBe(cursor ? 0 : 1);
                    if (!result.pageInfo.hasNextPage) {
                        expect(result.pageInfo.endCursor).toEqual(expect.any(String));
                        break;
                    }
                    cursor = result.pageInfo.endCursor!;
                    expect(pages).toBeLessThan(20);
                }
                expect(seen).toEqual(expected);
                expect(pages).toBe(Math.ceil(53 / 7));
            }
        });
    }

    it("continues a numbered page with the cursor it returns", async () => {
        const { db, rows } = await setup(40);
        const expected = [...rows].sort(SORTS["price-asc"]).map((row) => row.id);
        const second = await getStorefrontProducts(db, { page: 2, limit: 10, sort: "price-asc" });
        expect(second.products.map((product) => product.id)).toEqual(expected.slice(10, 20));
        expect(second.pageInfo.hasNextPage).toBe(true);
        const third = await getStorefrontProducts(db, { limit: 10, sort: "price-asc", cursor: second.pageInfo.endCursor! });
        expect(third.products.map((product) => product.id)).toEqual(expected.slice(20, 30));
        // The last page has no next page, even when it is exactly full.
        const last = await getStorefrontProducts(db, { page: 4, limit: 10, sort: "price-asc" });
        expect(last.pageInfo.hasNextPage).toBe(false);
    });

    it("never previews shelves on a cursor page", async () => {
        const { db, rows } = await setup(45);
        const options = { includeDescendants: true, shelfPreview: true, shelfChildIds: ["cat_all"] } as const;
        const first = await getStorefrontCategoryProducts(db, category, { limit: 20 }, options);
        expect(first.shelfProducts.length).toBeGreaterThan(0);
        const next = await getStorefrontCategoryProducts(db, category, { limit: 20, cursor: first.pageInfo.endCursor! }, options);
        expect(next.shelfProducts).toEqual([]);
        expect(next.products.map((product) => product.id)).toEqual(
            [...rows].sort(SORTS.newest).map((row) => row.id).slice(20, 40),
        );
    });

    it("rejects a cursor for another order, an unsupported order or a numbered page", async () => {
        const { db } = await setup(20);
        const cursor = (await getStorefrontProducts(db, { limit: 5, sort: "price-asc" })).pageInfo.endCursor!;
        const bad = async (params: Parameters<typeof getStorefrontProducts>[1]) =>
            expect(getStorefrontProducts(db, params)).rejects.toMatchObject({ status: 400, code: "invalid_cursor" });
        await bad({ sort: "price-desc", cursor });
        await bad({ sort: "newest", cursor });
        await bad({ sort: "name-asc", cursor });
        await bad({ sort: "discount", cursor });
        await bad({ sort: "rating", cursor });
        await bad({ search: "Product", cursor });
        await bad({ sort: "price-asc", cursor: "garbage!" });
        await bad({ sort: "price-asc", cursor, page: 2 });
    });

    it("answers a page past the offset bound with an empty page the storefront turns into a 404, reading no rows for it", async () => {
        const { db, queries } = await setup(30);
        const limit = 20;
        const page = lists.maxOffset / limit + 1;
        const deep = await getStorefrontProducts(db, { page, limit });
        expect(deep.products).toEqual([]);
        expect(deep.pageInfo).toEqual({ hasNextPage: false, endCursor: null });
        // The storefront treats `page > totalPages` as a missing page (404).
        expect(deep.pagination.page).toBe(page);
        expect(deep.pagination.page).toBeGreaterThan(Math.max(1, deep.pagination.totalPages));
        expect(queries.some(({ sql, params }) => / offset \?/i.test(sql) && params.at(-1) === lists.maxOffset)).toBe(false);
        // The last page inside the bound still reads.
        const inside = await getStorefrontProducts(db, { page: lists.maxOffset / limit, limit });
        expect(inside.products).toEqual([]);
        expect(queries.some(({ sql, params }) => / offset \?/i.test(sql) && params.at(-1) === lists.maxOffset - limit)).toBe(true);
    });
});

describe.each(PLANS)("storefront listing totals on the %s plan", (plan) => {
    const lists = useProfile(plan);
    const productCount = 1_100;

    it("caps the shop-wide total, reads the count and the price range through bounded probes, and keeps the price range exact", async () => {
        const { db, queries, rows } = await setup(productCount);
        const result = await getStorefrontProducts(db, { limit: 20 });
        const capped = productCount > lists.countCap;
        expect(result.pagination).toMatchObject({
            total: Math.min(productCount, lists.countCap),
            totalIsCapped: capped,
            totalPages: Math.ceil(Math.min(productCount, lists.countCap) / 20),
        });
        expect(result.pageInfo.hasNextPage).toBe(true);
        // MIN/MAX keep their meaning: the cheapest and dearest buyer price in the whole catalogue.
        const prices = rows.map((row) => row.price / 100);
        expect(result.priceRange).toEqual({ min: Math.min(...prices), max: Math.max(...prices) });

        const counts = queries.filter(({ sql }) => /capped_rows/.test(sql));
        expect(counts).toHaveLength(1);
        expect(counts[0]!.sql).toContain(`LIMIT ${lists.countCap + 1}) AS capped_rows`);
        // The shop-wide statement counts nothing with a bare count(*).
        const shopWide = queries.filter(({ sql }) => /from \(SELECT 1\) AS shop_all_probe|shop_all_probe/.test(sql));
        expect(shopWide).toHaveLength(1);
        expect(shopWide[0]!.sql).not.toMatch(/count\(\*\) *,|, *count\(\*\)/);
    });

    it("caps a category's total where it is reported and keeps its price range exact", async () => {
        const { db, rows } = await setup(productCount);
        const result = await getStorefrontCategoryProducts(db, category, { limit: 20 });
        expect(result.pagination).toMatchObject({
            total: Math.min(productCount, lists.countCap),
            totalIsCapped: productCount > lists.countCap,
        });
        const prices = rows.map((row) => row.price / 100);
        expect(result.priceRange).toEqual({ min: Math.min(...prices), max: Math.max(...prices) });
    });

    it("is exact below the cap", async () => {
        const { db } = await setup(37);
        const shop = await getStorefrontProducts(db, { limit: 20 });
        expect(shop.pagination).toMatchObject({ total: 37, totalIsCapped: false, totalPages: 2 });
        expect((await getStorefrontCategoryProducts(db, category, { limit: 20 })).pagination)
            .toMatchObject({ total: 37, totalIsCapped: false });
        // A filter narrows the same scan: its total is exact too.
        const filtered = await getStorefrontProducts(db, { limit: 20, minPrice: 40 });
        expect(filtered.pagination.totalIsCapped).toBe(false);
    });
});

describe("storefront listing statements", () => {
    it("keeps the cursor page on the buyer state's own index, never a scan", async () => {
        const { db, queries } = await setup(40);
        const first = await getStorefrontProducts(db, { limit: 10, sort: "newest" });
        queries.length = 0;
        await getStorefrontProducts(db, { limit: 10, sort: "newest", cursor: first.pageInfo.endCursor! });
        const page = queries.find(({ sql }) => /from "product_buyer_state"/i.test(sql) && /product_created_at/.test(sql) && /limit \?/i.test(sql) && /"products"\."name"/.test(sql));
        expect(page).toBeDefined();
        const plan = sqlite!.prepare(`EXPLAIN QUERY PLAN ${page!.sql}`).all(...page!.params).map((step) => String(step.detail)).join("\n");
        expect(plan).not.toMatch(/SCAN product_buyer_state\b/);
        expect(plan).toMatch(/product_buyer_state_newest_idx \(is_public=\? AND product_created_at<\?\)/);
    });
});
