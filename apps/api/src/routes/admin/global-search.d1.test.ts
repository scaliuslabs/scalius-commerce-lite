import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";

import { errorResponseFromError } from "../../utils/api-response";
import { adminSearchRoutes, readableSearchKinds } from "./search";
import { phoneLookupValues, type GlobalSearchResult } from "./global-search";

const SEED = `
  INSERT INTO orders (id, order_number, customer_name, customer_phone, customer_email, shipping_address, city, zone, status, total_amount_minor, created_at)
    VALUES ('ord_old', 1001, 'Rahim Uddin', '+8801711111111', 'rahim@shop.test', 'House 1', 'c', 'z', 'confirmed', 1000, 100),
           ('ord_new', 1002, 'Rahima Khatun', '+8801722222222', NULL, 'House 2', 'c', 'z', 'pending', 2000, 200);
  INSERT INTO customers (id, name, phone, email, origin) VALUES
    ('cus_rahim', 'Rahim Uddin', '+8801711111111', 'rahim@shop.test', 'merchant'),
    ('cus_nasir', 'Nasir', '+8801733333333', NULL, 'order');
  INSERT INTO products (id, name, price_minor, slug, is_active) VALUES
    ('p_panjabi', 'Cotton panjabi', 150000, 'cotton-panjabi', 1),
    ('p_mug', 'Clay mug', 50000, 'clay-mug', 0);
  INSERT INTO product_variants (id, product_id, sku, barcode, barcode_type, price_minor, stock, reserved_stock, is_default, track_inventory)
    VALUES ('v_panjabi', 'p_panjabi', 'PNJ-RED-L', '4006381333931', 'EAN13', 150000, 5, 0, 1, 1),
           ('v_mug', 'p_mug', 'MUG-1', NULL, NULL, 50000, 5, 0, 1, 1);
  INSERT INTO promotions (id, name, method, status) VALUES ('promo_eid', 'Eid sale', 'code', 'active');
  INSERT INTO promotion_codes (id, promotion_id, code, normalized_code) VALUES ('pc_eid', 'promo_eid', 'EID10', 'EID10');
  INSERT INTO collections (id, name, presentation, config, sort_order) VALUES ('col_eid', 'Eid picks', 'grid', '{}', 0);
  INSERT INTO categories (id, name, slug, status) VALUES ('cat_panjabi', 'Panjabi', 'panjabi', 'published');
  INSERT INTO pages (id, title, slug, content, is_published) VALUES ('pg_refund', 'Refunds', 'refunds', '<p>panjabi</p>', 1);
`;

const ALL = new Set(Object.values(PERMISSIONS) as string[]);

function createTestApp(permissions: ReadonlySet<string> = ALL) {
    const statements: Array<{ query: string; values: unknown[] }> = [];
    const { sqlite, db } = createSqliteD1Database({
        onQuery: (query, values) => statements.push({ query, values: [...values] }),
    });
    sqlite.exec(SEED);
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
    app.onError((error, c) => {
        const { body, status } = errorResponseFromError(error);
        return c.json(body, status);
    });
    app.use("*", async (c, next) => {
        c.set("db", db);
        c.set("adminPermissions", new Set(permissions));
        await next();
    });
    app.route("/admin/search", adminSearchRoutes);
    const search = async (q: string) => {
        statements.length = 0;
        const response = await app.request(`/api/v1/admin/search/global?q=${encodeURIComponent(q)}`);
        expect(response.status).toBe(200);
        return ((await response.json()) as { data: GlobalSearchResult }).data;
    };
    return { sqlite, search, statements };
}

describe("dashboard global search", () => {
    it("finds an order by number, phone or email, newest first", async () => {
        const { search } = createTestApp();
        expect((await search("#1001")).orders.map((order) => order.id)).toEqual(["ord_old"]);
        expect((await search("১০০২")).orders.map((order) => order.id)).toEqual(["ord_new"]);
        expect((await search("01711-111111")).orders.map((order) => order.id)).toEqual(["ord_old"]);
        expect((await search("RAHIM@shop.test")).orders.map((order) => order.id)).toEqual(["ord_old"]);
        // Words match by prefix: "rahi" finds both buyers, the newest order first.
        expect((await search("rahi")).orders.map((order) => order.id)).toEqual(["ord_new", "ord_old"]);
    });

    it("finds customers, products by name, SKU or barcode, discounts by code prefix, and content", async () => {
        const { search } = createTestApp();
        const byPhone = await search("+880 1733-333333");
        expect(byPhone.customers.map((customer) => customer.id)).toEqual(["cus_nasir"]);

        expect((await search("pnj-red-l")).products).toEqual([
            { id: "p_panjabi", name: "Cotton panjabi", isActive: true, matchedSku: "PNJ-RED-L" },
        ]);
        expect((await search("4006381333931")).products.map((product) => product.id)).toEqual(["p_panjabi"]);
        expect((await search("clay")).products).toEqual([{ id: "p_mug", name: "Clay mug", isActive: false, matchedSku: null }]);

        const eid = await search("eid");
        expect(eid.discounts).toEqual([{ id: "promo_eid", name: "Eid sale", code: "EID10", status: "active" }]);
        expect(eid.collections.map((collection) => collection.id)).toEqual(["col_eid"]);

        const panjabi = await search("panjabi");
        expect(panjabi.categories.map((category) => category.id)).toEqual(["cat_panjabi"]);
        // Pages match by title, not by every word in their body.
        expect(panjabi.pages).toEqual([]);
        expect((await search("refu")).pages).toEqual([{ id: "pg_refund", title: "Refunds", contentType: "page" }]);
    });

    it("searches only the kinds the staff member may read", async () => {
        const kinds = readableSearchKinds(new Set([PERMISSIONS.PRODUCTS_VIEW]));
        expect(kinds).toEqual(["products"]);
        const { search } = createTestApp(new Set([PERMISSIONS.PRODUCTS_VIEW]));
        const result = await search("rahim");
        expect(result.orders).toEqual([]);
        expect(result.customers).toEqual([]);
    });

    it("never scans a large table: every lookup is an index search or an FTS5 read (1M-order safe)", async () => {
        const { sqlite, search, statements } = createTestApp();
        const LARGE = /\bSCAN (orders|customers|products|product_variants|promotion_codes)\b(?! VIRTUAL)/;
        for (const term of ["#1001", "01711111111", "rahim@shop.test", "rahim", "pnj-red-l", "eid"]) {
            await search(term);
            for (const { query, values } of statements) {
                const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...(values as never[])) as Array<{ detail: string }>;
                const details = plan.map((step) => step.detail).join("\n");
                expect(details, `${term}: ${query}`).not.toMatch(LARGE);
            }
            expect(Math.max(0, ...statements.map((statement) => statement.values.length))).toBeLessThanOrEqual(100);
        }
    });

    it("looks up a whole phone number in each stored form, and never a fragment", () => {
        expect(phoneLookupValues("01711-111111")).toEqual(expect.arrayContaining(["+8801711111111", "01711111111"]));
        expect(phoneLookupValues("1711")).toEqual([]);
    });
});
