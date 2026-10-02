import { afterEach, describe, expect, it } from "vitest";
import { LIST_COUNT_CAP } from "@scalius/shared/pagination";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { compareSqliteValues, walkBackward, walkForward, type FetchPage } from "../../testing/keyset-walk";
import { listCustomers } from "./customers.service";

const SORTS = ["name", "totalOrders", "totalSpent", "lastOrderAt", "createdAt", "updatedAt"] as const;
const NAMES = ["Rahim Uddin", "Karim Ali", "রহিম", "anika", "Anika", "Zarin", "Karim Ali"];

interface Seeded {
    id: string;
    name: string;
    totalOrders: number;
    totalSpent: number;
    lastOrderAt: number | null;
    createdAt: number;
    updatedAt: number;
}

const harnesses: Array<{ sqlite: { close(): void } }> = [];
afterEach(() => {
    for (const harness of harnesses.splice(0)) harness.sqlite.close();
});

/** Customers with ties everywhere; every third one has never ordered (no stats row, NULL last order). */
function setup(count: number, queries: Array<{ query: string; values: readonly unknown[] }> = []) {
    const harness = createSqliteD1Database({ onQuery: (query, values) => queries.push({ query, values }) });
    harnesses.push(harness);
    const insertCustomer = harness.sqlite.prepare(
        "INSERT INTO customers (id, name, phone, origin, created_at, updated_at) VALUES (?, ?, ?, 'merchant', ?, ?)",
    );
    const insertStats = harness.sqlite.prepare(
        "INSERT INTO customer_order_stats (customer_id, orders_count, total_spent_minor, last_order_at) VALUES (?, ?, ?, ?)",
    );
    const rows: Seeded[] = [];
    harness.sqlite.exec("BEGIN");
    for (let index = 0; index < count; index += 1) {
        const ordered = index % 3 !== 0;
        const row: Seeded = {
            id: `cust_${String(index).padStart(4, "0")}`,
            name: NAMES[index % NAMES.length]!,
            totalOrders: ordered ? (index % 4) + 1 : 0,
            totalSpent: ordered ? (index % 5) * 1_000 : 0,
            lastOrderAt: ordered ? 1_700_000_000 + (index % 6) * 3_600 : null,
            createdAt: 1_690_000_000 + (index % 8) * 60,
            updatedAt: 1_691_000_000 + ((index * 5) % 6) * 60,
        };
        rows.push(row);
        insertCustomer.run(row.id, row.name, `+88017${String(index).padStart(8, "0")}`, row.createdAt, row.updatedAt);
        if (ordered) insertStats.run(row.id, row.totalOrders, row.totalSpent, row.lastOrderAt);
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

function fetcher(db: Db, options: NonNullable<Parameters<typeof listCustomers>[1]>): FetchPage {
    return async (cursor) => {
        const result = await listCustomers(db, { ...options, ...cursor });
        return {
            ids: result.customers.map((customer) => customer.id),
            pageInfo: result.pageInfo,
            offset: result.pagination.offset,
        };
    };
}

describe("customer list keyset pagination", () => {
    for (const sort of SORTS) {
        for (const direction of ["asc", "desc"] as const) {
            it(`walks every customer exactly once by ${sort} ${direction}, forward and back`, async () => {
                const { db, rows } = setup(41);
                const expected = expectedOrder(rows, sort, direction);
                const fetchPage = fetcher(db, { sort, order: direction, limit: 7 });

                const forward = await walkForward(fetchPage);
                expect(forward.flatMap((page) => page.ids)).toEqual(expected);
                expect(forward.map((page) => page.offset)).toEqual(forward.map((_, index) => index * 7));

                const backward = await walkBackward(fetchPage, forward.at(-1)!);
                expect(backward.map((page) => page.ids)).toEqual(forward.map((page) => page.ids).reverse());
            });
        }
    }

    it("keeps search, segments and trash working beside a cursor", async () => {
        const { db, sqlite, rows } = setup(36);
        sqlite.exec("UPDATE customers SET deleted_at = unixepoch() WHERE id IN ('cust_0001', 'cust_0004')");
        const live = rows.filter((row) => !["cust_0001", "cust_0004"].includes(row.id));
        const numbered = await listCustomers(db, { page: 2, limit: 10, sort: "totalSpent", order: "desc" });
        expect(numbered.customers.map((customer) => customer.id)).toEqual(expectedOrder(live, "totalSpent", "desc").slice(10, 20));
        expect(numbered.pagination).toMatchObject({ page: 2, offset: 10, total: live.length, totalIsCapped: false });

        const searched = await walkForward(fetcher(db, { search: "Karim", limit: 3, sort: "name", order: "asc" }));
        const karims = live.filter((row) => row.name === "Karim Ali").map((row) => row.id);
        expect(searched.flatMap((page) => page.ids).sort()).toEqual([...karims].sort());

        const trash = await walkForward(fetcher(db, { showTrashed: true, limit: 1 }));
        expect(trash.flatMap((page) => page.ids).sort()).toEqual(["cust_0001", "cust_0004"]);
    });

    it("rejects invalid and mismatched cursors with a typed 400", async () => {
        const { db } = setup(12);
        const cursor = (await listCustomers(db, { limit: 5, sort: "name" })).pageInfo.endCursor!;
        await expect(listCustomers(db, { after: "!!" })).rejects.toMatchObject({ status: 400, code: "INVALID_CURSOR" });
        await expect(listCustomers(db, { sort: "totalSpent", after: cursor })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
        await expect(listCustomers(db, { sort: "name", after: cursor, before: cursor })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
        await expect(listCustomers(db, { page: 51, limit: 20 })).rejects.toMatchObject({ code: "PAGE_TOO_DEEP" });
    });
});

describe("customer list totals read a bounded number of rows", () => {
    it("caps the total and never issues an unbounded count", async () => {
        const queries: Array<{ query: string; values: readonly unknown[] }> = [];
        const { db } = setup(LIST_COUNT_CAP + 80, queries);
        queries.length = 0;
        const result = await listCustomers(db, { limit: 10 });
        expect(result.pagination).toMatchObject({ total: LIST_COUNT_CAP, totalIsCapped: true });
        const counts = queries.filter(({ query }) => /count\(\*\)/i.test(query) && /from "customers"/i.test(query));
        expect(counts.length).toBeGreaterThan(0);
        for (const { query, values } of counts) {
            expect(query, query).toMatch(/count\(\*\) from \(select 1 as "one" from "customers" .* limit \?\)/i);
            expect(values.at(-1)).toBe(LIST_COUNT_CAP + 1);
        }
    });
});
