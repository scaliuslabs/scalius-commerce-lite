import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planLimits } from "@scalius/shared/plan-limits";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { compareSqliteValues, walkBackward, walkForward, type FetchPage } from "../../testing/keyset-walk";
import { listProducts } from "./read";

const SORTS = ["name", "price", "category", "createdAt", "updatedAt"] as const;
const NAMES = ["Canvas Tote", "Canvas tote", "Leather Belt", "রঙিন ব্যাগ", "Wool Scarf", "Canvas Tote"];
const CATEGORIES = ["cat_a", "cat_b", null, "cat_c"];

interface Seeded {
    id: string;
    name: string;
    price: number;
    category: string | null;
    createdAt: number;
    updatedAt: number;
}

const PLANS = ["free", "paid"] as const;

/** Runs the describe's tests under one plan profile and returns that plan's list limits. */
function useProfile(plan: (typeof PLANS)[number]) {
    beforeEach(() => vi.stubGlobal("__SCALIUS_PLAN__", plan));
    afterEach(() => vi.unstubAllGlobals());
    return planLimits(plan).lists;
}

const harnesses: Array<{ sqlite: { close(): void } }> = [];
afterEach(() => {
    for (const harness of harnesses.splice(0)) harness.sqlite.close();
});

/** Products with ties on every sort column and a nullable category, so ids and NULLs decide the order. */
function setup(count: number, queries: Array<{ query: string; values: readonly unknown[] }> = []) {
    const harness = createSqliteD1Database({ onQuery: (query, values) => queries.push({ query, values }) });
    harnesses.push(harness);
    harness.sqlite.exec(`
        INSERT INTO categories (id, name, slug) VALUES
            ('cat_a', 'Bags', 'bags'), ('cat_b', 'Belts', 'belts'), ('cat_c', 'Bags', 'bags-2');
    `);
    const insert = harness.sqlite.prepare(`INSERT INTO products (id, name, slug, price_minor, category_id, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)`);
    const rows: Seeded[] = [];
    harness.sqlite.exec("BEGIN");
    for (let index = 0; index < count; index += 1) {
        const row: Seeded = {
            id: `prd_${String(index).padStart(4, "0")}`,
            name: NAMES[index % NAMES.length]!,
            price: ((index * 11) % 5) * 250,
            category: CATEGORIES[index % CATEGORIES.length]!,
            createdAt: 1_700_000_000 + (index % 7) * 60,
            updatedAt: 1_700_100_000 + ((index * 3) % 4) * 60,
        };
        rows.push(row);
        insert.run(row.id, row.name, `slug-${index}`, row.price, row.category, row.createdAt, row.updatedAt);
    }
    harness.sqlite.exec("COMMIT");
    return { ...harness, rows };
}

const CATEGORY_NAMES: Record<string, string> = { cat_a: "Bags", cat_b: "Belts", cat_c: "Bags" };

function sortValue(row: Seeded, sort: (typeof SORTS)[number]): number | string | null {
    if (sort === "category") return row.category ? CATEGORY_NAMES[row.category]! : null;
    return row[sort];
}

function expectedOrder(rows: Seeded[], sort: (typeof SORTS)[number], direction: "asc" | "desc") {
    const sign = direction === "asc" ? 1 : -1;
    return [...rows].sort((left, right) =>
        sign * (compareSqliteValues(sortValue(left, sort), sortValue(right, sort)) || compareSqliteValues(left.id, right.id)),
    ).map((row) => row.id);
}

type Db = ReturnType<typeof setup>["db"];

function fetcher(db: Db, options: Parameters<typeof listProducts>[1]): FetchPage {
    return async (cursor) => {
        const result = await listProducts(db, { ...options, ...cursor });
        return {
            ids: result.products.map((product) => product.id),
            pageInfo: result.pageInfo,
            offset: result.pagination.offset,
        };
    };
}

