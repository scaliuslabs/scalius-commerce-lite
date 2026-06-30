import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    recordAndEnqueueOrderNotification: vi.fn(),
    buildOrderBalancePaidNotificationDedupeKey: vi.fn((orderId: string) => `payment_balance_paid:${orderId}`),
    buildOrderCreatedNotificationDedupeKey: vi.fn((orderId: string) => `order_created:${orderId}`),
    buildOrderStatusNotificationDedupeKey: vi.fn((options: {
        orderId: string;
        previousStatus?: string | null;
        newStatus: string;
        version?: number | null;
    }) => `order_status:${options.orderId}:v${options.version ?? "none"}:${options.previousStatus ?? "unknown"}->${options.newStatus}`),
    buildSupportRequestSubmittedNotificationDedupeKey: vi.fn((requestId: string) => `support_request:${requestId}:submitted`),
    buildSupportRequestStatusUpdatedNotificationDedupeKey: vi.fn((options: {
        requestId: string;
        status: string;
    }) => `support_request:${options.requestId}:status:${options.status}`),
}));

vi.mock("@scalius/core/modules/notifications", () => ({
    buildOrderBalancePaidNotificationDedupeKey: mocks.buildOrderBalancePaidNotificationDedupeKey,
    buildOrderCreatedNotificationDedupeKey: mocks.buildOrderCreatedNotificationDedupeKey,
    buildOrderStatusNotificationDedupeKey: mocks.buildOrderStatusNotificationDedupeKey,
    buildSupportRequestSubmittedNotificationDedupeKey: mocks.buildSupportRequestSubmittedNotificationDedupeKey,
    buildSupportRequestStatusUpdatedNotificationDedupeKey: mocks.buildSupportRequestStatusUpdatedNotificationDedupeKey,
    recordAndEnqueueOrderNotification: mocks.recordAndEnqueueOrderNotification,
}));

