import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planLimits } from "@scalius/shared/plan-limits";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { compareSqliteValues, walkBackward, walkForward, type FetchPage } from "../../testing/keyset-walk";
import { listCustomers } from "./customers.service";

const SORTS = ["name", "totalOrders", "totalSpent", "lastOrderAt", "createdAt", "updatedAt"] as const;
const NAMES = ["Rahim Uddin", "Karim Ali", "রহিম", "anika", "Anika", "Zarin", "Karim Ali"];

interface Seeded {
    id: string;
    name: string;
    phone: string;
    email: string;
    totalOrders: number;
    totalSpent: number;
    lastOrderAt: number | null;
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

/** Customers with ties everywhere; every third one has never ordered (no stats row, NULL last order). */
function setup(count: number, queries: Array<{ query: string; values: readonly unknown[] }> = []) {
    const harness = createSqliteD1Database({ onQuery: (query, values) => queries.push({ query, values }) });
    harnesses.push(harness);
    const insertCustomer = harness.sqlite.prepare(
        "INSERT INTO customers (id, name, phone, email, origin, created_at, updated_at) VALUES (?, ?, ?, ?, 'merchant', ?, ?)",
    );
    const insertStats = harness.sqlite.prepare(
        // A new customer already has its zero row (the 0128 trigger): set the seeded facts on it.
        "UPDATE customer_order_stats SET orders_count = ?2, total_spent_minor = ?3, last_order_at = ?4 WHERE customer_id = ?1",
    );
    const rows: Seeded[] = [];
    harness.sqlite.exec("BEGIN");
    for (let index = 0; index < count; index += 1) {
        const ordered = index % 3 !== 0;
        const row: Seeded = {
            id: `cust_${String(index).padStart(4, "0")}`,
            name: NAMES[index % NAMES.length]!,
            phone: `+88017${String(index * 7919).padStart(8, "0")}`,
            email: `shopper.${index}.zq${index * 37}@mailbox.example`,
            totalOrders: ordered ? (index % 4) + 1 : 0,
            totalSpent: ordered ? (index % 5) * 1_000 : 0,
            lastOrderAt: ordered ? 1_700_000_000 + (index % 6) * 3_600 : null,
            createdAt: 1_690_000_000 + (index % 8) * 60,
            updatedAt: 1_691_000_000 + ((index * 5) % 6) * 60,
        };
        rows.push(row);
        insertCustomer.run(row.id, row.name, row.phone, row.email, row.createdAt, row.updatedAt);
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

describe.each(PLANS)("customer list keyset pagination on the %s plan", (plan) => {
    const lists = useProfile(plan);

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
        await expect(listCustomers(db, { after: "!!" })).rejects.toMatchObject({ status: 400, code: "invalid_cursor" });
        await expect(listCustomers(db, { sort: "totalSpent", after: cursor })).rejects.toMatchObject({ code: "invalid_cursor" });
        await expect(listCustomers(db, { sort: "name", after: cursor, before: cursor })).rejects.toMatchObject({ code: "invalid_cursor" });
        await expect(listCustomers(db, { page: lists.maxOffset / 20 + 1, limit: 20 })).rejects.toMatchObject({ code: "page_too_deep" });
    });
});

describe.each(PLANS)("customer list totals read a bounded number of rows on the %s plan", (plan) => {
    const lists = useProfile(plan);

    it("caps the total and never issues an unbounded count", async () => {
        const queries: Array<{ query: string; values: readonly unknown[] }> = [];
        const { db } = setup(lists.countCap + 80, queries);
        queries.length = 0;
        const result = await listCustomers(db, { limit: 10 });
        expect(result.pagination).toMatchObject({ total: lists.countCap, totalIsCapped: true });
        const counts = queries.filter(({ query }) => /count\(\*\)/i.test(query) && /from "customers"/i.test(query));
        expect(counts.length).toBeGreaterThan(0);
        for (const { query, values } of counts) {
            expect(query, query).toMatch(/count\(\*\) from \(select 1 as "one" from "customers" .* limit \?\)/i);
            expect(values.at(-1)).toBe(lists.countCap + 1);
        }
    });
});

/** What a cursor reveals to anyone holding the URL: its raw token and the JSON it decodes to. */
function cursorText(token: string): string {
    return `${token}\n${Buffer.from(token, "base64url").toString("utf8")}`;
}

function craftedCursor(payload: Record<string, unknown>): string {
    return Buffer.from(JSON.stringify({ v: 1, ...payload })).toString("base64url");
}

describe.each(PLANS)("customer list cursors carry no personal data on the %s plan", (plan) => {
    useProfile(plan);

    it("never puts a customer's name, phone or email in a cursor, whatever the sort, direction or page", async () => {
        const { db, rows } = setup(30);
        const personal = [...new Set(rows.flatMap((row) => [
            row.name,
            row.phone,
            row.phone.replace(/\D/g, ""),
            row.email,
            row.email.split("@")[0]!,
        ]))];
        const cursors: Array<{ sort: string; token: string }> = [];
        for (const sort of SORTS) {
            for (const direction of ["asc", "desc"] as const) {
                const fetchPage = fetcher(db, { sort, order: direction, limit: 7 });
                const forward = await walkForward(fetchPage);
                const backward = await walkBackward(fetchPage, forward.at(-1)!);
                for (const page of [...forward, ...backward]) {
                    for (const token of [page.pageInfo.startCursor, page.pageInfo.endCursor]) {
                        if (token) cursors.push({ sort, token });
                    }
                }
            }
        }
        expect(cursors.length).toBeGreaterThan(100);
        for (const { sort, token } of cursors) {
            const text = cursorText(token).toLowerCase();
            for (const value of personal) {
                expect(text.includes(value.toLowerCase()), `a ${sort} cursor contains "${value}"`).toBe(false);
            }
        }
    });

    it("names the customer and no value for the name sort, while a plain sort still carries its own value", async () => {
        const { db } = setup(12);
        const byName = await listCustomers(db, { sort: "name", order: "asc", limit: 4 });
        expect(JSON.parse(Buffer.from(byName.pageInfo.endCursor!, "base64url").toString())).toEqual({
            v: 1,
            s: "name",
            d: "asc",
            k: [],
            i: byName.customers[3]!.id,
        });
        // The control: the decode above would show a value if the cursor held one.
        const byCreated = await listCustomers(db, { sort: "createdAt", order: "asc", limit: 4 });
        expect(JSON.parse(Buffer.from(byCreated.pageInfo.endCursor!, "base64url").toString()).k).toEqual([expect.any(Number)]);
    });

    it("refuses a cursor that still carries a name, and a reference cursor for another sort", async () => {
        const { db } = setup(12);
        const withName = craftedCursor({ s: "name", d: "asc", k: ["Karim Ali"], i: "cust_0001" });
        await expect(listCustomers(db, { sort: "name", order: "asc", after: withName }))
            .rejects.toMatchObject({ status: 400, code: "invalid_cursor" });
        const reference = craftedCursor({ s: "totalSpent", d: "desc", k: [], i: "cust_0001" });
        await expect(listCustomers(db, { sort: "totalSpent", order: "desc", after: reference }))
            .rejects.toMatchObject({ status: 400, code: "invalid_cursor" });
    });

    it("reads the boundary customer's name by id, and a vanished customer is a typed 400 rather than an empty page", async () => {
        const { db, sqlite, rows } = setup(24);
        const first = await listCustomers(db, { sort: "name", order: "asc", limit: 6 });
        const cursor = first.pageInfo.endCursor!;
        const next = await listCustomers(db, { sort: "name", order: "asc", limit: 6, after: cursor });
        expect(next.customers.map((customer) => customer.id)).toEqual(expectedOrder(rows, "name", "asc").slice(6, 12));

        sqlite.exec(`DELETE FROM customers WHERE id = '${first.customers[5]!.id}'`);
        await expect(listCustomers(db, { sort: "name", order: "asc", limit: 6, after: cursor }))
            .rejects.toMatchObject({ status: 400, code: "invalid_cursor", message: expect.stringContaining("no longer exists") });
    });
});
