import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import * as databaseClient from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { deps, withDependencyScope } from "../../cache-deps";
import { buildStorefrontBuyerStateConditions } from "./shared";
import { getStorefrontCollectionProducts, getStorefrontProducts } from "./listing";
import {
    declareFacetReadWithoutProducts,
    readCatalogFacetsWithSummary,
    resolvePublicAttributeFilters,
    type CatalogFacetCountInput,
} from "./facets";

type Captured = { sql: string; params: readonly SQLInputValue[] };
let sqlite: DatabaseSync;
let db: databaseClient.Database;
const queries: Captured[] = [];
const productId = (n: number) => `prod_${String(n).padStart(2, "0")}`;
const broadScope = sql`product_buyer_state.is_public = 1 AND product_buyer_state.product_id <= 'prod_16'`;

function facet(n: number, key: string, value: string, label: string, sort = 0, number: number | null = null, variant: string | null = null) {
    sqlite.prepare(`INSERT INTO product_facet_values
        (owner_id, product_id, variant_id, facet_kind, facet_key, value_key, value_label, value_number, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        variant ?? productId(n), productId(n), variant, variant ? "option" : "attribute", key, value, label, number, sort,
    );
}

function sku(n: number, id: string, color?: string, size?: string) {
    sqlite.prepare(`INSERT INTO product_variants
        (id, product_id, sku, option_combination_key, price_minor, stock, track_inventory)
        VALUES (?, ?, ?, ?, 100, 0, 0)`).run(id, productId(n), id, id);
    for (const [axis, value] of [["color", color], ["size", size]] as const) {
        if (!value) continue;
        const definition = `${productId(n)}_${axis}`;
        const option = `${definition}_${value}`;
        sqlite.prepare(`INSERT OR IGNORE INTO product_option_definitions
            (id, product_id, name, normalized_name, position) VALUES (?, ?, ?, ?, ?)`)
            .run(definition, productId(n), axis === "color" ? "Color" : "Size", axis, axis === "color" ? 0 : 1);
        sqlite.prepare(`INSERT OR IGNORE INTO product_option_values
            (id, option_definition_id, value, normalized_value, position) VALUES (?, ?, ?, ?, ?)`)
            .run(option, definition, value, value, value === "large" ? 1 : 0);
        sqlite.prepare(`INSERT INTO product_variant_option_values
            (variant_id, option_definition_id, option_value_id) VALUES (?, ?, ?)`).run(id, definition, option);
    }
}

async function read(overrides: Partial<CatalogFacetCountInput> = {}, fallback = false) {
    // Exercise the unchanged provider fallback as an independent SQL oracle on
    // the same data; this does not replace real provider integration tests.
    const provider = fallback ? vi.spyOn(databaseClient, "getDatabaseProviderForClient").mockReturnValue("turso") : undefined;
    queries.length = 0;
    try {
        const result = await withDependencyScope(async () => {
            deps.listFacets("all");
            deps.listMembership("all");
            deps.listOrder("price", "all");
            deps.listOrder("rating", "all");
            if (overrides.needsProducts) deps.search();
            const value = await readCatalogFacetsWithSummary(db, {
                baseConditions: [broadScope], needsProducts: false, filters: [], ratingFacet: true,
                categoryFacet: "product-categories", ...overrides,
            });
            declareFacetReadWithoutProducts(value.rows);
            return value;
        }, { strict: true, log: () => {} });
        expect(queries).toHaveLength(1);
        expect(queries[0]!.params.length).toBeLessThanOrEqual(100);
        return { ...result, query: queries[0]! };
    } finally {
        provider?.mockRestore();
    }
}

function expectSameDependencies(
    actual: Awaited<ReturnType<typeof read>>["dependencies"], expected: Awaited<ReturnType<typeof read>>["dependencies"],
) {
    expect(actual).toEqual(expected);
}

/** Count actual row visits, not just the planner's existence of both branches. */
function visits(query: Captured) {
    const seen = { plan: [] as number[], baseline: 0, excluded: 0, metadata: 0 };
    sqlite.function("observe_facet_plan", (value) => { seen.plan.push(Number(value)); return value; });
    sqlite.function("observe_baseline", () => { seen.baseline += 1; return 1; });
    sqlite.function("observe_excluded", () => { seen.excluded += 1; return 1; });
    sqlite.function("observe_metadata", () => { seen.metadata += 1; return 1; });
    const observed = query.sql
        .replace("THEN 1 ELSE 0 END AS use_complement", "THEN observe_facet_plan(1) ELSE observe_facet_plan(0) END AS use_complement")
        .replace("WHERE attribute_row.owner_id =", "WHERE observe_baseline() = 1 AND attribute_row.owner_id =")
        .replace("WHERE option_row.product_id =", "WHERE observe_baseline() = 1 AND option_row.product_id =")
        .replace("WHERE excluded_row.product_id =", "WHERE observe_excluded() = 1 AND excluded_row.product_id =")
        .replaceAll("WHERE metadata.facet_kind =", "WHERE observe_metadata() = 1 AND metadata.facet_kind =");
    expect(sqlite.prepare(observed).all(...query.params)).toEqual(sqlite.prepare(query.sql).all(...query.params));
    return seen;
}

function scopeVisits(query: Captured) {
    const seen = { plan: [] as number[], rows: [0, 0] };
    sqlite.function("observe_scope_plan", value => { seen.plan.push(Number(value)); return value; });
    for (const branch of [0, 1]) {
        sqlite.function(`observe_scope_${branch}`, value => { seen.rows[branch]! += 1; return value; });
    }
    let branch = 0;
    const observed = query.sql
        .replace("THEN 1 ELSE 0 END AS use_covering", "THEN observe_scope_plan(1) ELSE observe_scope_plan(0) END AS use_covering")
        .replaceAll('SELECT "product_buyer_state"."product_id" AS product_id', () =>
            `SELECT observe_scope_${branch++}("product_buyer_state"."product_id") AS product_id`);
    expect(branch).toBe(2);
    expect(sqlite.prepare(observed).all(...query.params)).toEqual(sqlite.prepare(query.sql).all(...query.params));
    return seen;
}

function searchInput(search: string): Partial<CatalogFacetCountInput> {
    const source = buildStorefrontBuyerStateConditions(db, { search });
    return {
        needsProducts: source.needsProducts,
        baseConditions: source.conditions,
        identitySearch: {
            query: search,
            baseConditions: buildStorefrontBuyerStateConditions(db, { search }, { searchCategoryFromBuyerState: true }).conditions,
        },
    };
}

function plainSearchInput(search = "broad"): Partial<CatalogFacetCountInput> {
    return searchInput(search);
}

function seedExclusionSearch() {
    sqlite.exec(`
        UPDATE products SET name = 'Broad ' || id WHERE id <= 'prod_16' OR id = 'prod_20';
        UPDATE products SET name = 'Needle broad' WHERE id = 'prod_01';
        UPDATE products SET is_active = 0 WHERE id = 'prod_20';
        INSERT INTO categories (id, name, slug, status) VALUES
            ('cat_broad', 'Broad collection', 'broad-category', 'published'),
            ('cat_draft', 'Broad hidden', 'broad-hidden', 'draft');
        UPDATE products SET category_id = 'cat_broad' WHERE id = 'prod_17';
        UPDATE products SET category_id = 'cat_draft' WHERE id = 'prod_18';
        UPDATE products SET category_id = NULL WHERE id = 'prod_19';
        UPDATE product_buyer_state SET category_id = 'cat_broad', from_minor = 25, to_minor = 750 WHERE product_id = 'prod_17';
        UPDATE product_buyer_state SET category_id = 'cat_draft', from_minor = 1, to_minor = 9000 WHERE product_id = 'prod_18';
        UPDATE product_buyer_state SET category_id = NULL, from_minor = 2, to_minor = 8000 WHERE product_id = 'prod_19';
        INSERT INTO products (rowid, id, name, slug, price_minor)
            VALUES (707, 'prod_21', 'Broad deleted', 'deleted', 100);
        INSERT INTO product_variants (id, product_id, sku, is_default, price_minor, stock, track_inventory)
            VALUES ('var_21_a', 'prod_21', 'var_21_a', 1, 100, 0, 0);
        UPDATE products SET deleted_at = 1700000001 WHERE id = 'prod_21';
        INSERT INTO product_buyer_state (product_id, is_public, product_created_at, sku_id, from_minor, to_minor, base_minor)
            VALUES ('prod_21', 0, 1700000000, 'var_21_a', 100, 100, 100);
        INSERT INTO product_review_stats (product_id, review_count, rating_sum, count_4, count_5, rating_avg_centi, rating_rank_milli) VALUES
            ('prod_01', 2, 9, 1, 1, 450, 3428),
            ('prod_17', 1, 4, 1, 0, 400, 3166),
            ('prod_18', 1, 5, 0, 1, 500, 3333),
            ('prod_19', 1, 5, 0, 1, 500, 3333),
            ('prod_20', 1, 5, 0, 1, 500, 3333),
            ('prod_21', 1, 5, 0, 1, 500, 3333);
        INSERT INTO product_review_stats (product_id) VALUES ('prod_02');
    `);
}

describe("public facet count complements", () => {
    beforeAll(() => {
        ({ sqlite, db } = createSqliteD1Database({ onQuery: (sql, params) => queries.push({ sql, params }) }));
        sqlite.exec(`
            INSERT INTO categories (id, name, slug, status) VALUES ('cat_main', 'Main', 'main', 'published');
            INSERT INTO brands (id, name, slug, status) VALUES ('brd_main0001', 'Main', 'main', 'published');
            INSERT INTO product_attributes (id, name, slug, value_type, facet_display) VALUES
                ('attr_text', 'Finish', 'finish', 'text', 'checkbox'),
                ('attr_number', 'Measure', 'measure', 'number', 'range'),
                ('attr_null', 'Unknown measure', 'unknown-measure', 'number', 'range');
        `);
        for (let n = 1; n <= 20; n += 1) {
            sqlite.prepare(`INSERT INTO products (id, name, slug, price_minor, category_id, brand_id, created_at)
                VALUES (?, ?, ?, 100, 'cat_main', 'brd_main0001', 1700000000)`).run(productId(n), productId(n), productId(n));
            sku(n, `var_${String(n).padStart(2, "0")}_a`, n <= 3 ? "blue" : n === 4 ? "green" : undefined, n <= 3 ? "small" : n === 4 ? "large" : undefined);
            if (n <= 16) facet(n, "attr_text", "matte", n === 2 ? "Alpha finish" : "Matte", n === 3 ? 2 : 7);
        }
        sku(1, "var_01_b", "blue", "large");
        sku(17, "000_excluded", "blue", "small");
        sku(18, "var_exclusive", "red", "large");
        sku(20, "000_private", "blue", "small");
        for (const [n, variant, color, size, label, sort] of [
            [1, "var_01_a", "blue", "small", "Zulu", 8],
            [1, "var_01_b", "blue", "large", "Zulu", 8],
            [2, "var_02_a", "blue", "small", "Alpha", 7],
            [3, "var_03_a", "blue", "small", "Bravo", 2],
            [4, "var_04_a", "green", "large", "Green", 3],
            [17, "000_excluded", "blue", "small", "!Excluded", -2],
            [18, "var_exclusive", "red", "large", "Red", 0],
            [20, "000_private", "blue", "small", "!Private", -3],
        ] as const) {
            facet(n, "option.color", color, label, sort, null, variant);
            facet(n, "option.size", size, size, 0, null, variant);
        }
        facet(17, "attr_text", "excluded", "Excluded only");
        facet(20, "attr_text", "private", "Private only");
        facet(1, "attr_number", "1", "One", 0, 1.0000001);
        facet(2, "attr_number", "1", "One", 0, 1.0000002);
        facet(3, "attr_number", "2", "Two", 0, 2.0000001);
        facet(4, "attr_number", "1", "Null", 0, null);
        facet(17, "attr_number", "1", "Excluded", -1, 1.00000001);
        facet(20, "attr_number", "1", "Private", -2, 1.000000001);
        facet(1, "attr_null", "unknown", "Unknown");
        // The source query excludes a prefix-only key even though the table
        // check permits it; the complement must preserve that exact bound.
        facet(1, "option.", "prefix-only", "Invalid axis", 0, null, "var_01_a");
        // Normal refresh order: facets first, then the authoritative public
        // state. Production counter triggers maintain the projection here.
        for (let n = 1; n <= 20; n += 1) {
            sqlite.prepare(`INSERT INTO product_buyer_state
                (product_id, is_public, product_created_at, sku_id, from_minor, to_minor, base_minor, category_id, brand_id)
                VALUES (?, ?, 1700000000, ?, 100, 100, 100, 'cat_main', 'brd_main0001')`)
                .run(productId(n), n === 20 ? 0 : 1, `var_${String(n).padStart(2, "0")}_a`);
        }
    }, 120_000);
    beforeEach(() => sqlite.exec("SAVEPOINT facet_test"));
    afterEach(() => { vi.restoreAllMocks(); sqlite.exec("ROLLBACK TO facet_test; RELEASE facet_test"); });
    afterAll(() => sqlite.close());

    it("equals the source aggregate, counts products once, and resolves independent matching minima", async () => {
        const optimized = await read();
        const fallback = await read({}, true);
        expect(optimized.value).toEqual(fallback.value);
        expect(optimized.value.summary).toMatchObject({ count: 16, min: 100, max: 100 });
        expect(optimized.value.rows.find(row => row.facetId === "option.color" && row.valueKey === "blue"))
            .toMatchObject({ valueCount: 3, valueLabel: "Alpha", valueSort: 2, sampleProductId: "prod_01" });
        expect(optimized.value.rows.find(row => row.facetId === "attr_number"))
            .toMatchObject({ valueCount: 3, valueNumber: 1.0000001, rangeMin: 1.0000001, rangeMax: 2.0000001 });
        expect(optimized.value.rows.find(row => row.facetId === "attr_null"))
            .toMatchObject({ valueNumber: null, rangeMin: null, rangeMax: null });
        expect(optimized.value.rows.some(row => ["red", "excluded", "private", "prefix-only"].includes(row.valueKey))).toBe(false);
        const seen = visits(optimized.query);
        expect(seen.plan).toEqual([1]);
        expect(seen.baseline).toBe(0);
        expect(seen.excluded).toBeGreaterThan(0);
        expect(seen.metadata).toBeGreaterThan(0);
        const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${optimized.query.sql}`).all(...optimized.query.params)
            .map(row => String(row.detail)).join("\n");
        for (const name of ["label", "sort", "sample", "number"]) {
            expect(plan).toContain(`USING COVERING INDEX product_facet_values_metadata_${name}_idx`);
        }
        expect(plan.match(/SEARCH metadata_buyer(?: EXISTS)? USING (?:COVERING )?INDEX [^\n]+ \((?:is_public=\? AND )?product_id=\?\)/g)).toHaveLength(4);
        expect(plan).not.toContain("SCAN metadata_buyer");
        expect(optimized.query.sql.match(/metadata\.product_id NOT IN \(SELECT product_id FROM excluded_products\)/g)).toHaveLength(4);
        expect(optimized.query.sql).not.toContain("metadata.product_id IN (SELECT product_id FROM facet_scope)");
    });

    it("excludes metadata from products with missing buyer-state rows", async () => {
        // Keep their facet rows, including the smallest label, sort, SKU and
        // numeric values, after removing both a public and a private state.
        sqlite.exec("DELETE FROM product_buyer_state WHERE product_id IN ('prod_02', 'prod_20')");
        const optimized = await read();
        expect(optimized.value).toEqual((await read({}, true)).value);
        expect(visits(optimized.query).plan).toEqual([1]);
        expect(optimized.value.summary.count).toBe(15);
        expect(optimized.value.rows.find(row => row.facetId === "option.color" && row.valueKey === "blue"))
            .toMatchObject({ valueCount: 2, valueLabel: "Bravo", valueSort: 2, sampleProductId: "prod_01" });
        expect(optimized.value.rows.find(row => row.facetId === "attr_number"))
            .toMatchObject({ valueNumber: 1.0000001, rangeMin: 1.0000001, rangeMax: 2.0000001 });
        expect(optimized.value.rows.some(row => row.valueKey === "private")).toBe(false);
    });

    it("uses the covering identity scope only for broad FTS matches, without visiting the inactive branch", async () => {
        sqlite.exec(`UPDATE products SET name = 'Broad ' || id;
            UPDATE products SET name = 'Needle broad' WHERE id = 'prod_01'`);
        for (const [search, covering, count] of [["broad", 1, 19], ["needle", 0, 1]] as const) {
            const input = searchInput(search);
            const optimized = await read(input);
            const original = await read({ ...input, identitySearch: undefined });
            expect(optimized.value).toEqual(original.value);
            expectSameDependencies(optimized.dependencies, original.dependencies);
            expect(optimized.value.summary.count).toBe(count);
            const seen = scopeVisits(optimized.query);
            expect(seen.plan).toEqual([covering]);
            expect(seen.rows[covering]).toBe(count);
            expect(seen.rows[1 - covering]).toBe(0);
            const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${optimized.query.sql}`).all(...optimized.query.params)
                .map(row => String(row.detail)).join("\n");
            expect(plan).toContain("SEARCH products USING COVERING INDEX sqlite_autoindex_products_1 (id=?)");
            expect(plan).toContain("SEARCH products USING INTEGER PRIMARY KEY (rowid=?)");
            expect(plan).toContain("MULTI-INDEX OR");
            expect(optimized.query.sql.match(/COUNT\(\*\) AS public_count FROM product_buyer_state/g)).toHaveLength(1);
            expect(optimized.query.sql.match(/COUNT\(\*\) AS all_count FROM product_buyer_state/g)).toHaveLength(1);
        }
    });

    it("includes the eighty-percent FTS boundary and skips adaptive scopes for filters or other providers", async () => {
        sqlite.exec("UPDATE products SET name = 'Broad ' || id WHERE id <= 'prod_16'");
        const input = searchInput("broad");
        expect(scopeVisits((await read(input)).query).plan).toEqual([1]);
        sqlite.exec("UPDATE products SET name = id WHERE id = 'prod_16'");
        const below = await read(input);
        expect(scopeVisits(below.query).plan).toEqual([0]);
        expect(below.value).toEqual((await read({ ...input, identitySearch: undefined })).value);
        const filters = await resolvePublicAttributeFilters(db, { "option.color": "blue" }, []);
        for (const result of [
            await read({ ...input, filters }),
            await read({ ...input, minRating: 4 }),
            await read({ ...input, identitySearch: { ...input.identitySearch!, query: "%" } }),
            await read(input, true),
        ]) expect(result.query.sql).not.toContain("identity_scope_plan");
    });

    it("counts a broad plain search exactly as the original scope, results and dependencies alike", async () => {
        seedExclusionSearch();
        const input = plainSearchInput();
        const optimized = await read(input);
        // Removing identitySearch restores the original positive FTS/category
        // scope; the oracle never constructs any exclusion-first branch.
        const original = await read({ ...input, identitySearch: undefined });
        expect(optimized.value).toEqual(original.value);
        expectSameDependencies(optimized.dependencies, original.dependencies);
        expect(optimized.value).toEqual((await read(input, true)).value);
        expect(optimized.value.summary).toMatchObject({ count: 17, min: 25, max: 750 });
        expect(optimized.value.rows.find(row => row.facetId === "option.color" && row.valueKey === "blue"))
            .toMatchObject({ valueCount: 4, valueLabel: "!Excluded", valueSort: -2, sampleProductId: "prod_17" });
        expect(optimized.value.rows.find(row => row.facetId === "attr_number"))
            .toMatchObject({ valueCount: 4, valueNumber: 1.00000001, rangeMin: 1.00000001, rangeMax: 2.0000001 });
        expect(optimized.value.rows.filter(row => row.facetKind === "rating").map(row => row.valueCount)).toEqual([2, 2, 2]);
        expect(optimized.value.rows.filter(row => row.facetKind === "category").map(row => row.valueKey).sort())
            .toEqual(["cat_broad", "cat_main"]);
        expect(optimized.value.rows.some(row => ["red", "private"].includes(row.valueKey))).toBe(false);
    });

    it("keeps brand/category publication, NULL and zero groups identical to the source oracle", async () => {
        seedExclusionSearch();
        sqlite.exec(`
            INSERT INTO brands (id, name, slug, status) VALUES
                ('brd_hidden0001', 'Hidden', 'hidden', 'draft'),
                ('brd_excluded01', 'Excluded', 'excluded', 'published'),
                ('brd_private001', 'Private', 'private', 'published');
            INSERT INTO categories (id, name, slug, status) VALUES ('cat_excluded', 'Other', 'other', 'published');
            UPDATE products SET brand_id = 'brd_hidden0001', category_id = 'cat_draft' WHERE id = 'prod_05';
            UPDATE products SET brand_id = NULL, category_id = NULL WHERE id = 'prod_06';
            UPDATE products SET brand_id = 'brd_excluded01', category_id = 'cat_excluded' WHERE id = 'prod_18';
            UPDATE products SET brand_id = 'brd_private001' WHERE id = 'prod_20';
            UPDATE product_buyer_state SET
                brand_id = (SELECT brand_id FROM products WHERE products.id = product_buyer_state.product_id),
                category_id = (SELECT category_id FROM products WHERE products.id = product_buyer_state.product_id);
        `);
        const input = plainSearchInput();
        const compare = async () => {
            const optimized = await read(input);
            const original = await read({ ...input, identitySearch: undefined });
            expect(optimized.value).toEqual(original.value);
            expectSameDependencies(optimized.dependencies, original.dependencies);
            expect(optimized.value.summary).toMatchObject({ count: 17, min: 25, max: 750 });
            return optimized;
        };
        const initial = await compare();
        expect(initial.value.rows.filter(row => row.facetKind === "brand").map(row => [row.valueKey, row.valueCount]))
            .toEqual([["brd_main0001", 15]]);
        expect(initial.value.rows.filter(row => row.facetKind === "category").map(row => [row.valueKey, row.valueCount]).sort())
            .toEqual([["cat_broad", 1], ["cat_main", 14]]);
        for (const mutation of [
            "UPDATE brands SET status = 'published' WHERE id = 'brd_hidden0001'; UPDATE categories SET status = 'published' WHERE id = 'cat_draft'",
            "UPDATE brands SET deleted_at = 1700000001 WHERE id = 'brd_hidden0001'; UPDATE categories SET deleted_at = 1700000001 WHERE id = 'cat_draft'",
        ]) {
            sqlite.exec(mutation);
            await compare();
        }
        const withoutDimensions = await read({ ...input, brandFacet: false, categoryFacet: undefined });
        expect(withoutDimensions.value).toEqual((await read({ ...input, brandFacet: false, categoryFacet: undefined, identitySearch: undefined })).value);
    });

    it("keeps NULL and unpublished categories out of category-only search matches but permits their FTS matches", async () => {
        seedExclusionSearch();
        for (const status of ["draft", "internal", "published"] as const) {
            sqlite.prepare("UPDATE categories SET status = ? WHERE id = 'cat_draft'").run(status);
            const input = plainSearchInput();
            const optimized = await read(input);
            expect(optimized.value).toEqual((await read({ ...input, identitySearch: undefined })).value);
            expect(optimized.value.summary.count).toBe(status === "published" ? 18 : 17);
        }
        sqlite.exec(`UPDATE categories SET status = 'draft' WHERE id = 'cat_draft';
            UPDATE products SET name = 'Broad ' || id WHERE id IN ('prod_18', 'prod_19')`);
        const input = plainSearchInput();
        const optimized = await read(input);
        expect(optimized.value).toEqual((await read({ ...input, identitySearch: undefined })).value);
        expect(optimized.value.summary).toMatchObject({ count: 19, min: 1, max: 9000 });
        expect(optimized.value.rows.filter(row => row.facetKind === "category").map(row => row.valueKey).sort())
            .toEqual(["cat_broad", "cat_main"]);
    });

    it("counts narrow and empty searches, and a mostly private catalog, as the source oracle", async () => {
        seedExclusionSearch();
        for (const [search, count] of [["needle", 1], ["absentzz", 0]] as const) {
            const input = plainSearchInput(search);
            const optimized = await read(input);
            expect(optimized.value).toEqual((await read({ ...input, identitySearch: undefined })).value);
            expect(optimized.value.summary.count).toBe(count);
        }
        sqlite.exec("UPDATE product_buyer_state SET is_public = 0 WHERE product_id = 'prod_16'");
        const input = plainSearchInput();
        const optimized = await read(input);
        expect(optimized.value).toEqual((await read({ ...input, identitySearch: undefined })).value);
    });

    it("does no rating scan while reviews are disabled and declares no rating dependency when the facet is absent", async () => {
        seedExclusionSearch();
        sqlite.exec(`INSERT INTO settings (id, category, key, type, value)
            VALUES ('reviews_off', 'reviews', 'document', 'json', '{"enabled":false}')`);
        const input = plainSearchInput();
        const disabled = await read(input);
        const original = await read({ ...input, identitySearch: undefined });
        expect(disabled.value).toEqual(original.value);
        expectSameDependencies(disabled.dependencies, original.dependencies);
        expect(disabled.value.rows.filter(row => row.facetKind === "rating")).toEqual([]);
        for (const ratingFacet of [false, undefined]) {
            const absent = await read({ ...input, ratingFacet });
            const baseline = await read({ ...input, ratingFacet, identitySearch: undefined });
            expect(absent.value).toEqual(baseline.value);
            expectSameDependencies(absent.dependencies, baseline.dependencies);
            expect(absent.query.sql).not.toContain("product_review_stats");
            expect(absent.dependencies.keys.some(key => key.includes("reviews"))).toBe(false);
        }
    });

    it("keeps the exact summary independent of output caps and emits no rating rows without matching reviews", async () => {
        seedExclusionSearch();
        sqlite.exec("DELETE FROM product_review_stats WHERE product_id <= 'prod_17'");
        const input = { ...plainSearchInput(), valueLimit: 1, attributeLimit: 1 };
        const optimized = await read(input);
        const original = await read({ ...input, identitySearch: undefined });
        expect(optimized.value).toEqual(original.value);
        expectSameDependencies(optimized.dependencies, original.dependencies);
        expect(optimized.value.summary).toMatchObject({ count: 17, min: 25, max: 750 });
        expect(optimized.value.rows.filter(row => row.facetKind === "rating")).toEqual([]);
    });

    it("retains the original selected-filter and unproven-scope paths", async () => {
        seedExclusionSearch();
        const input = plainSearchInput();
        const filters = await resolvePublicAttributeFilters(db, { "option.color": "blue", "option.size": "large" }, []);
        for (const overrides of [
            { filters },
            { minRating: 4 },
        ]) {
            const optimized = await read({ ...input, ...overrides });
            const original = await read({ ...input, ...overrides, identitySearch: undefined });
            expect(optimized.value).toEqual(original.value);
            expectSameDependencies(optimized.dependencies, original.dependencies);
        }
    });

    it("counts plain search at the listing boundary with stock, discount and custom scopes", async () => {
        // The listing's read batch opens its own transaction. Keep it outside
        // the shared fixture's savepoint without weakening the D1 adapter.
        const queries: Captured[] = [];
        const { sqlite: listingSqlite, db } = createSqliteD1Database({ onQuery: (sql, params) => queries.push({ sql, params }) });
        try {
            listingSqlite.exec(`
                INSERT INTO categories (id, name, slug, status) VALUES
                    ('cat_main', 'Main', 'main', 'published'),
                    ('cat_broad', 'Broad collection', 'broad-category', 'published');
                WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 20)
                INSERT INTO products (id, name, slug, price_minor, category_id, is_active)
                    SELECT printf('prod_%02d', n), CASE WHEN n <= 16 OR n = 20 THEN 'Broad ' ELSE 'Other ' END || n,
                        'product-' || n, 100, CASE WHEN n = 17 THEN 'cat_broad' ELSE 'cat_main' END, n <> 20 FROM seq;
                INSERT INTO product_variants (id, product_id, sku, is_default, price_minor, stock, track_inventory)
                    SELECT 'var_' || id, id, 'SKU-' || id, 1, 100, 0, 0 FROM products;
                INSERT INTO product_buyer_state (product_id, is_public, product_created_at, sku_id, from_minor, to_minor, base_minor,
                    category_id, has_discount, available_for_sale)
                    SELECT id, is_active, 1700000000, 'var_' || id, 100, 100, 100, category_id,
                        id <= 'prod_05', id <= 'prod_05' FROM products;
            `);
            const facetQuery = () => {
                const statements = queries.filter(query => query.sql.includes("facet_scope AS MATERIALIZED"));
                expect(statements).toHaveLength(1);
                return statements[0]!.sql;
            };
            queries.length = 0;
            const plain = await getStorefrontProducts(db, { search: "broad", limit: 2 });
            expect(plain.pagination.total).toBe(17);
            facetQuery();
            const cases: Array<[Parameters<typeof getStorefrontProducts>[1], number]> = [
                [{ hasDiscount: "true" }, 5], [{ hasDiscount: "false" }, 12],
                [{ inStock: "true" }, 5], [{ freeDelivery: "false" }, 17],
                [{ minPrice: 1 }, 17], [{ maxPrice: 1 }, 17],
                [{ ids: "prod_01" }, 1], [{ category: "cat_broad" }, 1],
            ];
            for (const [params, count] of cases) {
                queries.length = 0;
                const result = await getStorefrontProducts(db, { search: "broad", limit: 2, ...params });
                expect(result.pagination.total).toBe(count);
                facetQuery();
            }
            queries.length = 0;
            const scoped = await getStorefrontCollectionProducts(db, { productIds: ["prod_01", "prod_17"] }, { search: "broad", limit: 2 });
            expect(scoped.pagination.total).toBe(2);
            facetQuery();
        } finally {
            listingSqlite.close();
        }
    });

    it("keeps exactly the same dependency keys and cacheability flags", async () => {
        const optimized = await read();
        const fallback = await read({}, true);
        const { tables: optimizedTables, ...optimizedDeps } = optimized.dependencies;
        const { tables: fallbackTables, ...fallbackDeps } = fallback.dependencies;
        expect(optimizedDeps).toEqual(fallbackDeps);
        expect(optimized.dependencies.coarseTables).toEqual([]);
        expect(optimized.dependencies.uncacheable).toEqual([]);
        expect(optimizedTables.filter(table => table !== "product_facet_public_counts")).toEqual(fallbackTables);
        expect(optimizedTables).toContain("product_facet_public_counts");
    });

    it("does no excluded aggregation or metadata work for a narrow scope", async () => {
        const input = { baseConditions: [sql`product_buyer_state.is_public = 1 AND product_buyer_state.product_id = 'prod_01'`] };
        const optimized = await read(input);
        expect(optimized.value).toEqual((await read(input, true)).value);
        expect(visits(optimized.query)).toMatchObject({ plan: [0], excluded: 0, metadata: 0 });
        expect(visits(optimized.query).baseline).toBeGreaterThan(0);
    });

    it("falls back when private products exceed ten percent, even for all public products", async () => {
        sqlite.exec("UPDATE product_buyer_state SET is_public = 0 WHERE product_id IN ('prod_17', 'prod_18', 'prod_19')");
        const optimized = await read();
        expect(optimized.value).toEqual((await read({}, true)).value);
        expect(visits(optimized.query)).toMatchObject({ plan: [0], excluded: 0, metadata: 0 });
    });

    it("includes the eighty/ninety-percent boundaries and falls back below the scope boundary", async () => {
        sqlite.exec("UPDATE product_buyer_state SET is_public = 0 WHERE product_id = 'prod_19'");
        const publicBoundary = await read();
        expect(publicBoundary.value).toEqual((await read({}, true)).value);
        expect(visits(publicBoundary.query).plan).toEqual([1]);
        sqlite.exec("UPDATE product_buyer_state SET is_public = 1 WHERE product_id IN ('prod_19', 'prod_20')");
        const boundary = await read();
        expect(boundary.value).toEqual((await read({}, true)).value);
        expect(visits(boundary.query).plan).toEqual([1]);
        const input = { baseConditions: [sql`product_buyer_state.is_public = 1 AND product_buyer_state.product_id <= 'prod_15'`] };
        const below = await read(input);
        expect(below.value).toEqual((await read(input, true)).value);
        expect(visits(below.query)).toMatchObject({ plan: [0], excluded: 0, metadata: 0 });
    });

    it("keeps an empty scope empty, including its uncapped listing summary", async () => {
        const input = { baseConditions: [sql`product_buyer_state.product_id = 'missing'`] };
        const optimized = await read(input);
        expect(optimized.value).toEqual((await read(input, true)).value);
        expect(optimized.value).toMatchObject({ rows: [], summary: { count: 0, min: null, max: null } });
        expect(visits(optimized.query)).toMatchObject({ plan: [0], baseline: 0, excluded: 0, metadata: 0 });
    });

    it("retains same-SKU self-exclusion and the baseline path for every selected filter kind", async () => {
        const selections: Array<Record<string, string>> = [
            { "option.color": "blue", "option.size": "large" },
            { finish: "matte" },
            { brand: "main" },
        ];
        for (const query of selections) {
            const filters = await resolvePublicAttributeFilters(db, query, []);
            const optimized = await read({ filters });
            expect(optimized.value).toEqual((await read({ filters }, true)).value);
            expect(optimized.query.sql).not.toContain("product_facet_public_counts");
            if (query["option.color"]) {
                expect(optimized.value.summary.count).toBe(1);
                expect(optimized.value.rows.filter(row => row.facetId === "option.color")
                    .map(row => [row.valueKey, row.valueCount])).toEqual([["blue", 1], ["green", 1]]);
                expect(optimized.value.rows.find(row => row.facetId === "option.size" && row.valueKey === "small")?.valueCount).toBe(3);
            }
        }
        const rated = await read({ minRating: 4 });
        expect(rated.value).toEqual((await read({ minRating: 4 }, true)).value);
        expect(rated.query.sql).not.toContain("product_facet_public_counts");
        const filters = await resolvePublicAttributeFilters(db, { "option.color": "red" }, []);
        const noMatches = await read({ filters });
        expect(noMatches.value).toEqual((await read({ filters }, true)).value);
        expect(noMatches.value.summary.count).toBe(0);
        expect(noMatches.value.rows.filter(row => row.facetId === "option.size").map(row => row.valueCount)).toEqual([0, 0]);
    });
});