import {
    enqueueOrderBalancePaidNotificationForOrder,
    enqueueOrderCreatedNotificationForOrder,
    enqueueOrderNotificationsForStatus,
    enqueueOrderRefundNotificationForOrder,
    enqueueOrderSupportRequestNotificationForOrder,
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
        mocks.recordAndEnqueueOrderNotification.mockImplementation(async ({ queue, notification }) => {
            if (!queue) {
                return {
                    outboxId: `outbox_${notification.orderId}`,
                    dedupeKey: notification.dedupeKey,
                    created: true,
                    enqueued: false,
                    skippedReason: "no_queue",
                };
            }

            try {
                await queue.send({
                    type: "order.notification",
                    orderId: notification.orderId,
                    customerEmail: notification.customerEmail,
                    customerName: notification.customerName,
                    notificationType: notification.notificationType,
                    data: notification.data,
                });
                return {
                    outboxId: `outbox_${notification.orderId}`,
                    dedupeKey: notification.dedupeKey,
                    created: true,
                    enqueued: true,
                };
            } catch {
                return {
                    outboxId: `outbox_${notification.orderId}`,
                    dedupeKey: notification.dedupeKey,
                    created: true,
                    enqueued: false,
                    skippedReason: "queue_failed",
                };
            }
        });
    });

    it("maps order statuses to existing notification types", () => {
        expect(getOrderNotificationTypeForStatus("shipped")).toBe("order_shipped");
        expect(getOrderNotificationTypeForStatus("DELIVERED")).toBe("order_delivered");
        expect(getOrderNotificationTypeForStatus("returned")).toBe("order_returned");
        expect(getOrderNotificationTypeForStatus("refunded")).toBe("order_refunded");
        expect(getOrderNotificationTypeForStatus("partially_refunded")).toBe("order_partially_refunded");
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

        expect(result).toEqual({ orderId: "order_1", outboxId: "outbox_order_1", enqueued: true });
        expect(queue.send).toHaveBeenCalledWith({
            type: "order.notification",
            orderId: "order_1",
            customerEmail: "buyer@example.com",
            customerName: "Buyer",
            notificationType: "order_shipped",
            data: { trackingId: "TRK-1" },
        });
        expect(mocks.recordAndEnqueueOrderNotification).toHaveBeenCalledWith(expect.objectContaining({
            notification: expect.objectContaining({
                dedupeKey: "order_status:order_1:vnone:confirmed->shipped",
                source: "test",
            }),
        }));
    });

    it("records a durable outbox row when the queue binding is unavailable", async () => {
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
            { orderId: "order_1", outboxId: "outbox_order_1", enqueued: false, skippedReason: "no_queue" },
        ]);
        expect(select).toHaveBeenCalledTimes(1);
        expect(mocks.recordAndEnqueueOrderNotification).toHaveBeenCalledWith(expect.objectContaining({
            queue: undefined,
            notification: expect.objectContaining({
                orderId: "order_1",
                notificationType: "order_delivered",
            }),
        }));
    });

    it("enqueues order-created notifications from confirmed payment with the stable dedupe key", async () => {
        const { db } = createDbMock([
            { id: "order_1", customerEmail: "buyer@example.com", customerName: "Buyer" },
        ]);
        const queue = { send: vi.fn(async () => undefined) };

        const result = await enqueueOrderCreatedNotificationForOrder({
            db: db as never,
            queue,
            orderId: "order_1",
            source: "payment-stripe-confirmed",
            retryOnQueueFailure: true,
        });

        expect(result).toEqual({ orderId: "order_1", outboxId: "outbox_order_1", enqueued: true });
        expect(mocks.recordAndEnqueueOrderNotification).toHaveBeenCalledWith(expect.objectContaining({
            queue,
            notification: expect.objectContaining({
                dedupeKey: "order_created:order_1",
                orderId: "order_1",
                customerEmail: "buyer@example.com",
                customerName: "Buyer",
                notificationType: "order_created",
                source: "payment-stripe-confirmed",
            }),
        }));
    });

    it("enqueues refund notifications with an explicit refund dedupe key", async () => {
        const { db } = createDbMock([
            { id: "order_1", customerEmail: "buyer@example.com", customerName: "Buyer" },
        ]);
        const queue = { send: vi.fn(async () => undefined) };

        const result = await enqueueOrderRefundNotificationForOrder({
            db: db as never,
            queue,
            orderId: "order_1",
            notificationType: "order_refunded",
            dedupeKey: "refund:order_1:refund_order_1_4:full",
            source: "orders-refund",
            data: { amount: 120, gateway: "stripe", refundId: "re_1" },
        });

        expect(result).toEqual({ orderId: "order_1", outboxId: "outbox_order_1", enqueued: true });
        expect(queue.send).toHaveBeenCalledWith({
            type: "order.notification",
            orderId: "order_1",
            customerEmail: "buyer@example.com",
            customerName: "Buyer",
            notificationType: "order_refunded",
            data: { amount: 120, gateway: "stripe", refundId: "re_1" },
        });
        expect(mocks.recordAndEnqueueOrderNotification).toHaveBeenCalledWith(expect.objectContaining({
            notification: expect.objectContaining({
                dedupeKey: "refund:order_1:refund_order_1_4:full",
                notificationType: "order_refunded",
                source: "orders-refund",
            }),
        }));
    });

    it("enqueues partial refund notifications without full-refund wording", async () => {
        const { db } = createDbMock([
            { id: "order_1", customerEmail: "buyer@example.com", customerName: "Buyer" },
        ]);
        const queue = { send: vi.fn(async () => undefined) };

        const result = await enqueueOrderRefundNotificationForOrder({
            db: db as never,
            queue,
            orderId: "order_1",
            notificationType: "order_partially_refunded",
            dedupeKey: "refund:order_1:refund_order_1_4:partial",
            source: "orders-refund",
            data: { amount: 40, gateway: "stripe", refundId: "re_partial" },
        });

        expect(result).toEqual({ orderId: "order_1", outboxId: "outbox_order_1", enqueued: true });
        expect(queue.send).toHaveBeenCalledWith(expect.objectContaining({
            notificationType: "order_partially_refunded",
            data: { amount: 40, gateway: "stripe", refundId: "re_partial" },
        }));
        expect(mocks.recordAndEnqueueOrderNotification).toHaveBeenCalledWith(expect.objectContaining({
            notification: expect.objectContaining({
                dedupeKey: "refund:order_1:refund_order_1_4:partial",
                notificationType: "order_partially_refunded",
                source: "orders-refund",
            }),
        }));
    });

    it("enqueues refund processing and failed notifications with refund-group dedupe", async () => {
        const { db } = createDbMock([
            { id: "order_1", customerEmail: "buyer@example.com", customerName: "Buyer" },
            { id: "order_1", customerEmail: "buyer@example.com", customerName: "Buyer" },
        ]);
        const queue = { send: vi.fn(async () => undefined) };

        await enqueueOrderRefundNotificationForOrder({
            db: db as never,
            queue,
            orderId: "order_1",
            notificationType: "refund_processing",
            dedupeKey: "refund:order_1:refund_order_1_4:processing",
            source: "refund-reconciliation",
            data: { amount: 40, refundId: "re_pending" },
        });
        await enqueueOrderRefundNotificationForOrder({
            db: db as never,
            queue,
            orderId: "order_1",
            notificationType: "refund_failed",
            dedupeKey: "refund:order_1:refund_order_1_4:failed",
            source: "refund-reconciliation",
            data: { amount: 40, refundId: "re_failed" },
        });

        expect(queue.send).toHaveBeenNthCalledWith(1, expect.objectContaining({
            notificationType: "refund_processing",
            data: { amount: 40, refundId: "re_pending" },
        }));
        expect(queue.send).toHaveBeenNthCalledWith(2, expect.objectContaining({
            notificationType: "refund_failed",
            data: { amount: 40, refundId: "re_failed" },
        }));
        expect(mocks.recordAndEnqueueOrderNotification).toHaveBeenNthCalledWith(1, expect.objectContaining({
            notification: expect.objectContaining({
                dedupeKey: "refund:order_1:refund_order_1_4:processing",
                notificationType: "refund_processing",
                source: "refund-reconciliation",
            }),
        }));
        expect(mocks.recordAndEnqueueOrderNotification).toHaveBeenNthCalledWith(2, expect.objectContaining({
            notification: expect.objectContaining({
                dedupeKey: "refund:order_1:refund_order_1_4:failed",
                notificationType: "refund_failed",
                source: "refund-reconciliation",
            }),
        }));
    });

    it("enqueues balance-paid notifications with order-level dedupe", async () => {
        const { db } = createDbMock([
            { id: "order_1", customerEmail: "buyer@example.com", customerName: "Buyer" },
        ]);
        const queue = { send: vi.fn(async () => undefined) };

        const result = await enqueueOrderBalancePaidNotificationForOrder({
            db: db as never,
            queue,
            orderId: "order_1",
            source: "payment-sslcommerz-balance-paid",
            amount: 75,
            gateway: "sslcommerz",
        });

        expect(result).toEqual({ orderId: "order_1", outboxId: "outbox_order_1", enqueued: true });
        expect(queue.send).toHaveBeenCalledWith({
            type: "order.notification",
            orderId: "order_1",
            customerEmail: "buyer@example.com",
            customerName: "Buyer",
            notificationType: "payment_balance_paid",
            data: { amount: 75, gateway: "sslcommerz" },
        });
        expect(mocks.recordAndEnqueueOrderNotification).toHaveBeenCalledWith(expect.objectContaining({
            notification: expect.objectContaining({
                dedupeKey: "payment_balance_paid:order_1",
                notificationType: "payment_balance_paid",
                source: "payment-sslcommerz-balance-paid",
            }),
        }));
    });

    it("enqueues support request submissions with request-level dedupe and safe metadata", async () => {
        const { db } = createDbMock([
            { id: "order_1", customerEmail: "buyer@example.com", customerName: "Buyer" },
        ]);
        const queue = { send: vi.fn(async () => undefined) };

        const result = await enqueueOrderSupportRequestNotificationForOrder({
            db: db as never,
            queue,
            orderId: "order_1",
            requestId: "osr_1",
            notificationType: "support_request_submitted",
            source: "customer-support-request",
            status: "submitted",
            data: {
                supportRequestType: "refund",
                supportRequestTypeLabel: "Refund request",
                supportRequestStatus: "submitted",
                supportRequestStatusLabel: "Submitted",
            },
        });

        expect(result).toEqual({ orderId: "order_1", outboxId: "outbox_order_1", enqueued: true });
        expect(queue.send).toHaveBeenCalledWith({
            type: "order.notification",
            orderId: "order_1",
            customerEmail: "buyer@example.com",
            customerName: "Buyer",
            notificationType: "support_request_submitted",
            data: {
                supportRequestId: "osr_1",
                supportRequestType: "refund",
                supportRequestTypeLabel: "Refund request",
                supportRequestStatus: "submitted",
                supportRequestStatusLabel: "Submitted",
            },
        });
        expect(mocks.recordAndEnqueueOrderNotification).toHaveBeenCalledWith(expect.objectContaining({
            notification: expect.objectContaining({
                dedupeKey: "support_request:osr_1:submitted",
                notificationType: "support_request_submitted",
                source: "customer-support-request",
            }),
        }));
    });

    it("enqueues support request status updates without customer reason or admin note payloads", async () => {
        const { db } = createDbMock([
            { id: "order_1", customerEmail: "buyer@example.com", customerName: "Buyer" },
        ]);
        const queue = { send: vi.fn(async () => undefined) };

        await enqueueOrderSupportRequestNotificationForOrder({
            db: db as never,
            queue,
            orderId: "order_1",
            requestId: "osr_1",
            notificationType: "support_request_status_updated",
            source: "admin-support-request-status",
            status: "approved",
            data: {
                supportRequestType: "return",
                supportRequestTypeLabel: "Return request",
                supportRequestStatus: "approved",
                supportRequestStatusLabel: "Approved",
                previousSupportRequestStatus: "under_review",
            },
        });

        expect(queue.send).toHaveBeenCalledWith(expect.objectContaining({
            notificationType: "support_request_status_updated",
            data: {
                supportRequestId: "osr_1",
                supportRequestType: "return",
                supportRequestTypeLabel: "Return request",
                supportRequestStatus: "approved",
                supportRequestStatusLabel: "Approved",
                previousSupportRequestStatus: "under_review",
            },
        }));
        const sendMock = queue.send as unknown as { mock: { calls: Array<[{ data: Record<string, unknown> }]> } };
        const sentMessage = sendMock.mock.calls[0]![0];
        expect(sentMessage.data).not.toHaveProperty("reason");
        expect(sentMessage.data).not.toHaveProperty("message");
        expect(sentMessage.data).not.toHaveProperty("note");
        expect(mocks.recordAndEnqueueOrderNotification).toHaveBeenCalledWith(expect.objectContaining({
            notification: expect.objectContaining({
                dedupeKey: "support_request:osr_1:status:approved",
                notificationType: "support_request_status_updated",
                source: "admin-support-request-status",
            }),
        }));
    });

    it("throws on payment-confirmed notification queue failure when retry is requested", async () => {
        const { db } = createDbMock([
            { id: "order_1", customerEmail: null, customerName: null },
        ]);
        const queue = { send: vi.fn(async () => { throw new Error("queue unavailable"); }) };

        await expect(enqueueOrderCreatedNotificationForOrder({
            db: db as never,
            queue,
            orderId: "order_1",
            source: "payment-sslcommerz-confirmed",
            retryOnQueueFailure: true,
        })).rejects.toThrow("order_created notification queue send failed");

        expect(mocks.recordAndEnqueueOrderNotification).toHaveBeenCalledWith(expect.objectContaining({
            notification: expect.objectContaining({
                customerName: "Customer",
                notificationType: "order_created",
            }),
        }));
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
            { orderId: "order_1", outboxId: "outbox_order_1", enqueued: false, skippedReason: "queue_failed" },
        ]);
        expect(queue.send).toHaveBeenCalledWith(expect.objectContaining({
            customerName: "Customer",
            notificationType: "order_cancelled",
        }));
        expect(console.error).not.toHaveBeenCalled();
    });
});
