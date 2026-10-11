import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StorefrontProductFilterInput } from "../products";
import { rebuildCatalogProjections } from "../products/catalog-projections";
import { getStorefrontProducts } from "./listing";
import * as relevance from "./search-relevance";

type Product = { id: string; name: string; description?: string; category?: string; active?: boolean; freeDelivery?: boolean; price?: number; createdAt?: number };
type Captured = { query: string; params: readonly SQLInputValue[] };
let sqlite: DatabaseSync | undefined;
let db: Database;
let queries: Captured[];
afterEach(() => { vi.restoreAllMocks(); sqlite?.close(); sqlite = undefined; });

async function seed(products: Product[]) {
    queries = [];
    ({ sqlite, db } = createSqliteD1Database({ onQuery: (query, params) => queries.push({ query, params }) }));
    sqlite.exec(`INSERT INTO categories (id, name, slug, status) VALUES
        ('cat_main', 'General', 'main', 'published'), ('cat_other', 'Needle', 'other', 'published')`);
    for (const product of products) {
        sqlite.prepare(`INSERT INTO products
            (id, name, slug, description, category_id, price_minor, is_active, free_delivery, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            product.id, product.name, product.id, product.description ?? "", product.category ?? "cat_main",
            product.price ?? 1000, product.active === false ? 0 : 1, product.freeDelivery === false ? 0 : 1,
            product.createdAt ?? 1700000000,
        );
        sqlite.prepare(`INSERT INTO product_variants
            (id, product_id, sku, price_minor, is_default, track_inventory)
            VALUES (?, ?, ?, ?, 1, 0)`).run(`sku_${product.id}`, product.id, `sku_${product.id}`, product.price ?? 1000);
    }
    await rebuildCatalogProjections(db);
    queries.length = 0;
}

async function read(params: StorefrontProductFilterInput, baseline = false) {
    const original = baseline ? vi.spyOn(relevance, "boundedProductSearchPage").mockReturnValue(undefined) : undefined;
    queries.length = 0;
    try {
        const value = await getStorefrontProducts(db, params);
        const page = queries.find(entry => entry.query.includes("listing_page AS MATERIALIZED"));
        expect(page).toBeDefined();
        expect(Math.max(...queries.map(entry => entry.params.length))).toBeLessThanOrEqual(90);
        return { value, page: page! };
    } finally {
        original?.mockRestore();
    }
}

function observedBranch(page: Captured) {
    const proof: number[] = [];
    let baselineScores = 0;
    sqlite!.function("observe_prefix", value => { proof.push(Number(value)); return value; });
    sqlite!.function("observe_baseline_score", value => { baselineScores += 1; return value; });
    const observed = page.query
        .replace("THEN 1 ELSE 0 END AS use_prefix", "THEN observe_prefix(1) ELSE observe_prefix(0) END AS use_prefix")
        .replace("bm25(products_fts, 10.0, 1.0) AS rank_score", "observe_baseline_score(bm25(products_fts, 10.0, 1.0)) AS rank_score");
    expect(sqlite!.prepare(observed).all(...page.params)).toEqual(sqlite!.prepare(page.query).all(...page.params));
    return { proof, baselineScores };
}

const descriptionMatches = (count = 20, description = "needle") => Array.from({ length: count }, (_, index) => ({
    id: `desc_${String(index).padStart(2, "0")}`, name: `Other item ${index}`, description,
}));

describe("bounded full-query relevance pages", () => {
    it("keeps multi-term full-query weighted scores and never executes fallback when the strict cutoff proves the page", async () => {
        await seed([
            { id: "title_a", name: "Needle cloth A" },
            { id: "title_z", name: "Needle cloth Z", description: "needle cloth ".repeat(12) },
            { id: "title_c", name: "Needle cloth C", description: "needle cloth ".repeat(8) },
            ...descriptionMatches(20, `needle cloth ${"filler ".repeat(120)}`),
        ]);
        const params = { search: "needle cloth", page: 1, limit: 2 };
        const optimized = await read(params);
        expect(optimized.value).toEqual((await read(params, true)).value);
        // Restricting MATCH to the title would change document/phrase scoring.
        const fullScores = sqlite!.prepare(`SELECT p.id, bm25(products_fts, 10.0, 1.0) AS score
            FROM products_fts JOIN products p ON p.rowid = products_fts.rowid
            WHERE products_fts MATCH 'needle* cloth*' AND p.id IN ('title_a', 'title_z') ORDER BY score`).all();
        const titleScores = sqlite!.prepare(`SELECT p.id, bm25(products_fts, 10.0, 1.0) AS score
            FROM products_fts JOIN products p ON p.rowid = products_fts.rowid
            WHERE products_fts MATCH 'name : (needle* cloth*)' AND p.id IN ('title_a', 'title_z') ORDER BY score`).all();
        expect(fullScores.map(row => row.id)).not.toEqual(titleScores.map(row => row.id));
        expect(optimized.page.query).toContain("rank MATCH 'bm25(10.0,1.0)'");
        expect(observedBranch(optimized.page)).toEqual({ proof: [1], baselineScores: 0 });
        const plan = sqlite!.prepare(`EXPLAIN QUERY PLAN ${optimized.page.query}`).all(...optimized.page.params)
            .map(row => String(row.detail));
        expect(plan).toContain("MATERIALIZE rank_prefix");
        expect(plan.some(line => /products_fts VIRTUAL TABLE INDEX 32:rM2/.test(line))).toBe(true);
        expect(plan).toContain("SEARCH products USING INTEGER PRIMARY KEY (rowid=?)");
    });

    it("falls back when unseen boundary ties could win on name, created time or id", async () => {
        await seed(Array.from({ length: 30 }, (_, index) => ({
            id: `tie_${String(index).padStart(2, "0")}`, name: `Needle ${String(100 - index).padStart(3, "0")}`,
        })));
        const params = { search: "needle", page: 1, limit: 2 };
        const optimized = await read(params);
        expect(optimized.value).toEqual((await read(params, true)).value);
        expect(optimized.value.products.map(product => product.id)).toEqual(["tie_29", "tie_28"]);
        const visits = observedBranch(optimized.page);
        expect(visits.proof).toEqual([0]);
        expect(visits.baselineScores).toBeGreaterThan(0);
    });

    it("accepts an exhausted tied prefix and preserves created-time/id ties and lookahead", async () => {
        await seed([
            { id: "title_b", name: "Needle", createdAt: 1700000002 },
            { id: "title_a", name: "Needle", createdAt: 1700000002 },
            { id: "title_c", name: "Needle", createdAt: 1700000001 },
            { id: "title_d", name: "Needle", createdAt: 1700000000 },
        ]);
        const params = { search: "needle", page: 1, limit: 2 };
        const optimized = await read(params);
        expect(optimized.value).toEqual((await read(params, true)).value);
        expect(optimized.value.products.map(product => product.id)).toEqual(["title_a", "title_b"]);
        expect(observedBranch(optimized.page)).toEqual({ proof: [1], baselineScores: 0 });
        const next = { ...params, page: 2 };
        expect((await read(next)).value).toEqual((await read(next, true)).value);
    });

    it("applies public eligibility, category, delivery and price filters before proving the title prefix", async () => {
        await seed([
            { id: "title_00", name: "Needle hidden", active: false },
            { id: "title_01", name: "Needle delivery", freeDelivery: false },
            { id: "title_02", name: "Needle expensive", price: 4000 },
            { id: "title_03", name: "Needle category", category: "cat_other" },
            ...Array.from({ length: 6 }, (_, index) => ({ id: `title_${index + 10}`, name: `Needle eligible ${index}`, price: 2000 })),
            ...descriptionMatches(),
        ]);
        const params = { search: "needle", page: 1, limit: 2, category: "main", freeDelivery: "true", inStock: "true", minPrice: 10, maxPrice: 30 } as const;
        const optimized = await read(params);
        expect(optimized.value).toEqual((await read(params, true)).value);
        expect(optimized.value.products.every(product => product.id.startsWith("title_1"))).toBe(true);
        expect(observedBranch(optimized.page)).toEqual({ proof: [1], baselineScores: 0 });
    });

    it("retains category-only and description tiers when there are too few eligible titles", async () => {
        await seed([
            { id: "title", name: "Needle title" },
            { id: "category_z", name: "Zed", category: "cat_other" },
            { id: "category_a", name: "Alpha", category: "cat_other" },
            { id: "description", name: "Detail", description: "needle" },
        ]);
        for (const page of [1, 2]) {
            const params = { search: "needle", page, limit: 2 };
            const optimized = await read(params);
            expect(optimized.value).toEqual((await read(params, true)).value);
            expect(observedBranch(optimized.page).proof).toEqual([0]);
            expect(optimized.value.products.map(product => product.id))
                .toEqual(page === 1 ? ["title", "category_a"] : ["category_z", "description"]);
        }
    });

    it("bypasses the probe entirely past the first hundred rank positions", async () => {
        await seed(descriptionMatches());
        const params = { search: "needle", page: 51, limit: 2 };
        const optimized = await read(params);
        expect(optimized.value).toEqual((await read(params, true)).value);
        expect(optimized.page.query).not.toContain("rank_prefix");
    });

    it("keeps combined filters and the maximum selected option values within the D1 bind ceiling", async () => {
        await seed([{ id: "title", name: "One two three four five six seven eight" }]);
        const keys = Array.from({ length: 90 }, (_, index) => `value-${index}`);
        const params: StorefrontProductFilterInput = {
            search: "one two three four five six seven eight", page: 1, limit: 2,
            category: "main", ids: ["title", ...keys].slice(0, 90).join(","),
            freeDelivery: "true", hasDiscount: "false", inStock: "true", minRating: 4, minPrice: 5, maxPrice: 50,
            attributeFilters: [{ kind: "option", id: "option.color", name: "Color", slug: "option.color", values: keys, labels: keys, keys }],
        };
        const optimized = await read(params);
        expect(optimized.value).toEqual((await read(params, true)).value);
        expect(observedBranch(optimized.page).proof).toEqual([0]);
    });
});
