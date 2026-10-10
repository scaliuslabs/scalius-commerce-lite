// The order list at scale (migration 0127): every page reads its ids from one
// list index in sort order (no sort of the whole table), a search, an open
// request or cash still out is read first when it names few orders, and a
// phone, email or courier id is found through an index. SQLite on D1 has no
// table statistics, so the plans here are the plans a million-order store
// gets; the measured timings are in migration 0127's notes.
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { LIST_LEAD_LIMIT } from "../../../utils/list-lead";
import { type CapturedQuery, pageKeysPlan, SORTS_THE_TABLE } from "../../../testing/list-plans";
import { listOrders, listMatchingArchivableOrders } from "./list";

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

function seed(sqlite: DatabaseSync, rows: Array<{ id: string; name?: string; phone?: string; email?: string; status?: string; method?: string; balance?: number; createdAt?: number }>) {
    const insert = sqlite.prepare(`INSERT INTO orders (
        id, customer_name, customer_phone, customer_email, shipping_address, city, zone,
        total_amount_minor, shipping_amount_minor, payment_method, status, payment_status,
        paid_amount_minor, balance_due_minor, currency_code, currency_decimal_places, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'Mirpur', 'city', 'zone', 1000, 0, ?, ?, 'unpaid', 0, ?, 'BDT', 2, ?, ?)`);
    sqlite.exec("BEGIN");
    for (const [index, row] of rows.entries()) {
        const createdAt = row.createdAt ?? 1_700_000_000 + index;
        insert.run(row.id, row.name ?? "Arif Ahmed", row.phone ?? `+88017${String(10000000 + index)}`, row.email ?? null,
            row.method ?? "cod", row.status ?? "pending", row.balance ?? 1000, createdAt, createdAt);
    }
    sqlite.exec("COMMIT");
}

