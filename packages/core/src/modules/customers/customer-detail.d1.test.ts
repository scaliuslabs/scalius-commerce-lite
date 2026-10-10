// The customer page at scale: every statement it issues reads the customer's
// own orders through `orders_customer_activity_idx`, never every live order.
// Drizzle renders a single-table select's columns unqualified, so a
// correlated subquery that named the outer customer as `id` bound to
// `orders.id` instead: it read a million orders (61 s on the 1M-order store)
// and found no name.
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { CapturedQuery } from "../../testing/list-plans";
import { getCustomerDetail } from "./customers.service";

const harnesses: Array<{ sqlite: DatabaseSync }> = [];
afterEach(() => {
    for (const harness of harnesses.splice(0)) harness.sqlite.close();
});

/** Plan steps that read orders without the customer's key. */
const READS_EVERY_ORDER = /^SCAN orders\b|USING (COVERING )?INDEX orders_\w+ \(deleted_at=\?\)$/;

describe("customer detail", () => {
    it("names the latest order and reads only the customer's orders", async () => {
        const queries: CapturedQuery[] = [];
        const harness = createSqliteD1Database({ onQuery: (query, values) => queries.push({ query, values }) });
        harnesses.push(harness);
        const { sqlite, db } = harness;
        sqlite.exec(`
            INSERT INTO customers (id, name, phone) VALUES ('cus_a', 'Rahim', '+8801712345678');
            INSERT INTO orders (id, customer_id, customer_name, customer_phone, shipping_address, city, zone,
                total_amount_minor, shipping_amount_minor, payment_method, status, payment_status,
                paid_amount_minor, balance_due_minor, currency_code, currency_decimal_places, created_at, updated_at)
            VALUES
                ('ord_old', 'cus_a', 'Rahim Uddin', '+8801712345678', 'Mirpur', 'c', 'z', 1000, 0, 'cod', 'delivered', 'paid', 1000, 0, 'BDT', 2, 1700000001, 1700000001),
                ('ord_new', 'cus_a', 'Rahim U.', '+8801712345678', 'Mirpur', 'c', 'z', 2000, 0, 'cod', 'pending', 'unpaid', 0, 2000, 'BDT', 2, 1700000009, 1700000009),
                ('ord_other', NULL, 'Someone', '+8801812000000', 'Mirpur', 'c', 'z', 3000, 0, 'cod', 'pending', 'unpaid', 0, 3000, 'BDT', 2, 1700000020, 1700000020);
        `);

        const detail = await getCustomerDetail(db, "cus_a");
        expect(detail?.latestOrderName).toBe("Rahim U.");
        expect(detail?.totalSpent).toBe(10);

        const scans: string[] = [];
        for (const { query, values } of queries) {
            if (!/^\s*select/i.test(query) || !/"orders"/.test(query)) continue;
            const bound = values.map((value) => typeof value === "boolean" ? Number(value) : value) as never[];
            const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...bound) as Array<{ detail: string }>;
            scans.push(...plan.map((row) => row.detail).filter((detail) => READS_EVERY_ORDER.test(detail)));
        }
        expect(scans).toEqual([]);
    });
});
