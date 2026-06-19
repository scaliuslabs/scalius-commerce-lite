import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    enqueueOrderNotificationsForStatus,
    enqueueOrderStatusChangeNotification,
    getOrderNotificationTypeForStatus,
} from "./order-notification-queue";

function createDbMock(rows: Array<{ id: string; customerEmail: string | null; customerName: string | null }>) {
    const get = vi.fn(async () => rows[0] ?? null);
    const all = vi.fn(async () => rows);
    const where = vi.fn(() => ({ get, all }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));

    return {
        db: { select },
        select,
        from,
        where,
        get,
        all,
    };
}

describe("order notification queue helpers", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    it("maps order statuses to existing notification types", () => {
        expect(getOrderNotificationTypeForStatus("shipped")).toBe("order_shipped");
        expect(getOrderNotificationTypeForStatus("DELIVERED")).toBe("order_delivered");
        expect(getOrderNotificationTypeForStatus("returned")).toBe("order_returned");
        expect(getOrderNotificationTypeForStatus("cancelled")).toBe("order_cancelled");
        expect(getOrderNotificationTypeForStatus("confirmed")).toBeNull();
    });

    it("enqueues a status-change notification with customer contact and tracking data", async () => {
        const { db } = createDbMock([
            { id: "order_1", customerEmail: "buyer@example.com", customerName: "Buyer" },
        ]);
        const queue = { send: vi.fn(async () => undefined) };

        const result = await enqueueOrderStatusChangeNotification({
            db: db as never,
            queue,
            statusChange: {
                orderId: "order_1",
                previousStatus: "confirmed",
                newStatus: "shipped",
            },
            trackingId: "TRK-1",
            source: "test",
        });

        expect(result).toEqual({ orderId: "order_1", enqueued: true });
        expect(queue.send).toHaveBeenCalledWith({
            type: "order.notification",
            orderId: "order_1",
            customerEmail: "buyer@example.com",
            customerName: "Buyer",
            notificationType: "order_shipped",
            data: { trackingId: "TRK-1" },
        });
    });

    it("does not query orders when the queue binding is unavailable", async () => {
        const { db, select } = createDbMock([
            { id: "order_1", customerEmail: "buyer@example.com", customerName: "Buyer" },
        ]);

        const results = await enqueueOrderNotificationsForStatus({
            db: db as never,
            queue: undefined,
            orderIds: ["order_1"],
            newStatus: "delivered",
            source: "test",
        });

        expect(results).toEqual([
            { orderId: "order_1", enqueued: false, skippedReason: "no_queue" },
        ]);
        expect(select).not.toHaveBeenCalled();
    });

    it("skips statuses that have no customer notification type", async () => {
        const { db, select } = createDbMock([
            { id: "order_1", customerEmail: "buyer@example.com", customerName: "Buyer" },
        ]);
        const queue = { send: vi.fn(async () => undefined) };

        const results = await enqueueOrderNotificationsForStatus({
            db: db as never,
            queue,
            orderIds: ["order_1"],
            newStatus: "confirmed",
            source: "test",
        });

        expect(results).toEqual([
            { orderId: "order_1", enqueued: false, skippedReason: "no_notification_type" },
        ]);
        expect(select).not.toHaveBeenCalled();
        expect(queue.send).not.toHaveBeenCalled();
    });

    it("keeps route/webhook commits non-failing when queue send fails", async () => {
        const { db } = createDbMock([
            { id: "order_1", customerEmail: null, customerName: null },
        ]);
        const queue = { send: vi.fn(async () => { throw new Error("queue unavailable"); }) };

        const results = await enqueueOrderNotificationsForStatus({
            db: db as never,
            queue,
            orderIds: ["order_1"],
            newStatus: "cancelled",
            source: "test",
        });

        expect(results).toEqual([
            { orderId: "order_1", enqueued: false, skippedReason: "queue_failed" },
        ]);
        expect(queue.send).toHaveBeenCalledWith(expect.objectContaining({
            customerName: "Customer",
            notificationType: "order_cancelled",
        }));
        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining("[test] Failed to enqueue order_cancelled notification for order_1"),
            expect.any(Error),
        );
    });
});
