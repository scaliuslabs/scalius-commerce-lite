import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planLimits } from "@scalius/shared/plan-limits";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { compareSqliteValues, walkBackward, walkForward, type FetchPage } from "../../../testing/keyset-walk";
import { listOrders } from "./list";

const SORTS = ["createdAt", "updatedAt", "totalAmount", "customerName", "status"] as const;
const NAMES = ["Rahim Uddin", "Karim Ali", "রহিম", "anika", "Anika", "Zarin", "Karim Ali"];
const STATUSES = ["pending", "processing", "confirmed", "shipped", "cancelled"];

interface Seeded {
    id: string;
    createdAt: number;
    updatedAt: number;
    totalAmount: number;
    customerName: string;
    status: string;
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

/** Orders with heavy ties on every sort column, so only the id keeps the order stable. */
function setup(count: number, queries: Array<{ query: string; values: readonly unknown[] }> = []) {
    const harness = createSqliteD1Database({ onQuery: (query, values) => queries.push({ query, values }) });
    harnesses.push(harness);
    const insert = harness.sqlite.prepare(`INSERT INTO orders (
        id, customer_name, customer_phone, shipping_address, city, zone,
        total_amount_minor, shipping_amount_minor, payment_method, status, payment_status,
        paid_amount_minor, balance_due_minor, currency_code, currency_decimal_places, created_at, updated_at
    ) VALUES (?, ?, '+8801711111111', 'Mirpur', 'city', 'zone', ?, 0, 'cod', ?, 'unpaid', 0, ?, 'BDT', 2, ?, ?)`);
    const rows: Seeded[] = [];
    harness.sqlite.exec("BEGIN");
    for (let index = 0; index < count; index += 1) {
        const row: Seeded = {
            id: `ord_${String(index).padStart(4, "0")}`,
            createdAt: 1_700_000_000 + (index % 9) * 60,
            updatedAt: 1_700_100_000 + ((index * 7) % 5) * 60,
            totalAmount: ((index * 13) % 6) * 500,
            customerName: NAMES[index % NAMES.length]!,
            status: STATUSES[index % STATUSES.length]!,
        };
        rows.push(row);
        insert.run(row.id, row.customerName, row.totalAmount, row.status, row.totalAmount, row.createdAt, row.updatedAt);
    }
    harness.sqlite.exec("COMMIT");
    return { ...harness, rows };
}

function expectedOrder(rows: Seeded[], sort: (typeof SORTS)[number], direction: "asc" | "desc") {
    const sign = direction === "asc" ? 1 : -1;
    return [...rows].sort((left, right) =>
        sign * (compareSqliteValues(left[sort], right[sort]) || compareSqliteValues(left.id, right.id)),
    ).map((row) => row.id);
}

type Db = ReturnType<typeof setup>["db"];

function fetcher(db: Db, options: Parameters<typeof listOrders>[1]): FetchPage {
    return async (cursor) => {
        const result = await listOrders(db, { ...options, ...cursor });
        return {
            ids: result.orders.map((order) => order.id),
            pageInfo: result.pageInfo,
            offset: result.pagination.offset,
        };
    };
}

describe.each(PLANS)("order list keyset pagination on the %s plan", (plan) => {
    const lists = useProfile(plan);

    for (const sort of SORTS) {
        for (const direction of ["asc", "desc"] as const) {
            it(`walks every order exactly once by ${sort} ${direction}, forward and back, with ties`, async () => {
                const { db, rows } = setup(47);
                const expected = expectedOrder(rows, sort, direction);
                const fetchPage = fetcher(db, { sort, order: direction, limit: 8 });

                const forward = await walkForward(fetchPage);
                expect(forward.flatMap((page) => page.ids)).toEqual(expected);
                expect(forward).toHaveLength(Math.ceil(47 / 8));
                expect(forward.map((page) => page.pageInfo.hasPreviousPage)).toEqual(forward.map((_, index) => index > 0));
                expect(forward.map((page) => page.pageInfo.hasNextPage)).toEqual(forward.map((_, index) => index < forward.length - 1));
                // Every page knows where it starts in the full order (the count cap is far away).
                expect(forward.map((page) => page.offset)).toEqual(forward.map((_, index) => index * 8));

                const backward = await walkBackward(fetchPage, forward[forward.length - 1]!);
                expect(backward.map((page) => page.ids)).toEqual(forward.map((page) => page.ids).reverse());
                expect(backward.map((page) => page.offset)).toEqual(forward.map((page) => page.offset).reverse());
                expect(backward.at(-1)!.pageInfo.hasPreviousPage).toBe(false);
            });
        }
    }

    it("reads numbered pages and continues from them with a cursor", async () => {
        const { db, rows } = setup(30);
        const expected = expectedOrder(rows, "createdAt", "desc");
        const second = await listOrders(db, { page: 2, limit: 10 });
        expect(second.orders.map((order) => order.id)).toEqual(expected.slice(10, 20));
        expect(second.pageInfo).toMatchObject({ hasNextPage: true, hasPreviousPage: true });
        expect(second.pagination).toMatchObject({ page: 2, offset: 10, total: 30, totalIsCapped: false, totalPages: 3 });
        const third = await listOrders(db, { limit: 10, after: second.pageInfo.endCursor! });
        expect(third.orders.map((order) => order.id)).toEqual(expected.slice(20, 30));
        expect(third.pageInfo.hasNextPage).toBe(false);
        expect(third.pagination).toMatchObject({ page: 3, offset: 20 });
        const back = await listOrders(db, { limit: 10, before: second.pageInfo.startCursor! });
        expect(back.orders.map((order) => order.id)).toEqual(expected.slice(0, 10));
        expect(back.pageInfo).toMatchObject({ hasNextPage: true, hasPreviousPage: false });
    });

    it("keeps a cursor walk stable when the page size changes between requests", async () => {
        const { db, rows } = setup(40);
        const expected = expectedOrder(rows, "customerName", "asc");
        const first = await listOrders(db, { sort: "customerName", order: "asc", limit: 15 });
        const next = await listOrders(db, { sort: "customerName", order: "asc", limit: 10, after: first.pageInfo.endCursor! });
        expect(next.orders.map((order) => order.id)).toEqual(expected.slice(15, 25));
        expect(next.pagination.offset).toBe(15);
        const prev = await listOrders(db, { sort: "customerName", order: "asc", limit: 20, before: next.pageInfo.startCursor! });
        // Fewer than a full page above the cursor: the page is whatever is left.
        expect(prev.orders.map((order) => order.id)).toEqual(expected.slice(0, 15));
        expect(prev.pagination.offset).toBe(0);
    });

    it("applies filters before and after the cursor", async () => {
        const { db, rows } = setup(60);
        const filtered = rows.filter((row) => row.status === "shipped");
        const expected = expectedOrder(filtered, "totalAmount", "desc");
        const fetchPage = fetcher(db, { status: "shipped", sort: "totalAmount", order: "desc", limit: 5 });
        const pages = await walkForward(fetchPage);
        expect(pages.flatMap((page) => page.ids)).toEqual(expected);
        const first = await listOrders(db, { status: "shipped", sort: "totalAmount", limit: 5 });
        expect(first.pagination).toMatchObject({ total: filtered.length, totalIsCapped: false });
    });

    it("keeps date filters and archived views working with a cursor", async () => {
        const { db, sqlite, rows } = setup(30);
        sqlite.exec("UPDATE orders SET archived_at = unixepoch() WHERE id IN ('ord_0001', 'ord_0002', 'ord_0003')");
        const live = expectedOrder(rows.filter((row) => !["ord_0001", "ord_0002", "ord_0003"].includes(row.id)), "createdAt", "desc");
        const pages = await walkForward(fetcher(db, { limit: 6 }));
        expect(pages.flatMap((page) => page.ids)).toEqual(live);
        const archived = await walkForward(fetcher(db, { limit: 2, showArchived: true }));
        expect(archived.flatMap((page) => page.ids).sort()).toEqual(["ord_0001", "ord_0002", "ord_0003"]);
        const since = await walkForward(fetcher(db, { limit: 4, startDate: new Date((1_700_000_000 + 4 * 60) * 1000) }));
        expect(since.flatMap((page) => page.ids)).toEqual(
            expectedOrder(rows.filter((row) => row.createdAt >= 1_700_000_000 + 4 * 60 && !["ord_0001", "ord_0002", "ord_0003"].includes(row.id)), "createdAt", "desc"),
        );
    });

    it("returns an empty page, not an error, for a cursor past the end or before the start", async () => {
        const { db } = setup(5);
        const all = await listOrders(db, { limit: 10 });
        const past = await listOrders(db, { limit: 10, after: all.pageInfo.endCursor! });
        expect(past.orders).toEqual([]);
        expect(past.pageInfo).toEqual({ hasNextPage: false, hasPreviousPage: true, startCursor: null, endCursor: null });
        const top = await listOrders(db, { limit: 10, before: all.pageInfo.startCursor! });
        expect(top.orders).toEqual([]);
        expect(top.pageInfo).toMatchObject({ hasNextPage: true, hasPreviousPage: false });
    });

    it("rejects invalid, mismatched and conflicting cursors with a typed 400", async () => {
        const { db } = setup(12);
        const created = await listOrders(db, { limit: 5 });
        const cursor = created.pageInfo.endCursor!;
        const cases: Array<[string, Parameters<typeof listOrders>[1]]> = [
            ["garbage", { after: "not-a-cursor!" }],
            ["truncated", { after: cursor.slice(0, -4) }],
            ["another sort", { sort: "updatedAt", after: cursor }],
            ["another direction", { order: "asc", after: cursor }],
            ["after and before", { after: cursor, before: cursor }],
            ["a cursor and a later page", { page: 2, after: cursor }],
        ];
        for (const [label, options] of cases) {
            await expect(listOrders(db, options), label).rejects.toMatchObject({ status: 400, code: "INVALID_CURSOR" });
        }
    });

    it("hands out no cursor for a row whose sort value is too long to carry, instead of one that fails", async () => {
        const { db, sqlite } = setup(6);
        // 600 zeros sort before every name, so the first page ends on this row.
        sqlite.exec("UPDATE orders SET customer_name = hex(zeroblob(300)) WHERE id = 'ord_0002'");
        const page = await listOrders(db, { sort: "customerName", order: "asc", limit: 1 });
        expect(page.orders.map((order) => order.id)).toEqual(["ord_0002"]);
        expect(page.pageInfo).toMatchObject({ hasNextPage: true, endCursor: null, startCursor: null });
        // The next row's cursor is fine and keeps walking.
        const second = await listOrders(db, { sort: "customerName", order: "asc", limit: 1, page: 2 });
        expect(second.pageInfo.endCursor).toEqual(expect.any(String));
        await expect(listOrders(db, { sort: "customerName", order: "asc", limit: 1, after: second.pageInfo.endCursor! })).resolves.toBeDefined();
    });

    it("answers a numbered page beyond the offset bound with a typed error that names the cursor", async () => {
        const { db } = setup(3);
        await expect(listOrders(db, { page: lists.maxOffset / 50 + 1, limit: 50 })).rejects.toMatchObject({
            status: 400,
            code: "PAGE_TOO_DEEP",
            message: expect.stringContaining("after cursor"),
        });
        // The last numbered page below the bound still works.
        const last = await listOrders(db, { page: lists.maxOffset / 50, limit: 50 });
        expect(last.orders).toEqual([]);
    });
});

describe.each(PLANS)("order list totals read a bounded number of rows on the %s plan", (plan) => {
    const lists = useProfile(plan);

    it("caps the total and says so, and the count statement never scans the whole table", async () => {
        const queries: Array<{ query: string; values: readonly unknown[] }> = [];
        const { db } = setup(lists.countCap + 205, queries);
        queries.length = 0;
        const result = await listOrders(db, { limit: 10 });
        expect(result.pagination).toMatchObject({
            total: lists.countCap,
            totalIsCapped: true,
            totalPages: lists.countCap / 10,
        });
        expect(result.pageInfo.hasNextPage).toBe(true);

        const counts = queries.filter(({ query }) => /count\(\*\)/i.test(query) && /from "orders"|from `orders`|from orders/i.test(query));
        expect(counts.length).toBeGreaterThan(0);
        for (const { query, values } of counts) {
            // count(*) only over a sub-select that stops after cap + 1 rows.
            expect(query, query).toMatch(/count\(\*\) from \(select 1 as "one" from "orders" .* limit \?\)/i);
            expect(values.at(-1), query).toBe(lists.countCap + 1);
        }
        expect(queries.some(({ query }) => /select count\(\*\) from "orders"/i.test(query))).toBe(false);
    });

    it("is exact below the cap, and a deep cursor page counts its position with the same bound", async () => {
        const queries: Array<{ query: string; values: readonly unknown[] }> = [];
        const { db } = setup(lists.countCap + 205, queries);
        // Rows 0..99 are before this cursor: exact. Rows beyond the cap: unknown.
        const first = await listOrders(db, { limit: 100 });
        const second = await listOrders(db, { limit: 100, after: first.pageInfo.endCursor! });
        expect(second.pagination).toMatchObject({ offset: 100, page: 2, totalIsCapped: true });

        let page = second;
        for (let hop = 0; hop < lists.countCap / 100 + 5 && page.pagination.offset !== null; hop += 1) {
            page = await listOrders(db, { limit: 100, after: page.pageInfo.endCursor! });
        }
        expect(page.pagination.offset).toBeNull();
        expect(page.pagination.page).toBe(0);
        expect(page.orders).toHaveLength(100);
        const probes = queries.filter(({ query }) => /select count\(\*\) from \(select 1/i.test(query));
        expect(probes.every(({ values }) => values.at(-1) === lists.countCap + 1)).toBe(true);
    });
});

describe.each(PLANS)("order list relevance search on the %s plan", (plan) => {
    const lists = useProfile(plan);

    it("pages a ranked search by position inside the bounded window", async () => {
        const { db, rows } = setup(40);
        const matching = rows.filter((row) => row.customerName === "Karim Ali").map((row) => row.id);
        const pages = await walkForward(fetcher(db, { search: "Karim", sort: "relevance", limit: 3 }));
        expect(pages.flatMap((page) => page.ids).sort()).toEqual([...matching].sort());
        expect(new Set(pages.flatMap((page) => page.ids)).size).toBe(matching.length);
        const last = pages[pages.length - 1]!;
        const back = await walkBackward(fetcher(db, { search: "Karim", sort: "relevance", limit: 3 }), last);
        expect(back.map((page) => page.ids)).toEqual(pages.map((page) => page.ids).reverse());
        expect(JSON.parse(Buffer.from(last.pageInfo.endCursor!, "base64url").toString())).toMatchObject({
            s: "relevance",
            k: [matching.length - 1],
            i: "",
        });
        expect(back.at(-1)!.pageInfo.hasPreviousPage).toBe(false);
    });

    it("rejects a relevance cursor for another sort and a deep numbered search page", async () => {
        const { db } = setup(40);
        const first = await listOrders(db, { search: "Karim", sort: "relevance", limit: 2 });
        await expect(listOrders(db, { search: "Karim", sort: "createdAt", limit: 2, after: first.pageInfo.endCursor! }))
            .rejects.toMatchObject({ code: "INVALID_CURSOR" });
        await expect(listOrders(db, { search: "Karim", sort: "relevance", limit: 50, page: lists.maxOffset / 50 + 1 }))
            .rejects.toMatchObject({ code: "PAGE_TOO_DEEP" });
    });
});
