import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { applyInventoryForStatusChange } from "../../inventory/inventory-transitions";
import { processRefund } from "../../payments/refund-service";
import { archiveOrders } from "../admin/archive";
import { buildOrderEditReadiness, getOrderEditReadiness } from "../admin/readiness";
import { confirmManualOrderAmendment, previewManualOrderAmendment } from "../admin/amend";
import { createOrder } from "../admin/create";
import { getOrderDetails } from "../admin/detail";
import { listOrders, loadOrderExportDetails } from "../admin/list";
import { updateOrderDetails } from "../admin/edit";
import { createFulfillmentShipment } from "../../fulfilment/shipments";
import { processCodAction } from "../../fulfilment/delivery-outcomes";
import { approveOrderReturn, createOrderReturn, getOrderReturn, receiveOrderReturn } from "../returns/returns";
import { addOrderComment, listOrderTimeline, recordOrderEvent } from "../timeline";
import { createOrdersCsvArtifactBuilder, formatCommerceDateTime } from "../csv-export";
import { readInvoiceOrderSource } from "../invoices/order-reader";
import { createReceiptOrderSupportRequest } from "../../conversations";

/**
 * Real-SQLite behaviour of the dashboard order lifecycle: sequential order
 * numbers, cash-on-delivery rules, returns and refunds, editing storefront
 * orders, tabs, the timeline and the export.
 */
