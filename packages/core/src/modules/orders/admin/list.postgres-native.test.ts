// PostgreSQL parity for the dashboard lists' scale paths (migration 0127):
// PostgreSQL has no rowid and no unary `+` on text, so the order and
// customer lists keep their portable conditions there (named sets by id,
// the search through the FTS fallback). Opt-in: point
// SCALIUS_TEST_POSTGRES_URL at a disposable server; the test creates and
// drops its own database.
import { afterAll, describe, expect, it } from "vitest";

import { getDb } from "@scalius/database/client";
import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "@scalius/database/testing/postgres-native";

import { listCustomers } from "../../customers/customers.service";
import { listOrders } from "./list";

const postgresUrl = nativePostgresUrl();

afterAll(closeNativePostgres);

describe.runIf(postgresUrl)("dashboard lists on PostgreSQL", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
    it("searches, filters and pages orders and customers", async () => {
        const { client, url } = await createNativePostgres({ label: "dashboard-lists" });
        // Through getDb, as a Worker opens it, so the lists know they run on PostgreSQL.
        const db = getDb({ DATABASE_PROVIDER: "postgres", POSTGRES_DATABASE_URL: url } as never);
        await client.query(`
            INSERT INTO orders (id, customer_name, customer_phone, customer_email, shipping_address, city, zone,
                total_amount_minor, shipping_amount_minor, payment_method, status, payment_status,
                paid_amount_minor, balance_due_minor, currency_code, currency_decimal_places, created_at, updated_at, archived_at)
            VALUES
                ('ord_a', 'Rahim Uddin', '+8801712345678', 'rahim@example.com', 'Mirpur', 'c', 'z', 1000, 0, 'cod', 'shipped', 'unpaid', 0, 1000, 'BDT', 2, 1700000001, 1700000001, NULL),
                ('ord_b', 'Karim Ali', '+8801812000000', NULL, 'Mirpur', 'c', 'z', 2000, 0, 'cod', 'pending', 'unpaid', 0, 2000, 'BDT', 2, 1700000002, 1700000002, NULL),
                ('ord_c', 'Zarin', '+8801912000000', NULL, 'Mirpur', 'c', 'z', 3000, 0, 'cod', 'delivered', 'paid', 3000, 0, 'BDT', 2, 1700000003, 1700000003, 1700000100);
            INSERT INTO cod_tracking (id, order_id, cod_status) VALUES ('cod_a', 'ord_a', 'pending');
            INSERT INTO delivery_shipments (id, order_id, tracking_id) VALUES ('shp_b', 'ord_b', 'DX12AB');
            INSERT INTO customers (id, name, phone) VALUES ('cus_a', 'Rahim Uddin', '+8801712345678'), ('cus_b', 'Karim Ali', '+8801812000000');
            INSERT INTO customer_tag_links (customer_id, tag) VALUES ('cus_b', 'vip');
        `);
        const orderIds = async (options: Parameters<typeof listOrders>[1]) => (await listOrders(db, { limit: 50, ...options })).orders.map((order) => order.id);

        expect(await orderIds({ sort: "createdAt", order: "desc" })).toEqual(["ord_b", "ord_a"]);
        expect(await orderIds({ sort: "totalAmount", order: "desc" })).toEqual(["ord_b", "ord_a"]);
        expect(await orderIds({ showArchived: true })).toEqual(["ord_c"]);
        expect(await orderIds({ view: "cod_to_collect" })).toEqual(["ord_a"]);
        expect(await orderIds({ search: "01712345678", sort: "relevance" })).toEqual(["ord_a"]);
        expect(await orderIds({ search: "rahim@example.com", sort: "relevance" })).toEqual(["ord_a"]);
        expect(await orderIds({ search: "dx12ab", sort: "relevance" })).toEqual(["ord_b"]);

        const customerIds = async (options: Parameters<typeof listCustomers>[1]) => (await listCustomers(db, { limit: 50, ...options })).customers.map((customer) => customer.id);
        expect(await customerIds({ sort: "name", order: "asc" })).toEqual(["cus_b", "cus_a"]);
        expect(await customerIds({ filters: { tag: "vip" } })).toEqual(["cus_b"]);
        expect(await customerIds({ search: "01712" })).toEqual(["cus_a"]);
        expect(await customerIds({ showTrashed: true })).toEqual([]);

    });
});
