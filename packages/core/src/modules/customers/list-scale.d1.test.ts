// The customer list at scale (migration 0127): each sort reads its page ids
// from one list index in order; a search, a tag or a channel's subscribers
// is read first when it names few customers; a phone is found from its start
// in any written form through the FTS index, never by scanning customers.
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { type CapturedQuery, pageKeysPlan, SORTS_THE_TABLE } from "../../testing/list-plans";
import { listCustomers } from "./customers.service";

const harnesses: Array<{ sqlite: DatabaseSync }> = [];
afterEach(() => {
    for (const harness of harnesses.splice(0)) harness.sqlite.close();
});

function setup() {
    const queries: CapturedQuery[] = [];
    const harness = createSqliteD1Database({ onQuery: (query, values) => queries.push({ query, values }) });
    harnesses.push(harness);
    return { ...harness, queries };
}

const DATA = /"customers"\."id" in \(select "customers"\."id" from "customers"/;

describe("customer list plans (migration 0127)", () => {
    const cases: Array<[string, Parameters<typeof listCustomers>[1], RegExp]> = [
        ["recently updated", { sort: "updatedAt", order: "desc" }, /customers_list_updated_idx/],
        ["newest", { sort: "createdAt", order: "desc" }, /customers_list_created_idx/],
        ["by name", { sort: "name", order: "asc" }, /customers_list_name_idx/],
    ];
    for (const [label, options, index] of cases) {
        it(`reads a page ${label} from ${index.source} in order`, async () => {
            const { db, sqlite, queries } = setup();
            await listCustomers(db, { limit: 50, ...options });
            const plan = pageKeysPlan(sqlite, queries, DATA);
            expect(plan).toMatch(new RegExp(`USING (COVERING )?INDEX ${index.source}`));
            expect(plan).not.toMatch(SORTS_THE_TABLE);
        });
    }

    it("reads the trash by deleted_at and a few tagged or subscribed customers by rowid", async () => {
        const { db, sqlite, queries } = setup();
        await listCustomers(db, { limit: 50, showTrashed: true });
        expect(pageKeysPlan(sqlite, queries, DATA)).toMatch(/USING INDEX customers_list_trash_idx/);
        for (const filters of [{ tag: "vip" }, { subscribed: "email" as const }]) {
            queries.length = 0;
            await listCustomers(db, { limit: 50, filters });
            expect(pageKeysPlan(sqlite, queries, DATA), JSON.stringify(filters)).toMatch(/^SEARCH customers USING INTEGER PRIMARY KEY \(rowid=\?\)/);
        }
    });
});

describe("customer list search", () => {
    it("finds a phone in any written form from its start, by index", async () => {
        const { db, sqlite, queries } = setup();
        sqlite.exec(`INSERT INTO customers (id, name, phone) VALUES
            ('cus_phone', 'Rahim Uddin', '+8801712345678'),
            ('cus_other', 'Karim Ali', '+8801812000000')`);
        for (const typed of ["01712345678", "01712 345678", "+880 1712-345678", "1712345678", "01712"]) {
            queries.length = 0;
            const result = await listCustomers(db, { search: typed, limit: 50 });
            expect(result.customers.map((customer) => customer.id), typed).toEqual(["cus_phone"]);
            expect(pageKeysPlan(sqlite, queries, DATA)).toMatch(/^SEARCH customers USING INTEGER PRIMARY KEY \(rowid=\?\)/);
        }
        expect((await listCustomers(db, { search: "Karim", limit: 50 })).customers.map((customer) => customer.id)).toEqual(["cus_other"]);
    });
});
