// Where an order came from (COMMERCE-HOOKS H2) through the dashboard order
// routes on the real migrated schema: create stamps it, list/detail/export
// expose and filter it.
import { OpenAPIHono } from "@hono/zod-openapi";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { errorResponseFromError } from "../../utils/api-response";
import { adminOrdersRoutes } from "./orders";

type ListBody = { data: { orders: Array<{ id: string; channel: string; channelSource: string | null }> } };

describe("admin order channel routes", () => {
    let sqlite: DatabaseSync;
    let app: OpenAPIHono<{ Bindings: Env }>;

    beforeAll(() => {
        const { sqlite: migrated, db } = createSqliteD1Database();
        sqlite = migrated;
        sqlite.exec(`
            INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active)
            VALUES ('city_1', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1),
                   ('zone_1', 'North', 'BD', 2, 'city_1', '{}', '{}', 1);
            INSERT INTO products (id, name, slug, price_minor, is_active)
            VALUES ('product_1', 'Kurta', 'kurta', 80000, 1);
            INSERT INTO product_variants
              (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory)
            VALUES ('variant_1', 'product_1', 'KURTA-M', 80000, 50, 0, 0, 1, 1);
        `);
        const insert = sqlite.prepare(`INSERT INTO orders (
            id, customer_name, customer_phone, shipping_address, city, zone,
            total_amount_minor, shipping_amount_minor, payment_method, status, payment_status,
            paid_amount_minor, balance_due_minor, currency_code, currency_decimal_places,
            channel, channel_source, created_at, updated_at
        ) VALUES (?, 'Buyer', '+8801700000000', 'Test address', 'city_1', 'zone_1',
            10000, 0, 'cod', 'pending', 'unpaid', 0, 10000, 'BDT', 2, ?, ?, ?, ?)`);
        insert.run("web_1", "online_store", null, 1_700_000_001, 1_700_000_001);
        insert.run("agent_1", "agent", null, 1_700_000_002, 1_700_000_002);
        insert.run("staff_fb", "admin", "facebook", 1_700_000_003, 1_700_000_003);
        insert.run("staff_walk", "admin", "walk_in", 1_700_000_004, 1_700_000_004);

        app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
        app.onError((error, c) => {
            const { body, status } = errorResponseFromError(error);
            return c.json(body, status);
        });
        app.use("*", async (c, next) => {
            c.set("db", db);
            c.set("user", { id: "admin_1" } as never);
            await next();
        });
        app.route("/orders", adminOrdersRoutes);
    });

    afterAll(() => sqlite?.close());

    async function list(query: string) {
        const response = await app.request(`/api/v1/admin/orders?sort=createdAt&order=asc&${query}`);
        return { status: response.status, body: response.status === 200 ? await response.json() as ListBody : null };
    }

    it("lists every order with its channel and source", async () => {
        const { body } = await list("");
        expect(body?.data.orders.map(({ id, channel, channelSource }) => ({ id, channel, channelSource }))).toEqual([
            { id: "web_1", channel: "online_store", channelSource: null },
            { id: "agent_1", channel: "agent", channelSource: null },
            { id: "staff_fb", channel: "admin", channelSource: "facebook" },
            { id: "staff_walk", channel: "admin", channelSource: "walk_in" },
        ]);
    });

    it("filters by channel and by stored source slug, and refuses unknown values", async () => {
        const ids = async (query: string) => (await list(query)).body?.data.orders.map((order) => order.id);
        expect(await ids("channel=admin")).toEqual(["staff_fb", "staff_walk"]);
        expect(await ids("channel=agent")).toEqual(["agent_1"]);
        expect(await ids("channel=admin&channelSource=walk_in")).toEqual(["staff_walk"]);
        expect(await ids("channel=pos")).toEqual([]);
        for (const bad of ["channel=dashboard", "channelSource=Facebook", "channelSource=walk-in", `channelSource=${"a".repeat(65)}`]) {
            expect((await list(bad)).status, bad).toBe(400);
        }
    });

    it("shows the channel on the order page", async () => {
        const response = await app.request("/api/v1/admin/orders/staff_fb");
        expect(response.status).toBe(200);
        expect((await response.json() as { data: unknown }).data).toMatchObject({ channel: "admin", channelSource: "facebook" });
    });

    it("exports the filtered orders with Channel and Source columns", async () => {
        const response = await app.request("/api/v1/admin/orders/export?channel=admin&sort=createdAt&order=asc");
        expect(response.status).toBe(200);
        const [header, ...rows] = (await response.text()).split("\n");
        expect(header).toContain('"Channel","Source"');
        expect(rows).toHaveLength(2);
        expect(rows[0]).toContain('"Dashboard","Facebook"');
        expect(rows[1]).toContain('"Dashboard","Walk-in"');
    });

    it("creates a dashboard order under admin with the normalized source, and refuses an unreadable one", async () => {
        const create = (channelSource: unknown) => app.request("/api/v1/admin/orders", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
            body: JSON.stringify({
                customerName: "Rahim Uddin",
                customerPhone: "+8801712345601",
                customerEmail: null,
                shippingAddress: "House 1, Road 2, Gulshan",
                city: "city_1",
                zone: "zone_1",
                area: null,
                notes: null,
                discountAmount: null,
                shippingCharge: 80,
                items: [{ productId: "product_1", variantId: "variant_1", quantity: 1 }],
                channelSource,
            }),
        });
        const created = await create("WhatsApp Business");
        expect(created.status).toBe(201);
        const { data } = await created.json() as { data: { id: string } };
        expect(sqlite.prepare("SELECT channel, channel_source FROM orders WHERE id = ?").get(data.id))
            .toEqual({ channel: "admin", channel_source: "whatsapp_business" });

        expect((await create("!!!")).status).toBe(400);
        expect((await create("a".repeat(65))).status).toBe(400);
    });
});
