import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import * as databaseClient from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { deps, withDependencyScope } from "../../cache-deps";
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