const DATA = /"orders"\."id" in \(select "id" from "orders"/;
const pageKeys = (sqlite: DatabaseSync, queries: CapturedQuery[]) => pageKeysPlan(sqlite, queries, DATA);

describe("order list plans (migration 0127)", () => {
    const cases: Array<[string, Parameters<typeof listOrders>[1], RegExp]> = [
        ["newest first", { sort: "createdAt", order: "desc" }, /orders_list_created_idx/],
        ["oldest first", { sort: "createdAt", order: "asc" }, /orders_list_created_idx/],
        ["recently updated", { sort: "updatedAt", order: "desc" }, /orders_list_updated_idx/],
        ["by total", { sort: "totalAmount", order: "desc" }, /orders_list_total_idx/],
        ["by customer", { sort: "customerName", order: "asc" }, /orders_list_customer_name_idx/],
        ["archived", { sort: "createdAt", order: "desc", showArchived: true }, /orders_list_archived_idx/],
        ["a status", { sort: "createdAt", order: "desc", status: "delivered" }, /orders_list_status_idx/],
        ["Returned", { sort: "createdAt", order: "desc", view: "returned" }, /orders_list_status_idx/],
        ["a payment status", { sort: "createdAt", order: "desc", paymentStatus: "paid" }, /orders_list_payment_status_idx/],
        ["a payment method", { sort: "createdAt", order: "desc", paymentMethod: "stripe" }, /orders_list_payment_method_idx/],
        ["a fulfillment status", { sort: "createdAt", order: "desc", fulfillmentStatus: "complete" }, /orders_list_fulfillment_idx/],
        ["a channel", { sort: "createdAt", order: "desc", channel: "admin" }, /orders_list_channel_idx/],
        ["pickup", { sort: "createdAt", order: "desc", deliveryMethod: "pickup" }, /orders_list_pickup_idx/],
        ["Ready for pickup", { sort: "createdAt", order: "desc", view: "ready_for_pickup" }, /orders_list_pickup_idx/],
        ["a date range", { sort: "createdAt", order: "desc", startDate: new Date(1_700_000_000_000), endDate: new Date(1_800_000_000_000) }, /orders_list_created_idx/],
    ];

    for (const [label, options, index] of cases) {
        it(`reads a page ${label} from ${index.source} in order, never sorting the table`, async () => {
            const { db, sqlite, queries } = setup();
            await listOrders(db, { limit: 50, ...options });
            const plan = pageKeys(sqlite, queries);
            expect(plan).toMatch(new RegExp(`USING (COVERING )?INDEX ${index.source}`));
            expect(plan).not.toMatch(SORTS_THE_TABLE);
        });
    }

    it("reads a narrow search's matches by rowid and walks the sort index for a wide one", async () => {
        const { db, sqlite, queries } = setup();
        seed(sqlite, [
            { id: "ord_rare", name: "Zarin Tasnim" },
            ...Array.from({ length: LIST_LEAD_LIMIT + 1 }, (_, index) => ({ id: `ord_${index}`, name: "Karim Ali" })),
        ]);
        const rare = await listOrders(db, { search: "Zarin", sort: "relevance", limit: 50 });
        expect(rare.orders.map((order) => order.id)).toEqual(["ord_rare"]);
        expect(pageKeys(sqlite, queries)).toMatch(/INTEGER PRIMARY KEY \(rowid=\?\)/);

        queries.length = 0;
        const wide = await listOrders(db, { search: "Karim", sort: "relevance", limit: 50 });
        expect(wide.orders).toHaveLength(50);
        expect(wide.pagination.totalIsCapped || wide.pagination.total > LIST_LEAD_LIMIT).toBe(true);
        const plan = pageKeys(sqlite, queries);
        expect(plan).toMatch(/USING (COVERING )?INDEX orders_list_created_idx/);
        expect(plan).not.toMatch(SORTS_THE_TABLE);
    });

    it("reads open requests and cash still out first", async () => {
        const { db, sqlite, queries } = setup();
        for (const options of [{ openRequest: true }, { view: "cod_to_collect" as const }, { view: "delivery_failed" as const }]) {
            queries.length = 0;
            await listOrders(db, { limit: 50, sort: "createdAt", order: "desc", ...options });
            expect(pageKeys(sqlite, queries), JSON.stringify(options)).toMatch(/^SEARCH orders USING (INTEGER PRIMARY KEY|INDEX orders_status_idx) \((status=\? AND )?rowid=\?\)/);
        }
    });
});

describe("order list search", () => {
    it("finds a phone in any written form from its start, an email exactly and a courier id in any case", async () => {
        const { db, sqlite } = setup();
        seed(sqlite, [
            { id: "ord_phone", phone: "+8801712345678" },
            { id: "ord_email", email: "rahim@example.com" },
            { id: "ord_email_longer", email: "rahima@example.com" },
            { id: "ord_courier" },
        ]);
        sqlite.exec("INSERT INTO delivery_shipments (id, order_id, tracking_id, external_id) VALUES ('shp_1', 'ord_courier', 'DX12AB', 'CN-778')");
        const find = async (search: string) => (await listOrders(db, { search, sort: "relevance", limit: 50 })).orders.map((order) => order.id);

        for (const typed of ["01712345678", "01712 345678", "+880 1712-345678", "1712345678", "০১৭১২৩৪৫৬৭৮", "01712"]) {
            expect(await find(typed), typed).toEqual(["ord_phone"]);
        }
        expect(await find("rahim@example.com")).toEqual(["ord_email"]);
        expect(await find("dx12ab")).toEqual(["ord_courier"]);
        expect(await find("cn-778")).toEqual(["ord_courier"]);
    });

    it("archives all matching a narrow search in id-ordered slices", async () => {
        const { db, sqlite } = setup();
        seed(sqlite, [
            { id: "ord_a", name: "Zarin", status: "delivered" },
            { id: "ord_b", name: "Zarin", status: "pending" },
            { id: "ord_c", name: "Karim", status: "delivered" },
        ]);
        const slice = await listMatchingArchivableOrders(db, { search: "Zarin" }, undefined);
        expect(slice.claims.map((claim) => claim.id)).toEqual(["ord_a"]);
        expect(slice.next).toBeNull();
    });
});
