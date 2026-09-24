import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { processRefund } from "../payments/refund-service";
import { createOrder } from "./orders.admin";
import {
    bulkConfirmOrders,
    bulkFulfillOrders,
    createFulfillmentShipment,
    processCodAction,
    updateOrderStatus,
} from "./orders.fulfillment";
import { addOrderComment, listOrderTimeline, recordOrderEvent } from "./order-timeline";

/**
 * Black-box round 2: a double click, a retry or a stale tab must never record
 * money, stock or history twice, and a parcel already with the courier must
 * never be cancelled back into stock.
 */
describe("order writes repeated by a double click", () => {
    let sqlite: DatabaseSync;
    let db: Database;

    beforeEach(() => {
        ({ sqlite, db } = createSqliteD1Database());
        sqlite.exec(`
            INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata, is_active)
            VALUES ('city_1', 'Dhaka', 'city', NULL, '{}', '{}', 1), ('zone_1', 'North', 'zone', 'city_1', '{}', '{}', 1);
            INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('product_1', 'Kurta', 'kurta', 80000, 1);
            INSERT INTO product_variants
              (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory)
            VALUES ('variant_1', 'product_1', 'KURTA-M', 80000, 25, 0, 0, 1, 1);
        `);
    });

    afterEach(() => sqlite.close());

    const one = <T = Record<string, unknown>>(query: string, ...params: Array<string | number>) =>
        sqlite.prepare(query).get(...params) as T;

    async function manualOrder(quantity = 2) {
        const { id } = await createOrder(db, {
            requestKey: crypto.randomUUID(),
            customerName: "Rahim Uddin",
            customerPhone: "+8801712345601",
            customerEmail: null,
            shippingAddress: "House 1, Road 2, Gulshan",
            city: "city_1",
            zone: "zone_1",
            area: null,
            notes: null,
            items: [{ productId: "product_1", variantId: "variant_1", quantity }],
            discountAmount: null,
            shippingCharge: 80,
        } as never, "admin_1");
        return id;
    }

    async function collectedOrder() {
        const id = await manualOrder();
        await createFulfillmentShipment(db, id, {});
        await processCodAction(db, id, { action: "collected", collectedBy: "Rider", collectedAmount: 1680 });
        return id;
    }

    it("records a cash refund once when the same request is sent twice (R2-ORD-01)", async () => {
        const id = await collectedOrder();
        const requestKey = crypto.randomUUID();
        const request = { orderId: id, amount: 500, reason: "Customer asked", manualSettlementConfirmed: true, requestKey };

        const first = await processRefund(db, request);
        const second = await processRefund(db, request);

        expect(first).toMatchObject({ success: true, amount: 500 });
        expect(second).toMatchObject({ success: true, amount: 500, replayed: true });
        expect(second.refundNotification).toBeUndefined();
        expect(one("SELECT count(*) AS n FROM order_payments WHERE order_id = ? AND payment_type = 'refund'", id))
            .toEqual({ n: 1 });
        expect(one("SELECT paid_amount_minor, payment_status FROM orders WHERE id = ?", id))
            .toEqual({ paid_amount_minor: 118000, payment_status: "partially_refunded" });

        // The same key can't be reused for a different amount.
        await expect(processRefund(db, { ...request, amount: 100 })).rejects.toThrow("already used");
        // A new request is a new refund.
        await processRefund(db, { ...request, amount: 100, requestKey: crypto.randomUUID() });
        expect(one("SELECT count(*) AS n FROM order_payments WHERE order_id = ? AND payment_type = 'refund'", id))
            .toEqual({ n: 2 });
    });

    it("refuses to cancel an order while part of it is with the courier, and keeps its stock (R2-ORD-02)", async () => {
        const id = await manualOrder(2);
        const stockBefore = one("SELECT stock, reserved_stock FROM product_variants WHERE id = 'variant_1'");
        const itemId = one<{ id: string }>("SELECT id FROM order_items WHERE order_id = ?", id).id;
        await createFulfillmentShipment(db, id, { items: [{ itemId, quantity: 1 }] });

        await expect(updateOrderStatus(db, id, "cancelled"))
            .rejects.toThrow("1 item is with the courier. Mark it returned or delivered first.");
        expect(one("SELECT status FROM orders WHERE id = ?", id)).toEqual({ status: "confirmed" });
        expect(one("SELECT stock, reserved_stock FROM product_variants WHERE id = 'variant_1'")).toEqual(stockBefore);
    });

    it("reports a repeated bulk Mark as sent as done, not failed (R2-ORD-03)", async () => {
        const first = await manualOrder();
        const second = await manualOrder();
        const requestKey = crypto.randomUUID();

        const run = await bulkFulfillOrders(db, [first, second], { courierName: "Rider Jamal", requestKey });
        const again = await bulkFulfillOrders(db, [first, second], { courierName: "Rider Jamal", requestKey });

        expect(run.map((result) => result.success)).toEqual([true, true]);
        expect(again.map((result) => result.success)).toEqual([true, true]);
        expect(one("SELECT count(*) AS n FROM delivery_shipments")).toEqual({ n: 2 });
        // Without the key, a second send is still refused.
        const plain = await bulkFulfillOrders(db, [first], {});
        expect(plain[0]).toMatchObject({ success: false, error: "This order was already sent." });
    });

    it("reports a repeated bulk Confirm as done", async () => {
        const id = await manualOrder();
        sqlite.exec(`UPDATE orders SET status = 'pending' WHERE id = '${id}'`);
        const requestKey = crypto.randomUUID();
        expect((await bulkConfirmOrders(db, [id], { requestKey }))[0]).toMatchObject({ success: true });
        expect((await bulkConfirmOrders(db, [id], { requestKey }))[0]).toMatchObject({ success: true });
        expect((await bulkConfirmOrders(db, [id]))[0]).toMatchObject({ success: false });
    });

    it("posts a comment and logs an event once per request (R2-ORD-04)", async () => {
        const id = await manualOrder();
        const requestKey = crypto.randomUUID();
        const first = await addOrderComment(db, id, "Customer confirmed by phone", null, requestKey);
        const second = await addOrderComment(db, id, "Customer confirmed by phone", null, requestKey);
        expect(second.id).toBe(first.id);

        const receiptKey = crypto.randomUUID();
        await recordOrderEvent(db, { orderId: id, kind: "return_received", requestKey: receiptKey, data: { received: 2 } });
        await recordOrderEvent(db, { orderId: id, kind: "return_received", requestKey: receiptKey, data: { received: 2 } });

        const kinds = (await listOrderTimeline(db, id)).map((event) => event.kind);
        expect(kinds.filter((kind) => kind === "comment")).toHaveLength(1);
        expect(kinds.filter((kind) => kind === "return_received")).toHaveLength(1);
    });
});
