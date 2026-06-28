import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    processReturn: vi.fn(),
    processRefund: vi.fn(),
    getUserPermissions: vi.fn(),
    getCredentialEncryptionKey: vi.fn(),
    invalidateProductAvailabilityCaches: vi.fn(),
    enqueueOrderRefundNotificationForOrder: vi.fn(),
    enqueueOrderStatusChangeNotification: vi.fn(),
}));

vi.mock("@scalius/core/modules/payments/refund-service", () => ({
    processReturn: mocks.processReturn,
    processRefund: mocks.processRefund,
}));

vi.mock("@scalius/core/auth/rbac/helpers", () => ({
    getUserPermissions: mocks.getUserPermissions,
}));

vi.mock("../../utils/encryption-key", () => ({
    getCredentialEncryptionKey: mocks.getCredentialEncryptionKey,
}));

vi.mock("../../utils/cache-invalidation", () => ({
    invalidateProductAvailabilityCaches: mocks.invalidateProductAvailabilityCaches,
}));

vi.mock("../../utils/order-notification-queue", () => ({
    enqueueOrderRefundNotificationForOrder: mocks.enqueueOrderRefundNotificationForOrder,
    enqueueOrderStatusChangeNotification: mocks.enqueueOrderStatusChangeNotification,
}));

import { adminOrdersRefundRoutes } from "./orders-refund";

const db = { id: "db" };
const queue = { send: vi.fn(async () => undefined) };

function createTestApp() {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    const env = {
        CACHE: { id: "api-cache" },
        ORDER_NOTIFICATIONS_QUEUE: queue,
        CREDENTIAL_ENCRYPTION_KEY: "credential-key",
    } as unknown as Env;

    app.use("*", async (c, next) => {
        c.set("db", db as never);
        c.set("user", { id: "admin_1" } as never);
        await next();
    });
    app.route("/orders", adminOrdersRefundRoutes);

    return { app, env };
}