describe.each(PLANS)("admin product list keyset pagination on the %s plan", (plan) => {
    const lists = useProfile(plan);

    for (const sort of SORTS) {
        for (const direction of ["asc", "desc"] as const) {
            it(`walks every product exactly once by ${sort} ${direction}, forward and back`, async () => {
                const { db, rows } = setup(43);
                const expected = expectedOrder(rows, sort, direction);
                const fetchPage = fetcher(db, { sort, order: direction, limit: 8, includeDescription: false });

                const forward = await walkForward(fetchPage);
                expect(forward.flatMap((page) => page.ids)).toEqual(expected);
                expect(forward.map((page) => page.offset)).toEqual(forward.map((_, index) => index * 8));
                expect(forward.at(-1)!.pageInfo.hasNextPage).toBe(false);

                const backward = await walkBackward(fetchPage, forward.at(-1)!);
                expect(backward.map((page) => page.ids)).toEqual(forward.map((page) => page.ids).reverse());
                expect(backward.at(-1)!.pageInfo.hasPreviousPage).toBe(false);
            });
        }
    }

    it("keeps numbered pages, filters and trash with a cursor", async () => {
        const { db, sqlite, rows } = setup(30);
        sqlite.exec("UPDATE products SET is_active = 0 WHERE id IN ('prd_0001', 'prd_0002'); UPDATE products SET deleted_at = unixepoch() WHERE id = 'prd_0003'");
        const live = rows.filter((row) => row.id !== "prd_0003");
        const second = await listProducts(db, { page: 2, limit: 10, sort: "price", order: "asc" });
        expect(second.products.map((product) => product.id)).toEqual(expectedOrder(live, "price", "asc").slice(10, 20));
        expect(second.pagination).toMatchObject({ page: 2, offset: 10, total: live.length, totalIsCapped: false });

        const drafts = await walkForward(fetcher(db, { status: "draft", limit: 1, sort: "name" }));
        // The list reads newest-first / descending unless told otherwise.
        expect(drafts.flatMap((page) => page.ids)).toEqual(
            expectedOrder(rows.filter((row) => ["prd_0001", "prd_0002"].includes(row.id)), "name", "desc"),
        );

        const category = await walkForward(fetcher(db, { categoryId: "cat_a", limit: 4, sort: "updatedAt", order: "asc" }));
        expect(category.flatMap((page) => page.ids)).toEqual(
            expectedOrder(live.filter((row) => row.category === "cat_a"), "updatedAt", "asc"),
        );
        const trash = await listProducts(db, { showTrashed: true });
        expect(trash.products.map((product) => product.id)).toEqual(["prd_0003"]);
    });

    it("rejects invalid, mismatched and conflicting cursors with a typed 400", async () => {
        const { db } = setup(12);
        const cursor = (await listProducts(db, { limit: 5, sort: "name" })).pageInfo.endCursor!;
        const cases: Array<[string, Parameters<typeof listProducts>[1]]> = [
            ["garbage", { after: "nope!" }],
            ["another sort", { sort: "price", after: cursor }],
            ["another direction", { sort: "name", order: "asc", after: cursor }],
            ["after and before", { sort: "name", after: cursor, before: cursor }],
            ["a cursor and a later page", { sort: "name", page: 2, after: cursor }],
        ];
        for (const [label, options] of cases) {
            await expect(listProducts(db, options), label).rejects.toMatchObject({ status: 400, code: "invalid_cursor" });
        }
        await expect(listProducts(db, { page: lists.maxOffset / 10 + 1, limit: 10 })).rejects.toMatchObject({ status: 400, code: "page_too_deep" });
    });

    it("pages a text search by position and keeps every match reachable", async () => {
        const { db, rows } = setup(40);
        const matching = rows.filter((row) => row.name === "Wool Scarf").map((row) => row.id);
        const fetchPage = fetcher(db, { search: "Scarf", limit: 3 });
        const pages = await walkForward(fetchPage);
        expect(pages.flatMap((page) => page.ids).sort()).toEqual([...matching].sort());
        expect(new Set(pages.flatMap((page) => page.ids)).size).toBe(matching.length);
        const back = await walkBackward(fetchPage, pages.at(-1)!);
        expect(back.map((page) => page.ids)).toEqual(pages.map((page) => page.ids).reverse());
    });
});

describe.each(PLANS)("admin product list totals read a bounded number of rows on the %s plan", (plan) => {
    const lists = useProfile(plan);

    it("caps the total and never issues an unbounded count", async () => {
        const queries: Array<{ query: string; values: readonly unknown[] }> = [];
        const { db } = setup(lists.countCap + 120, queries);
        queries.length = 0;
        const result = await listProducts(db, { limit: 10, includeDescription: false });
        expect(result.pagination).toMatchObject({ total: lists.countCap, totalIsCapped: true });
        expect(result.pageInfo.hasNextPage).toBe(true);
        const counts = queries.filter(({ query }) => /count\(\*\)/i.test(query) && /from "products"/i.test(query));
        expect(counts.length).toBeGreaterThan(0);
        for (const { query, values } of counts) {
            expect(query, query).toMatch(/count\(\*\) from \(select 1 as "one" from "products" .* limit \?\)/i);
            expect(values.at(-1)).toBe(lists.countCap + 1);
        }
        expect(queries.some(({ query }) => /count\(distinct/i.test(query))).toBe(false);
    });
});
