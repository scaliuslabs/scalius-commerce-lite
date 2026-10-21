import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { parseEventFacts } from "@scalius/shared/events";
import { createOrder } from "../orders/admin/create";
import { processRefund } from "./refund-service";

/**
 * Refund lines (0172): a refund command records the order lines it is for in
 * its claim batch, `refund.created`/`refund.updated` carry them, and each
 * line stays within its quantity across refunds that did not fail.
 */
describe("refunds with order lines", () => {
    let sqlite: DatabaseSync;
    let db: Database;

    beforeEach(() => {
        ({ sqlite, db } = createSqliteD1Database());
        sqlite.exec(`
            INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active)
            VALUES ('city_1', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1), ('zone_1', 'North', 'BD', 2, 'city_1', '{}', '{}', 1);
            INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('product_1', 'Kurta', 'kurta', 80000, 1), ('product_2', 'Scarf', 'scarf', 20000, 1);
            INSERT INTO product_variants
              (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory)
            VALUES ('variant_1', 'product_1', 'KURTA-M', 80000, 25, 0, 0, 1, 1), ('variant_2', 'product_2', 'SCARF', 20000, 25, 0, 0, 1, 1);
            INSERT INTO event_demand (filter) VALUES ('refund.*');
        `);
    });

    afterEach(() => sqlite.close());

    const all = <T = Record<string, unknown>>(query: string, ...params: Array<string | number>) =>
        sqlite.prepare(query).all(...params) as T[];

    /** 2 × ৳800 + 1 × ৳200 + ৳80 delivery, collected in cash. */
    async function paidOrder(): Promise<{ orderId: string; kurta: string; scarf: string }> {
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
            items: [
                { productId: "product_1", variantId: "variant_1", quantity: 2 },
                { productId: "product_2", variantId: "variant_2", quantity: 1 },
            ],
            discountAmount: null,
            shippingCharge: 80,
        } as never, "admin_1");
        sqlite.prepare(`
            INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status, cod_collected_by)
            VALUES (?, ?, 188000, 'BDT', 'cod', 'full', 'succeeded', 'Rider')
        `).run(`pay_cod_${id}`, id);
        sqlite.prepare("UPDATE orders SET paid_amount_minor = 188000, balance_due_minor = 0, payment_status = 'paid', status = 'delivered' WHERE id = ?").run(id);
        const items = all<{ id: string; variant_id: string }>("SELECT id, variant_id FROM order_items WHERE order_id = ?", id);
        return {
            orderId: id,
            kurta: items.find((item) => item.variant_id === "variant_1")!.id,
            scarf: items.find((item) => item.variant_id === "variant_2")!.id,
        };
    }

    const refundEvents = () => all<{ topic: string; resource_id: string; data: string }>(
        "SELECT topic, resource_id, data FROM event_outbox WHERE topic LIKE 'refund.%' ORDER BY rowid",
    ).map((row) => ({ topic: row.topic, resourceId: row.resource_id, facts: parseEventFacts(row.topic as "refund.created", row.data) }));

    it("records the lines with the refund, settles it from its attempts and carries the lines on both events", async () => {
        const { orderId, kurta, scarf } = await paidOrder();
        const result = await processRefund(db, {
            orderId,
            amountMinor: 80000,
            reason: "One kurta came back",
            manualSettlementConfirmed: true,
            requestKey: "refund-lines-0001",
            lines: [{ orderItemId: kurta, quantity: 1 }],
        });
        expect(result.success).toBe(true);
        expect(result.orderRefundId).toBeTruthy();
        expect(all("SELECT status, amount_minor, currency, settlement FROM order_refunds WHERE id = ?", result.orderRefundId!))
            .toEqual([{ status: "refunded", amount_minor: 80000, currency: "BDT", settlement: "original" }]);
        const lines = [{ orderItemId: kurta, variantId: "variant_1", quantity: 1 }];
        expect(refundEvents()).toEqual([
            { topic: "refund.created", resourceId: result.orderRefundId, facts: { refundId: result.orderRefundId, orderId, status: "pending", lines } },
            { topic: "refund.updated", resourceId: result.orderRefundId, facts: { refundId: result.orderRefundId, orderId, previousStatus: "pending", status: "refunded", lines } },
        ]);

        // The same key with other lines is a different refund; with the same, the first one.
        await expect(processRefund(db, {
            orderId, amountMinor: 80000, reason: "One kurta came back", manualSettlementConfirmed: true,
            requestKey: "refund-lines-0001", lines: [{ orderItemId: scarf, quantity: 1 }],
        })).rejects.toThrow(/different order lines/);
        const replay = await processRefund(db, {
            orderId, amountMinor: 80000, reason: "One kurta came back", manualSettlementConfirmed: true,
            requestKey: "refund-lines-0001", lines: [{ orderItemId: kurta, quantity: 1 }],
        });
        expect(replay).toMatchObject({ replayed: true, orderRefundId: result.orderRefundId });

        // One kurta is left to refund; the other line and an unknown one are refused before anything is written.
        await expect(processRefund(db, {
            orderId, amountMinor: 80000, reason: "Again", manualSettlementConfirmed: true,
            requestKey: "refund-lines-0002", lines: [{ orderItemId: kurta, quantity: 2 }],
        })).rejects.toThrow(/has 1 of 2 left to refund/);
        await expect(processRefund(db, {
            orderId, amountMinor: 1000, reason: "Again", manualSettlementConfirmed: true,
            requestKey: "refund-lines-0003", lines: [{ orderItemId: "item_elsewhere", quantity: 1 }],
        })).rejects.toThrow(/not a line of this order/);
        await expect(processRefund(db, {
            orderId, amountMinor: 1000, reason: "Again", manualSettlementConfirmed: true,
            requestKey: "refund-lines-0004", lines: [{ orderItemId: kurta, quantity: 1 }, { orderItemId: kurta, quantity: 1 }],
        })).rejects.toThrow(/named twice/);
        expect(all("SELECT COUNT(*) AS refunds FROM order_refunds")).toEqual([{ refunds: 1 }]);

        const second = await processRefund(db, {
            orderId, amountMinor: 100000, reason: "Kurta and scarf", manualSettlementConfirmed: true,
            requestKey: "refund-lines-0005", lines: [{ orderItemId: scarf, quantity: 1 }, { orderItemId: kurta, quantity: 1 }],
        });
        expect(all("SELECT order_item_id, quantity FROM order_refund_lines WHERE refund_id = ? ORDER BY order_item_id", second.orderRefundId!))
            .toEqual([{ order_item_id: kurta, quantity: 1 }, { order_item_id: scarf, quantity: 1 }].sort((a, b) => a.order_item_id.localeCompare(b.order_item_id)));
    });

    it("keeps an amount-only refund a record with no lines", async () => {
        const { orderId } = await paidOrder();
        const result = await processRefund(db, {
            orderId, amountMinor: 8000, reason: "Delivery was late", manualSettlementConfirmed: true, requestKey: "refund-amount-0001",
        });
        expect(all("SELECT status FROM order_refunds WHERE id = ?", result.orderRefundId!)).toEqual([{ status: "refunded" }]);
        expect(refundEvents().map((event) => [event.topic, event.facts?.lines])).toEqual([["refund.created", []], ["refund.updated", []]]);
    });
});