describe("dashboard order lifecycle on D1 storage", () => {
    let sqlite: DatabaseSync;
    let db: Database;

    beforeEach(() => {
        ({ sqlite, db } = createSqliteD1Database());
        sqlite.exec(`
            INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata, is_active)
            VALUES
              ('city_1', 'Dhaka', 'city', NULL, '{}', '{}', 1),
              ('zone_1', 'North', 'zone', 'city_1', '{}', '{}', 1),
              ('zone_2', 'South', 'zone', 'city_1', '{}', '{}', 1);
            INSERT INTO products (id, name, slug, price_minor, is_active)
            VALUES ('product_1', 'Kurta', 'kurta', 80000, 1);
            INSERT INTO product_variants
              (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory)
            VALUES ('variant_1', 'product_1', 'KURTA-M', 80000, 10, 0, 0, 1, 1);
        `);
    });

    afterEach(() => sqlite.close());

    const one = <T = Record<string, unknown>>(query: string, ...params: Array<string | number>) =>
        sqlite.prepare(query).get(...params) as T;

    function manualOrder(overrides: Record<string, unknown> = {}) {
        return createOrder(db, {
            requestKey: crypto.randomUUID(),
            customerName: "Rahim Uddin",
            customerPhone: "+8801712345601",
            customerEmail: null,
            shippingAddress: "House 1, Road 2, Gulshan",
            city: "city_1",
            zone: "zone_1",
            area: null,
            notes: null,
            items: [{ productId: "product_1", variantId: "variant_1", quantity: 3 }],
            discountAmount: null,
            shippingCharge: 80,
            ...overrides,
        } as never, "admin_1");
    }

    /** A checkout-placed COD order: no dashboard create attempt, reserved stock. */
    function storefrontOrder(id = "store_1") {
        sqlite.exec(`
            INSERT INTO orders (
              id, order_number, customer_name, customer_phone, shipping_address, city, zone,
              city_name, zone_name, currency_code, currency_decimal_places,
              subtotal_amount_minor, shipping_amount_minor, discount_amount_minor, tax_amount_minor,
              total_amount_minor, status, payment_method, payment_status, paid_amount_minor,
              balance_due_minor, fulfillment_status, inventory_pool, inventory_action, version
            ) VALUES (
              '${id}', 5001, 'Karim', '+8801812345602', 'Village road, Savar', 'city_1', 'zone_1',
              'Dhaka', 'North', 'BDT', 2, 150000, 8000, 0, 0, 158000, 'pending', 'cod', 'unpaid', 0,
              158000, 'pending', 'regular', 'reserved', 1
            );
            INSERT INTO cod_tracking (id, order_id, cod_status) VALUES ('cod_${id}', '${id}', 'pending');
            INSERT INTO order_items (
              id, order_id, product_id, variant_id, quantity, product_name, inventory_tracked,
              unit_price_minor, line_subtotal_minor, discount_amount_minor, taxable_amount_minor,
              tax_amount_minor, fulfillment_status
            ) VALUES ('${id}_item', '${id}', 'product_1', 'variant_1', 2, 'Kurta', 1, 75000, 150000, 0, 0, 0, 'pending');
            INSERT INTO order_tax_snapshots (
              order_id, currency_code, decimal_places, display_label, prices_include_tax,
              shipping_taxed, settings_version, calculation_version, destination_snapshot, rate_snapshot
            ) VALUES ('${id}', 'BDT', 2, 'Tax', 0, 0, 1, 'tax-v1', '{}', '{}');
            INSERT INTO order_item_tax_snapshots (order_item_id, order_id, prices_include_tax, rate_snapshot)
            VALUES ('${id}_item', '${id}', 0, '[]');
            UPDATE product_variants SET reserved_stock = reserved_stock + 2 WHERE id = 'variant_1';
        `);
    }

    async function confirm(orderId: string) {
        const { updateOrderStatus } = await import("./lifecycle");
        await updateOrderStatus(db, orderId, "confirmed");
    }

    it("numbers orders sequentially from 1001 and finds them by number", async () => {
        const first = await manualOrder();
        const second = await manualOrder();
        expect(one("SELECT order_number FROM orders WHERE id = ?", first.id)).toEqual({ order_number: 1001 });
        expect(one("SELECT order_number FROM orders WHERE id = ?", second.id)).toEqual({ order_number: 1002 });

        for (const search of ["#1002", "1002", "১০০২"]) {
            const result = await listOrders(db, { search });
            expect(result.orders[0]).toMatchObject({ id: second.id, orderNumber: 1002 });
        }
        expect((await getOrderDetails(db, first.id))?.orderNumber).toBe(1001);
    });

    it("refuses cash collection before the order is sent, then records it at the door", async () => {
        const { id } = await manualOrder();
        await expect(processCodAction(db, id, { action: "collected", collectedBy: "Rider", collectedAmount: 2480 }))
            .rejects.toThrow("Cash can be recorded once the order is sent");
        expect(one("SELECT status, payment_status FROM orders WHERE id = ?", id))
            .toEqual({ status: "confirmed", payment_status: "unpaid" });

        await createFulfillmentShipment(db, id, { courierName: "Own rider" });
        await expect(processCodAction(db, id, { action: "collected", collectedBy: "Rider", collectedAmount: 2000 }))
            .rejects.toThrow("Record the full cash balance of ৳2,480.");
        await processCodAction(db, id, { action: "collected", collectedBy: "Rider", collectedAmount: 2480 });
        expect(one("SELECT status, payment_status, balance_due_minor FROM orders WHERE id = ?", id))
            .toEqual({ status: "delivered", payment_status: "paid", balance_due_minor: 0 });
    });

    it("sends part of a line, then the rest, and replays a double click", async () => {
        const { id } = await manualOrder();
        const itemId = (one<{ id: string }>("SELECT id FROM order_items WHERE order_id = ?", id)).id;
        const requestKey = crypto.randomUUID();

        const first = await createFulfillmentShipment(db, id, { requestKey, items: [{ itemId, quantity: 2 }] });
        const again = await createFulfillmentShipment(db, id, { requestKey, items: [{ itemId, quantity: 2 }] });
        expect(again).toMatchObject({ shipmentId: first.shipmentId, replayed: true });
        expect(one("SELECT count(*) AS n FROM delivery_shipments WHERE order_id = ?", id)).toEqual({ n: 1 });
        expect(one("SELECT status, fulfillment_status FROM orders WHERE id = ?", id))
            .toEqual({ status: "confirmed", fulfillment_status: "partial" });
        // The ledger records what left; the projection is the only counter.
        expect(one("SELECT fulfilled_quantity FROM order_items WHERE id = ?", itemId))
            .toEqual({ fulfilled_quantity: 2 });
        expect(one("SELECT count(*) AS n FROM order_fulfillments WHERE order_id = ? AND kind = 'ship'", id))
            .toEqual({ n: 1 });

        await expect(createFulfillmentShipment(db, id, { items: [{ itemId, quantity: 2 }] }))
            .rejects.toThrow("Only 1 of that item is left.");
        await createFulfillmentShipment(db, id, {});
        expect(one("SELECT status, fulfillment_status FROM orders WHERE id = ?", id))
            .toEqual({ status: "shipped", fulfillment_status: "complete" });
        expect(one("SELECT fulfilled_quantity FROM order_items WHERE id = ?", itemId))
            .toEqual({ fulfilled_quantity: 3 });
    });

    it("closes a return to sender at once and restocks only what is received", async () => {
        const { id } = await manualOrder();
        await createFulfillmentShipment(db, id, {});
        const stockAfterShipping = one("SELECT stock, reserved_stock FROM product_variants");
        expect(stockAfterShipping).toEqual({ stock: 7, reserved_stock: 0 });

        await processCodAction(db, id, { action: "failed", reason: "no_cash", notes: "Will pay tomorrow" });
        expect(one("SELECT cod_status, failure_note FROM cod_tracking WHERE order_id = ?", id))
            .toEqual({ cod_status: "failed", failure_note: "Will pay tomorrow" });
        expect((await listOrders(db, { view: "delivery_failed" })).orders.map((order) => order.id)).toEqual([id]);

        const result = await processCodAction(db, id, { action: "returned" }) as { returnId: string };
        expect(one("SELECT status FROM orders WHERE id = ?", id)).toEqual({ status: "returned" });
        expect((await listOrders(db, { view: "returned" })).orders.map((order) => order.id)).toEqual([id]);
        expect((await listOrders(db, { view: "unpaid" })).orders).toEqual([]);
        expect((await listOrders(db, { view: "cod_to_collect" })).orders).toEqual([]);

        // A later courier "returned" sync must not restock on top of the receipt.
        await applyInventoryForStatusChange(db, id, "returned");
        expect(one("SELECT stock FROM product_variants")).toEqual({ stock: 7 });

        const returned = await getOrderReturn(db, id, result.returnId);
        expect(returned.status).toBe("approved");
        await receiveOrderReturn(db, id, returned.id, {
            commandKey: crypto.randomUUID(),
            expectedVersion: returned.version,
            lines: [{ lineId: returned.lines[0]!.id, receivedQuantity: 3, restockQuantity: 2, damagedQuantity: 1 }],
        }, { type: "admin", id: null });
        expect(one("SELECT stock FROM product_variants")).toEqual({ stock: 9 });
        // Never paid, so nothing is owed back.
        expect((await getOrderDetails(db, id))).toMatchObject({ status: "returned", refundDue: 0 });
    });

    it("keeps a partly refunded order delivered with nothing due, and owes back only what came back", async () => {
        const { id } = await manualOrder();
        await createFulfillmentShipment(db, id, {});
        await processCodAction(db, id, { action: "collected", collectedBy: "Rider", collectedAmount: 2480 });

        const created = await createOrderReturn(db, id, {
            commandKey: crypto.randomUUID(),
            expectedOrderVersion: (one<{ version: number }>("SELECT version FROM orders WHERE id = ?", id)).version,
            reason: "Wrong size",
            lines: [{ orderItemId: (one<{ id: string }>("SELECT id FROM order_items WHERE order_id = ?", id)).id, quantity: 2 }],
        }, { type: "admin", id: null });
        let ret = await getOrderReturn(db, id, created.returnId);
        await approveOrderReturn(db, id, ret.id, {
            commandKey: crypto.randomUUID(),
            expectedVersion: ret.version,
            lines: [{ lineId: ret.lines[0]!.id, approvedQuantity: 2, rejectedQuantity: 0 }],
        }, { type: "admin", id: null });
        ret = await getOrderReturn(db, id, ret.id);
        await receiveOrderReturn(db, id, ret.id, {
            commandKey: crypto.randomUUID(),
            expectedVersion: ret.version,
            lines: [{ lineId: ret.lines[0]!.id, receivedQuantity: 2, restockQuantity: 2, damagedQuantity: 0 }],
        }, { type: "admin", id: null });

        // 2 of 3 kurtas at ৳800 came back: ৳1,600 is owed, never the delivery charge.
        expect(await getOrderDetails(db, id)).toMatchObject({ refundDue: 1600, refundedAmount: 0 });
        expect((await listOrders(db, {})).orders[0]).toMatchObject({ refundDue: 1600 });

        await processRefund(db, { orderId: id, amount: 1600, reason: "Returned items", manualSettlementConfirmed: true });
        expect(one("SELECT status, payment_status, balance_due_minor, paid_amount_minor FROM orders WHERE id = ?", id))
            .toEqual({ status: "delivered", payment_status: "partially_refunded", balance_due_minor: 0, paid_amount_minor: 88000 });
        expect(await getOrderDetails(db, id)).toMatchObject({ refundDue: 0, refundedAmount: 1600 });

        // Nothing is owed on a partly refunded order, so it can be completed.
        const { updateOrderStatus } = await import("./lifecycle");
        await updateOrderStatus(db, id, "completed");
        expect(one("SELECT status FROM orders WHERE id = ?", id)).toEqual({ status: "completed" });
    });

    it("lets a storefront COD order be edited before shipment, at the price the buyer agreed", async () => {
        storefrontOrder();
        expect(await getOrderEditReadiness(db, "store_1")).toEqual({
            items: { allowed: true, reason: null },
            details: { allowed: true, reason: null },
        });
        sqlite.exec("UPDATE product_variants SET price_minor = 90000 WHERE id = 'variant_1'");
        const draft = {
            requestKey: crypto.randomUUID(),
            expectedVersion: 1,
            customerName: "Karim",
            customerPhone: "+8801812345602",
            customerEmail: null,
            shippingAddress: "Village road, Savar",
            city: "city_1",
            zone: "zone_1",
            area: null,
            notes: null,
            items: [{ orderItemId: "store_1_item", productId: "product_1", variantId: "variant_1", quantity: 3 }],
            discountAmount: null,
            shippingCharge: 80,
        };
        const preview = await previewManualOrderAmendment(db, "store_1", draft);
        expect(preview.totalAmount).toBe(2330);
        await confirmManualOrderAmendment(db, "store_1", { ...draft, quoteFingerprint: preview.quoteFingerprint }, "admin_1");
        expect(one("SELECT quantity, unit_price_minor FROM order_items WHERE id = 'store_1_item'"))
            .toEqual({ quantity: 3, unit_price_minor: 75000 });
        expect(one("SELECT reserved_stock FROM product_variants")).toEqual({ reserved_stock: 3 });
        const timeline = await listOrderTimeline(db, "store_1");
        expect(timeline[0]).toMatchObject({ kind: "items_edited", data: { previousTotal: 1580, total: 2330 } });
    });

    it("locks items but not the address when a discount was used, and everything once sent", async () => {
        storefrontOrder();
        const base = {
            status: "pending", paymentMethod: "cod", paymentStatus: "unpaid", paidAmountMinor: 0,
            fulfillmentStatus: "pending", inventoryAction: "reserved", shipmentClaimId: null, archivedAt: null,
            hasTaxSnapshot: 1, hasPaymentHistory: 0, hasPaymentSessionHistory: 0, hasShipmentHistory: 0,
            hasRefundHistory: 0, hasReturnHistory: 0, hasInvoiceHistory: 0, hasPaymentPlan: 0,
            hasPromotionAllocation: 1, hasNonPendingItem: 0, hasCleanCodTracking: 1,
        };
        expect(buildOrderEditReadiness(base)).toEqual({
            items: { allowed: false, reason: "discount" },
            details: { allowed: true, reason: null },
        });
        expect(buildOrderEditReadiness({ ...base, hasPromotionAllocation: 0, paymentMethod: "stripe" }).items.reason)
            .toBe("online_payment");
        await updateOrderDetails(db, "store_1", {
            expectedVersion: 1,
            customerName: "Karim Mia",
            customerPhone: "+8801912345603",
            customerEmail: null,
            shippingAddress: "Bazar road, Savar",
            city: "city_1",
            zone: "zone_2",
            area: null,
        });
        expect(one("SELECT customer_name, customer_phone, zone_name, version FROM orders WHERE id = 'store_1'"))
            .toEqual({ customer_name: "Karim Mia", customer_phone: "+8801912345603", zone_name: "South", version: 2 });
        expect(one("SELECT phone FROM customers WHERE id = (SELECT customer_id FROM orders WHERE id = 'store_1')"))
            .toEqual({ phone: "+8801912345603" });

        await confirm("store_1");
        await createFulfillmentShipment(db, "store_1", {});
        expect(await getOrderEditReadiness(db, "store_1")).toEqual({
            items: { allowed: false, reason: "shipped" },
            details: { allowed: false, reason: "shipped" },
        });
        const version = (one<{ version: number }>("SELECT version FROM orders WHERE id = 'store_1'")).version;
        await expect(updateOrderDetails(db, "store_1", {
            expectedVersion: version,
            customerName: "Karim",
            customerPhone: "+8801912345603",
            customerEmail: null,
            shippingAddress: "Bazar road, Savar",
            city: "city_1",
            zone: "zone_2",
            area: null,
        })).rejects.toThrow("This order has been sent");
    });

    it("keeps cancelled and unfinished online orders out of Unpaid and Unfulfilled", async () => {
        const open = await manualOrder();
        const cancelled = await manualOrder();
        const { updateOrderStatus } = await import("./lifecycle");
        await updateOrderStatus(db, cancelled.id, "cancelled");
        sqlite.exec(`
            INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, total_amount_minor,
              status, payment_method, payment_status, balance_due_minor)
            VALUES ('online_1', 'Online', '+8801712345699', 'Road 9, Banani', 'city_1', 'zone_1', 5000,
              'incomplete', 'sslcommerz', 'unpaid', 5000);
        `);
        const ids = async (view: "unpaid" | "unfulfilled") =>
            (await listOrders(db, { view })).orders.map((order) => order.id);
        expect(await ids("unpaid")).toEqual([open.id]);
        expect(await ids("unfulfilled")).toEqual([open.id]);
    });

    it("opens archived orders and records the timeline with staff comments", async () => {
        const { id } = await manualOrder();
        const { updateOrderStatus } = await import("./lifecycle");
        await updateOrderStatus(db, id, "cancelled");
        const version = (one<{ version: number }>("SELECT version FROM orders WHERE id = ?", id)).version;
        await archiveOrders(db, [{ id, expectedVersion: version }]);
        await recordOrderEvent(db, { orderId: id, kind: "archived", actorId: "not-a-staff-user" });
        const detail = await getOrderDetails(db, id);
        expect(detail?.archivedAt).toBeInstanceOf(Date);

        await addOrderComment(db, id, "Customer confirmed by phone at 3pm", null);
        const timeline = await listOrderTimeline(db, id);
        expect(timeline.map((event) => event.kind)).toEqual(["comment", "archived", "placed"]);
        expect(timeline[0]).toMatchObject({ body: "Customer confirmed by phone at 3pm", actorName: null });
        await expect(addOrderComment(db, id, "   ", null)).rejects.toThrow("Write a comment first.");
    });

    it("finds Bangla-digit phones and whole emails only, newest first among equals (R2-ORD-14)", async () => {
        const rahim = await manualOrder({ customerEmail: "r2ord.rahim@example.com" });
        const rahima = await manualOrder({ customerEmail: "r2ord.rahima@example.com", customerPhone: "+8801712345699" });
        sqlite.exec(`UPDATE orders SET created_at = 1700000000 WHERE id = '${rahim.id}'`);

        const byBanglaPhone = await listOrders(db, { search: "০১৭১২৩৪৫৬০১" });
        expect(byBanglaPhone.orders.map((order) => order.id)).toEqual([rahim.id]);
        const byEmail = await listOrders(db, { search: "r2ord.rahim@example.com" });
        expect(byEmail.orders.map((order) => order.id)).toEqual([rahim.id]);
        const byDomain = await listOrders(db, { search: "Rahim Uddin", sort: "relevance" });
        expect(byDomain.orders.map((order) => order.id)).toEqual([rahima.id, rahim.id]);
    });

    it("keeps every own-courier parcel in step with a failed delivery and a return (R2-ORD-05)", async () => {
        const { id } = await manualOrder();
        const itemId = one<{ id: string }>("SELECT id FROM order_items WHERE order_id = ?", id).id;
        await createFulfillmentShipment(db, id, { items: [{ itemId, quantity: 1 }], courierName: "Rider Jamal", trackingId: "TRK-1" });
        await createFulfillmentShipment(db, id, { trackingId: "TRK-2" });
        await processCodAction(db, id, { action: "failed", reason: "no_cash" });
        expect(sqlite.prepare("SELECT status FROM delivery_shipments WHERE order_id = ? ORDER BY created_at").all(id))
            .toEqual([{ status: "delivery_failed" }, { status: "delivery_failed" }]);

        // Both parcels are listed; parcels created in the same second have no defined order.
        const details = (await loadOrderExportDetails(db, [id])).get(id)!;
        const parts = (value: string | null | undefined) => (value ?? "").split("; ").sort();
        expect(parts(details.courierName)).toEqual(["Own courier", "Rider Jamal"]);
        expect(parts(details.trackingId)).toEqual(["TRK-1", "TRK-2"]);

        const { returnId } = await processCodAction(db, id, { action: "returned" }) as { returnId: string };
        expect(sqlite.prepare("SELECT status FROM delivery_shipments WHERE order_id = ?").all(id))
            .toEqual([{ status: "returned" }, { status: "returned" }]);

        // Receiving the courier's return is warehouse work: the buyer was told once already (R2-ORD-08).
        const returned = await getOrderReturn(db, id, returnId);
        const receipt = await receiveOrderReturn(db, id, returned.id, {
            commandKey: crypto.randomUUID(),
            expectedVersion: returned.version,
            lines: [{ lineId: returned.lines[0]!.id, receivedQuantity: 3, restockQuantity: 3, damagedQuantity: 0 }],
        }, { type: "admin", id: null });
        expect(receipt.wholeOrderReturned).toBe(false);

        const invoice = await readInvoiceOrderSource(db, id);
        expect(invoice?.items[0]).toMatchObject({ quantity: 3, returnedQuantity: 3 });
    });

    it("keeps the delivery method's name on a manual order (R2-ORD-10)", async () => {
        sqlite.exec(`INSERT INTO shipping_methods (id, name, fee_minor, description) VALUES ('method_1', 'OPS006 Standard Delivery', 8000, 'Inside Dhaka')`);
        const { id } = await manualOrder({ shippingMethodId: "method_1", shippingCharge: 80 });
        expect(one("SELECT shipping_method_name, shipping_amount_minor FROM orders WHERE id = ?", id))
            .toEqual({ shipping_method_name: "OPS006 Standard Delivery", shipping_amount_minor: 8000 });
        await expect(manualOrder({ shippingMethodId: "gone" }))
            .rejects.toThrow("That delivery method no longer exists. Choose another.");
    });

    it("logs the buyer's cancellation request on the timeline (R2-ORD-15)", async () => {
        storefrontOrder();
        await createReceiptOrderSupportRequest(db, "store_1", { type: "cancel_pre_shipment", reason: "Ordered by mistake" });
        const [latest] = await listOrderTimeline(db, "store_1");
        expect(latest).toMatchObject({
            kind: "request_submitted",
            body: "Ordered by mistake",
            data: { type: "cancel_pre_shipment", reason: "Ordered by mistake" },
        });
    });

    it("exports store-time dates, readable statuses, local phones and items", async () => {
        const { id } = await manualOrder();
        sqlite.exec(`UPDATE orders SET created_at = 1790292481 WHERE id = '${id}'`); // 2026-09-24 23:28 UTC
        const [row] = (await listOrders(db, { ids: [id] })).orders;
        const details = await loadOrderExportDetails(db, [id]);
        const builder = createOrdersCsvArtifactBuilder("summary");
        builder.append({
            ...row!,
            subtotalAmount: 2400,
            codStatus: row!.cod?.status ?? null,
            courierName: null,
            trackingId: null,
            shippingAddress: details.get(id)!.shippingAddress,
            notes: null,
            lines: details.get(id)!.lines,
        });
        const csv = builder.finish().chunks.join("");
        expect(formatCommerceDateTime(1790292481)).toBe("2026-09-25 05:28");
        expect(csv).toContain('"#1001","2026-09-25 05:28","Rahim Uddin","01712345601"');
        expect(csv).toContain('"Confirmed","Unpaid","Cash on delivery","Unfulfilled"');
        expect(csv).toContain('"3 × Kurta"');
        expect(csv).toContain('"House 1, Road 2, Gulshan"');
        expect(csv).not.toContain("'+880");
    });
});