describe("admin refund notification routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCredentialEncryptionKey.mockReturnValue("credential-key");
        mocks.getUserPermissions.mockResolvedValue(new Set(["orders.refund"]));
        mocks.invalidateProductAvailabilityCaches.mockResolvedValue(undefined);
        mocks.enqueueOrderRefundNotificationForOrder.mockResolvedValue({ orderId: "order_1", enqueued: true });
        mocks.enqueueOrderStatusChangeNotification.mockResolvedValue({ orderId: "order_1", enqueued: true });
    });

    it("enqueues a customer refund notification after a full direct refund", async () => {
        mocks.processRefund.mockResolvedValue({
            success: true,
            gateway: "stripe",
            refundId: "re_1",
            amount: 120,
            isFullRefund: true,
            refundNotification: {
                notificationType: "order_refunded",
                dedupeKey: "refund:order_1:refund_order_1_4:full",
                amount: 120,
                refundId: "re_1",
            },
        });
        const { app, env } = createTestApp();

        const response = await app.request("/api/v1/admin/orders/order_1/refund", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ amount: 120, reason: "requested_by_customer" }),
        }, env);

        expect(response.status).toBe(200);
        expect(mocks.invalidateProductAvailabilityCaches).toHaveBeenCalledWith(
            db,
            { orderIds: ["order_1"] },
            expect.anything(),
        );
        expect(mocks.enqueueOrderRefundNotificationForOrder).toHaveBeenCalledWith({
            db,
            queue,
            orderId: "order_1",
            notificationType: "order_refunded",
            dedupeKey: "refund:order_1:refund_order_1_4:full",
            source: "orders-refund",
            data: { amount: 120, gateway: "stripe", refundId: "re_1" },
        });
        const body = await response.json() as { data: Record<string, unknown> };
        expect(body.data).not.toHaveProperty("refundNotification");
    });

    it("enqueues partial-refund copy for partial refunds", async () => {
        mocks.processRefund.mockResolvedValue({
            success: true,
            gateway: "stripe",
            refundId: "re_partial",
            amount: 40,
            isFullRefund: false,
            refundNotification: {
                notificationType: "order_partially_refunded",
                dedupeKey: "refund:order_1:refund_order_1_4:partial",
                amount: 40,
                refundId: "re_partial",
            },
        });
        const { app, env } = createTestApp();

        const response = await app.request("/api/v1/admin/orders/order_1/refund", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ amount: 40, reason: "partial_adjustment" }),
        }, env);

        expect(response.status).toBe(200);
        expect(mocks.enqueueOrderRefundNotificationForOrder).toHaveBeenCalledWith({
            db,
            queue,
            orderId: "order_1",
            notificationType: "order_partially_refunded",
            dedupeKey: "refund:order_1:refund_order_1_4:partial",
            source: "orders-refund",
            data: { amount: 40, gateway: "stripe", refundId: "re_partial" },
        });
        const body = await response.json() as { data: Record<string, unknown> };
        expect(body.data).not.toHaveProperty("refundNotification");
    });

    it("does not notify for already-refunded inventory repair results without a refund notification fact", async () => {
        mocks.processRefund.mockResolvedValue({
            success: true,
            gateway: "stripe",
            amount: 0,
            isFullRefund: true,
        });
        const { app, env } = createTestApp();

        const response = await app.request("/api/v1/admin/orders/order_1/refund", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: "repair_inventory" }),
        }, env);

        expect(response.status).toBe(200);
        expect(mocks.enqueueOrderRefundNotificationForOrder).not.toHaveBeenCalled();
    });

    it("enqueues a returned notification after a newly returned order", async () => {
        mocks.processReturn.mockResolvedValue({
            statusChange: {
                orderId: "order_1",
                previousStatus: "delivered",
                newStatus: "returned",
                version: 7,
            },
        });
        const { app, env } = createTestApp();

        const response = await app.request("/api/v1/admin/orders/order_1/return", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: "wrong_size" }),
        }, env);

        expect(response.status).toBe(200);
        expect(mocks.enqueueOrderStatusChangeNotification).toHaveBeenCalledWith({
            db,
            queue,
            statusChange: {
                orderId: "order_1",
                previousStatus: "delivered",
                newStatus: "returned",
                version: 7,
            },
            source: "orders-return",
        });
    });

    it("does not resend returned notifications for already-returned orders", async () => {
        mocks.processReturn.mockResolvedValue({});
        const { app, env } = createTestApp();

        const response = await app.request("/api/v1/admin/orders/order_1/return", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: "already_returned" }),
        }, env);

        expect(response.status).toBe(200);
        expect(mocks.enqueueOrderStatusChangeNotification).not.toHaveBeenCalled();
    });

    it("enqueues returned and refunded notifications for auto-refunded returns", async () => {
        mocks.processReturn.mockResolvedValue({
            statusChange: {
                orderId: "order_1",
                previousStatus: "delivered",
                newStatus: "returned",
                version: 7,
            },
            refundResult: {
                success: true,
                gateway: "stripe",
                refundId: "re_return",
                amount: 120,
                isFullRefund: true,
                refundNotification: {
                    notificationType: "order_refunded",
                    dedupeKey: "refund:order_1:refund_order_1_8:full",
                    amount: 120,
                    refundId: "re_return",
                },
            },
        });
        const { app, env } = createTestApp();

        const response = await app.request("/api/v1/admin/orders/order_1/return", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: "wrong_size", autoRefund: true }),
        }, env);

        expect(response.status).toBe(200);
        expect(mocks.enqueueOrderStatusChangeNotification).toHaveBeenCalledWith({
            db,
            queue,
            statusChange: {
                orderId: "order_1",
                previousStatus: "delivered",
                newStatus: "returned",
                version: 7,
            },
            source: "orders-return",
        });
        expect(mocks.enqueueOrderRefundNotificationForOrder).toHaveBeenCalledWith({
            db,
            queue,
            orderId: "order_1",
            notificationType: "order_refunded",
            dedupeKey: "refund:order_1:refund_order_1_8:full",
            source: "orders-return-refund",
            data: { amount: 120, gateway: "stripe", refundId: "re_return" },
        });
        const body = await response.json() as { data: { refundResult?: Record<string, unknown> } };
        expect(body.data.refundResult).not.toHaveProperty("refundNotification");
    });
});
