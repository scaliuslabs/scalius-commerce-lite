// Order notifications on the real outbox: each helper records one row by its
// dedupe key (ids and safe facts only) and hands it to the sender; a missing
// order records nothing, and a status with no customer message is skipped.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { NotificationSender } from "@scalius/core/modules/notifications";
import {
    getOrderNotificationTypeForStatus,
    sendOrderBalancePaidNotification,
    sendOrderCreatedNotification,
    sendOrderNotificationsForStatus,
    sendOrderRefundNotification,
    sendOrderStatusChangeNotification,
    sendOrderSupportRequestNotification,
} from "./order-notifications";

describe("order notifications", () => {
    let sqlite: DatabaseSync;
    let db: Database;
    let sent: string[];
    const send = vi.fn<NotificationSender>(async (ids) => { sent.push(...ids); });
    const rows = () => sqlite.prepare("SELECT id, dedupe_key, order_id, notification_type, payload, status FROM notification_outbox ORDER BY dedupe_key").all() as Array<Record<string, string>>;

    beforeEach(() => {
        ({ sqlite, db } = createSqliteD1Database());
        sent = [];
        send.mockClear();
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        for (const id of ["ord_1", "ord_2"]) {
            sqlite.prepare(`INSERT INTO orders (id, customer_name, customer_phone, customer_email, shipping_address, city, zone, status)
                VALUES (?, 'Rahim', '+8801711111111', 'rahim@example.test', 'House 1', 'city_1', 'zone_1', 'confirmed')`).run(id);
        }
    });
    afterEach(() => { sqlite.close(); vi.restoreAllMocks(); });

    it("maps only customer-facing statuses to a notification", () => {
        expect(getOrderNotificationTypeForStatus("Shipped")).toBe("order_shipped");
        expect(getOrderNotificationTypeForStatus("delivered")).toBe("order_delivered");
        expect(getOrderNotificationTypeForStatus("cancelled")).toBe("order_cancelled");
        expect(getOrderNotificationTypeForStatus("returned")).toBe("order_returned");
        expect(getOrderNotificationTypeForStatus("refunded")).toBe("order_refunded");
        expect(getOrderNotificationTypeForStatus("processing")).toBeNull();
    });

    it("records order_created once and hands its id to the sender, never a contact", async () => {
        const first = await sendOrderCreatedNotification({ db, send, orderId: "ord_1", source: "test" });
        expect(first).toMatchObject({ orderId: "ord_1", enqueued: true });
        expect(sent).toEqual([first.outboxId]);
        const again = await sendOrderCreatedNotification({ db, send, orderId: "ord_1", source: "test" });
        expect(again.outboxId).toBe(first.outboxId);
        expect(rows()).toHaveLength(1);
        expect(rows()[0]).toMatchObject({ dedupe_key: "order_created:ord_1", notification_type: "order_created" });
        expect(rows()[0]!.payload).not.toMatch(/rahim|@|\+880/i);
    });

    it("skips a missing order without recording, and records without a sender for the drain", async () => {
        await expect(sendOrderCreatedNotification({ db, send, orderId: "ord_missing", source: "test" }))
            .resolves.toEqual({ orderId: "ord_missing", enqueued: false, skippedReason: "order_missing" });
        await expect(sendOrderBalancePaidNotification({ db, send: undefined, orderId: "ord_1", source: "test", amount: 750, gateway: "stripe" }))
            .resolves.toMatchObject({ enqueued: false, skippedReason: "no_sender" });
        expect(rows()).toEqual([expect.objectContaining({ dedupe_key: "payment_balance_paid:ord_1", status: "pending" })]);
        expect(JSON.parse(String(rows()[0]!.payload))).toEqual({ notificationType: "payment_balance_paid", data: { amount: 750, gateway: "stripe" } });
        expect(sent).toEqual([]);
    });

    it("records refunds, support requests and status changes under their own dedupe keys", async () => {
        await sendOrderRefundNotification({ db, send, orderId: "ord_1", notificationType: "order_refunded", dedupeKey: "refund:r1", source: "test", data: { amount: 100 } });
        await sendOrderSupportRequestNotification({ db, send, orderId: "ord_1", requestId: "sr_1", notificationType: "support_request_submitted", source: "test" });
        await sendOrderSupportRequestNotification({ db, send, orderId: "ord_1", requestId: "sr_1", notificationType: "support_request_status_updated", status: "resolved", source: "test" });
        await sendOrderStatusChangeNotification({ db, send, statusChange: { orderId: "ord_1", previousStatus: "confirmed", newStatus: "shipped", version: 3 }, trackingId: "PX-1", source: "test" });
        expect(await sendOrderStatusChangeNotification({ db, send, statusChange: null, source: "test" })).toBeNull();

        expect(rows().map((row) => row.dedupe_key)).toEqual([
            "order_status:ord_1:v3:confirmed->shipped",
            "refund:r1",
            "support_request:sr_1:status:resolved",
            "support_request:sr_1:submitted",
        ]);
        expect(JSON.parse(String(rows()[0]!.payload))).toEqual({ notificationType: "order_shipped", data: { trackingId: "PX-1" } });
        expect(sent).toHaveLength(4);
    });

    it("records one row per existing order for a bulk status change and skips the rest", async () => {
        const results = await sendOrderNotificationsForStatus({ db, send, orderIds: ["ord_1", "ord_2", "ord_gone", "ord_1"], newStatus: "delivered", source: "bulk" });
        expect(results.map((result) => [result.orderId, result.enqueued, result.skippedReason])).toEqual([
            ["ord_1", true, undefined],
            ["ord_2", true, undefined],
            ["ord_gone", false, "order_missing"],
        ]);
        await expect(sendOrderNotificationsForStatus({ db, send, orderIds: ["ord_1"], newStatus: "processing", source: "bulk" }))
            .resolves.toEqual([{ orderId: "ord_1", enqueued: false, skippedReason: "no_notification_type" }]);
        expect(rows()).toHaveLength(2);
    });
});
