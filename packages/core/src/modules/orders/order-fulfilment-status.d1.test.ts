import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { applyInventoryForStatusChange } from "../inventory/inventory-transitions";
import { archiveOrders, createOrder, getOrderDetails } from "./orders.admin";
import { createOrderReturn } from "./order-returns";
import { listOrderTimeline } from "./order-timeline";
import { getInvoiceDocument, issueInvoice } from "./invoice.service";
import { processRefund } from "../payments/refund-service";
import { saveBusinessSettings } from "../settings/business-settings.service";
import {
    createFulfillmentShipment,
    markOrderDelivered,
    markParcelReturned,
    processCodAction,
    updateOrderStatus,
} from "./orders.fulfillment";

/**
 * Black-box round 3: fulfilment states (shipped, delivered, returned) come
 * only from what actually left and came back, never from a bare status
 * change, and every in-between state has a way forward.
 */
describe("fulfilment status only follows real parcels", () => {
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
            VALUES ('variant_1', 'product_1', 'KURTA-M', 80000, 21, 0, 0, 1, 1);
            INSERT INTO user (id, name, email) VALUES ('admin_1', 'Nadia', 'nadia@example.test');
        `);
    });

    afterEach(() => sqlite.close());

    const one = <T = Record<string, unknown>>(query: string, ...params: Array<string | number>) =>
        sqlite.prepare(query).get(...params) as T;
    const stock = () => one("SELECT stock, reserved_stock FROM product_variants WHERE id = 'variant_1'");

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

    it("refuses Shipped, Delivered and Returned as bare status changes, and moves no stock (R3-ORD-01)", async () => {
        const id = await manualOrder();
        const before = stock();
        await expect(updateOrderStatus(db, id, "shipped")).rejects.toThrow("Use Mark as sent");
        await expect(updateOrderStatus(db, id, "delivered")).rejects.toThrow("Mark delivered");
        await expect(updateOrderStatus(db, id, "returned")).rejects.toThrow("Mark returned");
        expect(one("SELECT status FROM orders WHERE id = ?", id)).toEqual({ status: "confirmed" });
        expect(stock()).toEqual(before);
    });

    it("lets an order marked Shipped with nothing sent be cancelled, putting its stock back", async () => {
        const id = await manualOrder();
        // How the old status override left #1092: Shipped, stock deducted, no parcel.
        sqlite.exec(`UPDATE orders SET status = 'shipped' WHERE id = '${id}'`);
        await applyInventoryForStatusChange(db, id, "shipped");
        expect(stock()).toEqual({ stock: 19, reserved_stock: 0 });

        await updateOrderStatus(db, id, "cancelled");
        expect(one("SELECT status FROM orders WHERE id = ?", id)).toEqual({ status: "cancelled" });
        expect(stock()).toEqual({ stock: 21, reserved_stock: 0 });
    });

    it("marks a paid, fully sent order delivered through its own action", async () => {
        const id = await manualOrder();
        await createFulfillmentShipment(db, id, {});
        await expect(markOrderDelivered(db, id)).rejects.toThrow("Mark the cash as collected first.");
        sqlite.exec(`UPDATE orders SET payment_method = 'stripe', payment_status = 'paid', paid_amount_minor = total_amount_minor, balance_due_minor = 0 WHERE id = '${id}'`);
        sqlite.exec(`UPDATE orders SET payment_status = 'partial', paid_amount_minor = 50000, balance_due_minor = total_amount_minor - 50000 WHERE id = '${id}'`);
        await expect(markOrderDelivered(db, id)).rejects.toThrow("Record the rest of the payment first.");
        sqlite.exec(`UPDATE orders SET payment_status = 'paid', paid_amount_minor = total_amount_minor, balance_due_minor = 0 WHERE id = '${id}'`);
        await markOrderDelivered(db, id);
        expect(one("SELECT status FROM orders WHERE id = ?", id)).toEqual({ status: "delivered" });
        expect(one("SELECT status FROM delivery_shipments WHERE order_id = ?", id)).toEqual({ status: "delivered" });
    });

    it("gives a part-sent order a way forward: a failed attempt, then the parcel back, then cancel (R3-ORD-04)", async () => {
        const id = await manualOrder(2);
        const reserved = stock();
        const itemId = one<{ id: string }>("SELECT id FROM order_items WHERE order_id = ?", id).id;
        const { shipmentId } = await createFulfillmentShipment(db, id, { items: [{ itemId, quantity: 1 }], courierName: "Rider Kamal" });

        await processCodAction(db, id, { action: "failed", reason: "not_home" });
        expect(one("SELECT delivery_attempts FROM cod_tracking WHERE order_id = ?", id)).toEqual({ delivery_attempts: 1 });

        await markParcelReturned(db, id, shipmentId);
        expect(one("SELECT shipped_quantity FROM order_items WHERE id = ?", itemId)).toEqual({ shipped_quantity: 0 });
        expect(one("SELECT status, fulfillment_status FROM orders WHERE id = ?", id))
            .toEqual({ status: "confirmed", fulfillment_status: "pending" });
        expect(one("SELECT status FROM delivery_shipments WHERE id = ?", shipmentId)).toEqual({ status: "returned" });
        // The unit was only ever reserved, so taking it back moves no stock.
        expect(stock()).toEqual(reserved);

        await updateOrderStatus(db, id, "cancelled");
        expect(stock()).toEqual({ stock: 21, reserved_stock: 0 });
    });

    it("says cash was already collected instead of recording it twice from a stale tab (R3-ORD-10)", async () => {
        const id = await manualOrder();
        await createFulfillmentShipment(db, id, {});
        await processCodAction(db, id, { action: "collected", collectedBy: "Rider", collectedAmount: 1680 });
        await expect(processCodAction(db, id, { action: "collected", collectedBy: "Rider", collectedAmount: 1680 }))
            .rejects.toThrow("already recorded");
        expect(one("SELECT count(*) AS n FROM order_payments WHERE order_id = ?", id)).toEqual({ n: 1 });
    });

    it("words a failed own-rider delivery as a delivery, not a courier booking (R3-ORD-05)", async () => {
        const id = await manualOrder();
        await createFulfillmentShipment(db, id, { courierName: "Rider Jamal" });
        await processCodAction(db, id, { action: "failed", reason: "no_cash" });
        expect((await getOrderDetails(db, id))?.shipmentRecovery).toMatchObject({ state: "none" });
    });

    it("offers a return only once the order was delivered (R3-ORD-14)", async () => {
        const id = await manualOrder();
        await createFulfillmentShipment(db, id, {});
        const { version } = one<{ version: number }>("SELECT version FROM orders WHERE id = ?", id);
        const itemId = one<{ id: string }>("SELECT id FROM order_items WHERE order_id = ?", id).id;
        await expect(createOrderReturn(db, id, {
            commandKey: crypto.randomUUID(),
            expectedOrderVersion: version,
            reason: "Wrong size",
            lines: [{ orderItemId: itemId, quantity: 1 }],
        }, { type: "admin", id: null })).rejects.toThrow("hasn't been delivered yet");
    });

    it("names who created a manual order on its timeline (R3-ORD-17)", async () => {
        const id = await manualOrder();
        const timeline = await listOrderTimeline(db, id);
        expect(timeline.at(-1)).toMatchObject({ kind: "placed", actorName: "Nadia" });
    });

    it("prints refunds made after an invoice was issued under it (R3-ORD-07)", async () => {
        const id = await manualOrder();
        await createFulfillmentShipment(db, id, {});
        await processCodAction(db, id, { action: "collected", collectedBy: "Rider", collectedAmount: 1680 });
        await saveBusinessSettings(db, { companyName: "Dhaka Threads" });
        const { version } = one<{ version: number }>("SELECT version FROM orders WHERE id = ?", id);
        await issueInvoice(db, id, { operationKey: "invoice-operation-r3-0001", expectedOrderVersion: version }, "admin_1");
        await processRefund(db, { orderId: id, amount: 800, reason: "Returned items", manualSettlementConfirmed: true });

        const document = await getInvoiceDocument(db, id);
        expect(document).toMatchObject({ status: "issued", refundedSinceIssue: 800 });
        expect(document?.order.totalAmount).toBe(1680);
    });

    it("archives delivered, paid orders (R3-ORD-11)", async () => {
        const id = await manualOrder();
        await createFulfillmentShipment(db, id, {});
        await processCodAction(db, id, { action: "collected", collectedBy: "Rider", collectedAmount: 1680 });
        const { version } = one<{ version: number }>("SELECT version FROM orders WHERE id = ?", id);
        await archiveOrders(db, [{ id, expectedVersion: version }]);
        expect(one<{ archived_at: number | null }>("SELECT archived_at FROM orders WHERE id = ?", id).archived_at).not.toBeNull();
    });
});
