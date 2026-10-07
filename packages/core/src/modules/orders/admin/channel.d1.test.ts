// Where an order came from (COMMERCE-HOOKS H2) on the real migrated schema:
// the dashboard create path stamps `admin` plus a normalized source, and the
// list, detail and export read both back.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { ORDER_CHANNEL_VALUES } from "@scalius/database/schema";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { ORDER_CHANNELS } from "@scalius/shared/order-channel";
import { createOrdersCsvArtifactBuilder } from "../csv-export";
import { createOrderSchema, type CreateOrderInput } from "../validation";
import { ADMIN_ORDER_CREATE_REQUEST_MISMATCH } from "./create-attempts";
import { createOrder } from "./create";
import { getOrderDetails } from "./detail";
import { listOrders, loadOrderExportDetails } from "./list";

describe("order channel on D1 storage", () => {
    let sqlite: DatabaseSync;
    let db: Database;

    beforeEach(() => {
        ({ sqlite, db } = createSqliteD1Database());
        sqlite.exec(`
            INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active)
            VALUES
              ('city_1', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1),
              ('zone_1', 'North', 'BD', 2, 'city_1', '{}', '{}', 1);
            INSERT INTO products (id, name, slug, price_minor, is_active)
            VALUES ('product_1', 'Kurta', 'kurta', 80000, 1);
            INSERT INTO product_variants
              (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory)
            VALUES ('variant_1', 'product_1', 'KURTA-M', 80000, 50, 0, 0, 1, 1);
        `);
    });

    afterEach(() => sqlite.close());

    const stored = (id: string) => sqlite.prepare("SELECT channel, channel_source FROM orders WHERE id = ?").get(id);

    function input(overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
        return {
            requestKey: crypto.randomUUID(),
            customerName: "Rahim Uddin",
            customerPhone: "+8801712345601",
            customerEmail: null,
            shippingAddress: "House 1, Road 2, Gulshan",
            city: "city_1",
            zone: "zone_1",
            area: null,
            notes: null,
            items: [{ productId: "product_1", variantId: "variant_1", quantity: 1 }],
            discountAmount: null,
            shippingCharge: 80,
            ...overrides,
        };
    }

    /** A storefront checkout order as the checkout commit writes it. */
    function storefrontOrder(id: string) {
        sqlite.exec(`
            INSERT INTO orders (
              id, order_number, customer_name, customer_phone, shipping_address, city, zone,
              currency_code, currency_decimal_places, subtotal_amount_minor, shipping_amount_minor,
              total_amount_minor, status, payment_method, payment_status, paid_amount_minor,
              balance_due_minor, fulfillment_status, channel, channel_source, version
            ) VALUES (
              '${id}', 5001, 'Karim', '+8801812345602', 'Village road, Savar', 'city_1', 'zone_1',
              'BDT', 2, 80000, 8000, 88000, 'pending', 'cod', 'unpaid', 0, 88000, 'pending',
              'online_store', NULL, 1
            );
        `);
    }

    it("keeps the database vocabulary equal to the shared one", () => {
        expect([...ORDER_CHANNEL_VALUES]).toEqual([...ORDER_CHANNELS]);
    });

    it.each([
        [undefined, null],
        [null, null],
        ["", null],
        ["facebook", "facebook"],
        ["Walk-in", "walk_in"],
        ["ফেসবুক পেজ", "fesbuk_pej"],
    ])("stamps a dashboard order admin with source %j stored as %j", async (channelSource, expected) => {
        const { id } = await createOrder(db, input({ channelSource }), "admin_1");
        expect(stored(id)).toEqual({ channel: "admin", channel_source: expected });
    });

    it("validates the source a staff member types", () => {
        const parse = (channelSource: unknown) => createOrderSchema.safeParse({ ...input(), channelSource });
        for (const accepted of [undefined, null, "", "  ", "whatsapp", "Daraz shop", "ফেসবুক পেজ", "a".repeat(64)]) {
            expect(parse(accepted).success, String(accepted)).toBe(true);
        }
        for (const refused of ["!!!", "😀", "a".repeat(65), 42]) {
            expect(parse(refused).success, String(refused)).toBe(false);
        }
    });

    it("treats a differently spelled same source as the same request, and another source as a different one", async () => {
        const requestKey = crypto.randomUUID();
        const first = await createOrder(db, input({ requestKey, channelSource: "Facebook" }), "admin_1");
        const replay = await createOrder(db, input({ requestKey, channelSource: " facebook " }), "admin_1");
        expect(replay.id).toBe(first.id);
        await expect(createOrder(db, input({ requestKey, channelSource: "whatsapp" }), "admin_1"))
            .rejects.toMatchObject({ code: ADMIN_ORDER_CREATE_REQUEST_MISMATCH });
        await expect(createOrder(db, input({ requestKey }), "admin_1"))
            .rejects.toMatchObject({ code: ADMIN_ORDER_CREATE_REQUEST_MISMATCH });
        expect(Number(sqlite.prepare("SELECT COUNT(*) AS count FROM orders").get()?.count)).toBe(1);
    });

    it("never lets an order change channel after it was placed", async () => {
        const { id } = await createOrder(db, input({ channelSource: "phone" }), "admin_1");
        expect(() => sqlite.prepare("UPDATE orders SET channel = 'online_store' WHERE id = ?").run(id)).toThrow();
        expect(stored(id)).toEqual({ channel: "admin", channel_source: "phone" });
    });

    it("filters the list by channel and source and shows both on the list and detail", async () => {
        storefrontOrder("store_1");
        const walkIn = await createOrder(db, input({ channelSource: "walk_in" }), "admin_1");
        const facebook = await createOrder(db, input({ channelSource: "facebook" }), "admin_1");

        const ids = async (options: Parameters<typeof listOrders>[1]) =>
            (await listOrders(db, options)).orders.map((order) => order.id).sort();

        expect(await ids({})).toEqual(["store_1", walkIn.id, facebook.id].sort());
        expect(await ids({ channel: "online_store" })).toEqual(["store_1"]);
        expect(await ids({ channel: "admin" })).toEqual([walkIn.id, facebook.id].sort());
        expect(await ids({ channel: "admin", channelSource: "facebook" })).toEqual([facebook.id]);
        expect(await ids({ channelSource: "walk_in" })).toEqual([walkIn.id]);
        expect(await ids({ channel: "agent" })).toEqual([]);

        const listed = (await listOrders(db, { channel: "admin", channelSource: "walk_in" })).orders[0];
        expect(listed).toMatchObject({ channel: "admin", channelSource: "walk_in" });
        expect(await getOrderDetails(db, facebook.id)).toMatchObject({ channel: "admin", channelSource: "facebook" });
        expect(await getOrderDetails(db, "store_1")).toMatchObject({ channel: "online_store", channelSource: null });
    });

    it("exports the channel and source columns from listed orders", async () => {
        storefrontOrder("store_1");
        const walkIn = await createOrder(db, input({ channelSource: "walk_in" }), "admin_1");
        const result = await listOrders(db, { sort: "createdAt", order: "asc" });
        const details = await loadOrderExportDetails(db, result.orders.map((order) => order.id));
        const builder = createOrdersCsvArtifactBuilder("summary");
        for (const order of result.orders) {
            const detail = details.get(order.id)!;
            builder.append({
                ...order,
                subtotalAmount: 0,
                codStatus: order.cod?.status ?? null,
                courierName: detail.courierName,
                trackingId: detail.trackingId,
                shippingAddress: detail.shippingAddress,
                notes: detail.notes,
                lines: detail.lines,
            });
        }
        const [header, ...rows] = builder.finish().chunks.join("").split("\n");
        expect(header).toContain('"Tracking","Channel","Source"');
        const byOrder = new Map(result.orders.map((order, index) => [order.id, rows[index]!]));
        expect(byOrder.get("store_1")).toContain('"Online store",""');
        expect(byOrder.get(walkIn.id)).toContain('"Dashboard","Walk-in"');
    });
});
