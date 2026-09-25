// The fulfilment ledger on the real migrated schema (Wave A §2.8, F1–F3,
// F5–F8, F10): every action inserts ledger rows, fulfilled_quantity is only
// their projection, the ledger is append-only, and the order moves to
// shipped or delivered only through the real actions.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { createOrder } from "../orders/admin/create";
import { getOrderDetails } from "../orders/admin/detail";
import { updateOrderStatus } from "../orders/status/lifecycle";
import { processCodAction } from "./delivery-outcomes";
import {
    recordCourierBookingFulfilment,
    recordOrderFulfilment,
    syncCourierFulfilmentFromShipment,
    voidOrderFulfilment,
} from "./ledger";
import { markOrderReadyForPickup } from "./pickup";
import { autoFulfilOrder, listOrdersAwaitingAutoFulfil } from "./auto-fulfil";
import { FULFILLER_REGISTRY, type FulfillerRegistry } from "./registry";

describe("fulfilment ledger", () => {
    let sqlite: DatabaseSync;
    let db: Database;

    beforeEach(() => {
        ({ sqlite, db } = createSqliteD1Database());
        sqlite.exec(`
            INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata, is_active)
            VALUES ('city_1', 'Dhaka', 'city', NULL, '{}', '{}', 1), ('zone_1', 'North', 'zone', 'city_1', '{}', '{}', 1);
            INSERT INTO products (id, name, slug, price_minor, is_active) VALUES
              ('p_ship', 'Kurta', 'kurta', 80000, 1),
              ('p_svc', 'Tailoring', 'tailoring', 20000, 1);
            INSERT INTO product_variants
              (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
            VALUES
              ('v_ship', 'p_ship', 'KURTA-M', 80000, 20, 0, 0, 1, 1, 'physical'),
              ('v_svc', 'p_svc', 'TAILOR-1', 20000, 0, 0, 0, 1, 0, 'service');
            INSERT INTO shipping_methods (id, name, fee_minor, kind, pickup_address, pickup_hours)
            VALUES ('m_pickup', 'Store pickup', 0, 'pickup', 'Shop 4, Gulshan 1', '10am-8pm');
            INSERT INTO user (id, name, email) VALUES ('admin_1', 'Nadia', 'nadia@example.test');
        `);
    });

    afterEach(() => sqlite.close());

    const one = <T = Record<string, unknown>>(query: string, ...params: Array<string | number>) =>
        sqlite.prepare(query).get(...params) as T;
    const all = <T = Record<string, unknown>>(query: string, ...params: Array<string | number>) =>
        sqlite.prepare(query).all(...params) as T[];
    const admin = { type: "admin" as const, id: "admin_1" };

    async function order(options: {
        items?: Array<{ productId: string; variantId: string; quantity: number }>;
        pickup?: boolean;
    } = {}) {
        const { id } = await createOrder(db, {
            requestKey: crypto.randomUUID(),
            customerName: "Rahim Uddin",
            customerPhone: "+8801712345601",
            customerEmail: null,
            ...(options.pickup
                ? { shippingMethodId: "m_pickup" }
                : { shippingAddress: "House 1, Road 2, Gulshan", city: "city_1", zone: "zone_1", area: null }),
            notes: null,
            items: options.items ?? [{ productId: "p_ship", variantId: "v_ship", quantity: 3 }],
            discountAmount: null,
            shippingCharge: 0,
        } as never, "admin_1");
        return id;
    }

    const lineId = (orderId: string, variantId = "v_ship") =>
        one<{ id: string }>("SELECT id FROM order_items WHERE order_id = ? AND variant_id = ?", orderId, variantId).id;
    const fulfilled = (itemId: string) =>
        one<{ q: number }>("SELECT fulfilled_quantity AS q FROM order_items WHERE id = ?", itemId).q;
    const ledgerSum = (itemId: string) => one<{ q: number }>(`
        SELECT coalesce(sum(l.quantity), 0) AS q FROM order_fulfillment_lines l
        JOIN order_fulfillments f ON f.id = l.fulfillment_id
        WHERE l.order_item_id = ? AND f.status = 'active'`, itemId).q;

    it("F1: fulfilled_quantity equals the active ledger lines through any send/void sequence", async () => {
        const id = await order({ items: [{ productId: "p_ship", variantId: "v_ship", quantity: 9 }] });
        const item = lineId(id);
        // A deterministic pseudo-random walk of sends and voids.
        let seed = 7;
        const next = () => (seed = (seed * 48271) % 2147483647);
        const active: string[] = [];
        for (let step = 0; step < 25; step += 1) {
            const left = 9 - fulfilled(item);
            if (active.length > 0 && (left === 0 || next() % 3 === 0)) {
                const fulfillmentId = active.splice(next() % active.length, 1)[0]!;
                await voidOrderFulfilment(db, id, fulfillmentId);
            } else if (left > 0) {
                const quantity = 1 + (next() % Math.min(left, 3));
                const result = await recordOrderFulfilment(db, id, {
                    requestKey: `k${step}`,
                    kind: "ship",
                    lines: [{ itemId: item, quantity }],
                }, admin);
                if (result.orderStatus === "shipped") break;
                active.push(result.fulfillmentId);
            }
            expect(fulfilled(item)).toBe(ledgerSum(item));
        }
        expect(fulfilled(item)).toBe(ledgerSum(item));
    });

    it("F2/F3/F5: raw writes that bypass the rules are refused by the triggers", async () => {
        const id = await order();
        const item = lineId(id);
        const sent = await recordOrderFulfilment(db, id, { requestKey: "a", kind: "ship", lines: [{ itemId: item, quantity: 2 }] }, admin);

        // F2: over-fulfilment and a kind that doesn't match the line's type.
        expect(() => sqlite.exec(`INSERT INTO order_fulfillment_lines (id, fulfillment_id, order_id, order_item_id, quantity)
            VALUES ('x1', '${sent.fulfillmentId}', '${id}', '${item}', 2)`)).toThrow(/exceeds/);
        sqlite.exec(`INSERT INTO order_fulfillments (id, order_id, kind, request_key, actor_type) VALUES ('f_pick', '${id}', 'pickup', 'raw', 'system')`);
        expect(() => sqlite.exec(`INSERT INTO order_fulfillment_lines (id, fulfillment_id, order_id, order_item_id, quantity)
            VALUES ('x2', 'f_pick', '${id}', '${item}', 1)`)).toThrow(/same order and type/);
        // F3: the ledger is append-only; a fulfilment only moves active -> voided.
        expect(() => sqlite.exec(`UPDATE order_fulfillment_lines SET quantity = 1 WHERE fulfillment_id = '${sent.fulfillmentId}'`)).toThrow(/immutable/);
        expect(() => sqlite.exec(`DELETE FROM order_fulfillment_lines WHERE fulfillment_id = '${sent.fulfillmentId}'`)).toThrow(/immutable/);
        expect(() => sqlite.exec(`UPDATE order_fulfillments SET kind = 'service' WHERE id = '${sent.fulfillmentId}'`)).toThrow(/immutable/);
        expect(() => sqlite.exec(`DELETE FROM order_fulfillments WHERE id = '${sent.fulfillmentId}'`)).toThrow(/durable/);
        // F5: a line's type is frozen at commit.
        expect(() => sqlite.exec(`UPDATE order_items SET fulfillment_type = 'pickup' WHERE id = '${item}'`)).toThrow();
        // A parcel carrying handed-over units can't be deleted.
        expect(() => sqlite.exec(`DELETE FROM delivery_shipments WHERE id = '${sent.shipmentId}'`)).toThrow();
        expect(fulfilled(item)).toBe(2);
    });

    it("F6: ships only once every ship line left; replays a double submit", async () => {
        const id = await order();
        const item = lineId(id);
        const first = await recordOrderFulfilment(db, id, { requestKey: "p1", kind: "ship", lines: [{ itemId: item, quantity: 1 }] }, admin);
        const replay = await recordOrderFulfilment(db, id, { requestKey: "p1", kind: "ship", lines: [{ itemId: item, quantity: 1 }] }, admin);
        expect(replay).toMatchObject({ fulfillmentId: first.fulfillmentId, replayed: true });
        expect(one("SELECT status, fulfillment_status FROM orders WHERE id = ?", id)).toEqual({ status: "confirmed", fulfillment_status: "partial" });
        await expect(recordOrderFulfilment(db, id, { requestKey: "p2", kind: "pickup" }, admin))
            .rejects.toThrow("already been picked up");
        const last = await recordOrderFulfilment(db, id, { requestKey: "p3", kind: "ship" }, admin);
        expect(last).toMatchObject({ orderStatus: "shipped", isFinalShipment: true, statusChange: { newStatus: "shipped" } });
        expect(one("SELECT stock, reserved_stock FROM product_variants WHERE id = 'v_ship'")).toEqual({ stock: 17, reserved_stock: 0 });
        expect(one("SELECT count(*) AS n FROM order_fulfillments WHERE order_id = ?", id)).toEqual({ n: 2 });
    });

    it("F7 pickup: ready for pickup, then picked up with the cash at the counter delivers the order", async () => {
        const id = await order({ pickup: true });
        expect(one("SELECT requires_shipping, shipping_method_kind, pickup_address, shipping_address FROM orders WHERE id = ?", id))
            .toEqual({ requires_shipping: 0, shipping_method_kind: "pickup", pickup_address: "Shop 4, Gulshan 1", shipping_address: null });
        expect(one<{ t: string }>("SELECT fulfillment_type AS t FROM order_items WHERE order_id = ?", id).t).toBe("pickup");

        const ready = await markOrderReadyForPickup(db, id);
        expect(ready).toMatchObject({ replayed: false, notificationOutboxId: expect.any(String) });
        expect(await markOrderReadyForPickup(db, id)).toMatchObject({ replayed: true, notificationOutboxId: null });
        expect(one("SELECT notification_type, subject_type FROM notification_outbox WHERE id = ?", ready.notificationOutboxId!))
            .toEqual({ notification_type: "order_ready_for_pickup", subject_type: "order" });

        await expect(recordOrderFulfilment(db, id, { requestKey: "c1", kind: "pickup", cashReceived: 100 }, admin))
            .rejects.toThrow("Record the full cash balance");
        const picked = await recordOrderFulfilment(db, id, { requestKey: "c2", kind: "pickup", cashReceived: 2400 }, admin);
        expect(picked).toMatchObject({ orderStatus: "delivered", awaitingPayment: false });
        expect(one("SELECT status, payment_status, fulfillment_status FROM orders WHERE id = ?", id))
            .toEqual({ status: "delivered", payment_status: "paid", fulfillment_status: "complete" });
        expect(one("SELECT cash_collected_minor FROM order_fulfillments WHERE id = ?", picked.fulfillmentId))
            .toEqual({ cash_collected_minor: 240000 });
        expect(one("SELECT stock, reserved_stock FROM product_variants WHERE id = 'v_ship'")).toEqual({ stock: 17, reserved_stock: 0 });
    });

    it("F7 pickup without cash waits for the money; recording it from confirmed then delivers", async () => {
        const id = await order({ pickup: true });
        const picked = await recordOrderFulfilment(db, id, { requestKey: "c1", kind: "pickup" }, admin);
        expect(picked).toMatchObject({ orderStatus: "confirmed", awaitingPayment: true });
        await processCodAction(db, id, { action: "collected", collectedBy: "Counter", collectedAmount: 2400 });
        expect(one("SELECT status FROM orders WHERE id = ?", id)).toEqual({ status: "delivered" });
    });

    it("F7 service: marking a service-only order done delivers it; it never ships", async () => {
        const id = await order({ items: [{ productId: "p_svc", variantId: "v_svc", quantity: 1 }] });
        expect(one("SELECT requires_shipping, shipping_method_kind, shipping_address FROM orders WHERE id = ?", id))
            .toEqual({ requires_shipping: 0, shipping_method_kind: null, shipping_address: null });
        await expect(recordOrderFulfilment(db, id, { requestKey: "s0", kind: "ship" }, admin))
            .rejects.toThrow("already been sent");
        // Cash can't be taken before the service is done.
        await expect(processCodAction(db, id, { action: "collected", collectedBy: "Tech", collectedAmount: 200 }))
            .rejects.toThrow("handed over");
        const done = await recordOrderFulfilment(db, id, { requestKey: "s1", kind: "service", cashReceived: 200 }, admin);
        expect(done).toMatchObject({ orderStatus: "delivered" });
    });

    it("F8: cancel is refused once anything is handed over, and allowed again after a void", async () => {
        const id = await order();
        const item = lineId(id);
        const sent = await recordOrderFulfilment(db, id, { requestKey: "a", kind: "ship", lines: [{ itemId: item, quantity: 1 }] }, admin);
        await expect(updateOrderStatus(db, id, "cancelled")).rejects.toThrow("with the courier");
        const detail = await getOrderDetails(db, id);
        expect(detail?.fulfillments[0]).toMatchObject({ id: sent.fulfillmentId, canVoid: true, voidBlockedReason: null });
        await voidOrderFulfilment(db, id, sent.fulfillmentId);
        expect(await voidOrderFulfilment(db, id, sent.fulfillmentId)).toMatchObject({ replayed: true });
        expect(fulfilled(item)).toBe(0);
        expect(one("SELECT fulfillment_status FROM orders WHERE id = ?", id)).toEqual({ fulfillment_status: "pending" });
        expect((await getOrderDetails(db, id))?.fulfillments[0]).toMatchObject({ status: "voided", canVoid: false, voidBlockedReason: "voided" });
        await updateOrderStatus(db, id, "cancelled");
        expect(one("SELECT status FROM orders WHERE id = ?", id)).toEqual({ status: "cancelled" });

        const picked = await order({ pickup: true });
        await recordOrderFulfilment(db, picked, { requestKey: "p", kind: "pickup" }, admin);
        await expect(updateOrderStatus(db, picked, "cancelled")).rejects.toThrow("picked up");
    });

    it("F11: a courier booking records every unsent ship line once and follows the courier's status", async () => {
        const id = await order();
        const item = lineId(id);
        await recordOrderFulfilment(db, id, { requestKey: "own", kind: "ship", lines: [{ itemId: item, quantity: 1 }] }, admin);
        sqlite.exec(`INSERT INTO delivery_shipments (id, order_id, provider_type, status) VALUES ('shp_courier', '${id}', 'pathao', 'pending')`);
        const booked = await recordCourierBookingFulfilment(db, id, "shp_courier");
        expect(booked).toMatchObject({ recorded: true, lines: [{ orderItemId: item, quantity: 2 }] });
        expect(await recordCourierBookingFulfilment(db, id, "shp_courier")).toMatchObject({ recorded: false });
        expect(await syncCourierFulfilmentFromShipment(db, "shp_courier", "in_transit")).toEqual({ recorded: false, voided: false });
        expect(fulfilled(item)).toBe(3);
        expect(one("SELECT shipment_id, actor_type FROM order_fulfillments WHERE id = ?", booked.fulfillmentId!))
            .toEqual({ shipment_id: "shp_courier", actor_type: "system" });

        // The courier cancelled before pickup and the order went back to confirmed.
        sqlite.exec(`UPDATE orders SET status = 'confirmed' WHERE id = '${id}'`);
        expect(await syncCourierFulfilmentFromShipment(db, "shp_courier", "cancelled")).toEqual({ recorded: false, voided: true });
        expect(fulfilled(item)).toBe(1);
        expect((await getOrderDetails(db, id))?.fulfillments.find((entry) => entry.id === booked.fulfillmentId))
            .toMatchObject({ canVoid: false, voidBlockedReason: "voided" });
    });

    it("F10: automatic lines are handed over once, and only after settlement", async () => {
        sqlite.exec(`
            INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('p_dig', 'E-book', 'ebook', 50000, 1);
            INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory, fulfillment_kind)
            VALUES ('v_dig', 'p_dig', 'EBOOK', 50000, 0, 1, 0, 'digital');
            INSERT INTO orders (id, customer_name, customer_phone, requires_shipping, currency_code, currency_decimal_places,
              subtotal_amount_minor, total_amount_minor, status, payment_method, payment_status, paid_amount_minor, balance_due_minor,
              fulfillment_status, inventory_pool, inventory_action, version)
            VALUES ('o_dig', 'Buyer', '+8801700000000', 0, 'BDT', 2, 50000, 50000, 'pending', 'stripe', 'unpaid', 0, 50000,
              'pending', 'regular', 'none', 1);
            INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, product_name, inventory_tracked,
              unit_price_minor, line_subtotal_minor, discount_amount_minor, taxable_amount_minor, tax_amount_minor, fulfillment_type)
            VALUES ('i_dig', 'o_dig', 'p_dig', 'v_dig', 1, 'E-book', 0, 50000, 50000, 0, 0, 0, 'digital');
        `);
        // Wave A registers no automatic fulfiller: the line waits, fail closed.
        expect(await autoFulfilOrder(db, "o_dig")).toMatchObject({ skipped: "unsettled" });
        sqlite.exec(`UPDATE orders SET payment_status = 'paid', paid_amount_minor = 50000, balance_due_minor = 0 WHERE id = 'o_dig'`);
        expect(await listOrdersAwaitingAutoFulfil(db)).toEqual(["o_dig"]);
        expect(await autoFulfilOrder(db, "o_dig")).toMatchObject({ fulfilledTypes: [], unavailableTypes: ["digital"] });

        let deliveries = 0;
        const registry: FulfillerRegistry = {
            ...FULFILLER_REGISTRY,
            digital: { mode: "auto", fulfiller: { prepare: async () => { deliveries += 1; return []; } } },
        };
        const first = await autoFulfilOrder(db, "o_dig", registry);
        expect(first).toMatchObject({ fulfilledTypes: ["digital"], delivered: true });
        expect(await autoFulfilOrder(db, "o_dig", registry)).toMatchObject({ skipped: "no_auto_lines", fulfilledTypes: [] });
        expect(one("SELECT count(*) AS n FROM order_fulfillments WHERE order_id = 'o_dig'")).toEqual({ n: 1 });
        expect(deliveries).toBe(1);
        expect(one("SELECT status, fulfillment_status FROM orders WHERE id = 'o_dig'")).toEqual({ status: "delivered", fulfillment_status: "complete" });
        expect(await listOrdersAwaitingAutoFulfil(db)).toEqual([]);
    });

    it("keeps the ledger of every action in one batch per action (D1 budget)", async () => {
        const id = await order({ items: Array.from({ length: 1 }, () => ({ productId: "p_ship", variantId: "v_ship", quantity: 3 })) });
        const statements: number[] = [];
        const batch = db.batch.bind(db);
        (db as { batch: typeof db.batch }).batch = (async (queries: Parameters<typeof db.batch>[0]) => {
            statements.push(queries.length);
            return batch(queries);
        }) as unknown as typeof db.batch;
        await recordOrderFulfilment(db, id, { requestKey: "b", kind: "ship", lines: [{ itemId: lineId(id), quantity: 1 }] }, admin);
        // CAS claim + guard + parcel + fulfilment + one line statement.
        expect(statements[0]).toBe(5);
        expect(all("SELECT id FROM order_fulfillment_lines")).toHaveLength(1);
    });
});
