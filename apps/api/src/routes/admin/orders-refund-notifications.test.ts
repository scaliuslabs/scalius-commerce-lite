import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    processRefund: vi.fn(),
    reconcileRefundAttemptForOrder: vi.fn(),
    getCredentialEncryptionKey: vi.fn(),
    invalidateProductAvailabilityCaches: vi.fn(),
    enqueueOrderRefundNotificationForOrder: vi.fn(),
}));

vi.mock("@scalius/core/modules/payments/refund-service", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@scalius/core/modules/payments/refund-service")>();
    return {
        ...actual,
        processRefund: mocks.processRefund,
    };
});

vi.mock("@scalius/core/modules/payments/refund-reconciliation", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@scalius/core/modules/payments/refund-reconciliation")>();
    return {
        ...actual,
        reconcileRefundAttemptForOrder: mocks.reconcileRefundAttemptForOrder,
    };
});

vi.mock("../../utils/encryption-key", () => ({
    getCredentialEncryptionKey: mocks.getCredentialEncryptionKey,
}));

vi.mock("../../utils/cache-invalidation", () => ({
    invalidateProductAvailabilityCaches: mocks.invalidateProductAvailabilityCaches,
}));

vi.mock("../../utils/order-notification-queue", () => ({
    enqueueOrderRefundNotificationForOrder: mocks.enqueueOrderRefundNotificationForOrder,
}));

import { PartialRefundProcessedError } from "@scalius/core/modules/payments/refund-service";
import { errorResponseFromError } from "../../utils/api-response";
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
    app.onError((error, c) => {
        const { body, status } = errorResponseFromError(error);
        return c.json(body, status);
    });
    app.route("/orders", adminOrdersRefundRoutes);

    return { app, env };
}

describe("admin refund notification routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCredentialEncryptionKey.mockReturnValue("credential-key");
        mocks.reconcileRefundAttemptForOrder.mockResolvedValue({
            found: true,
            status: "deferred",
            orderIds: [],
            refundNotifications: [],
        });
        mocks.invalidateProductAvailabilityCaches.mockResolvedValue(undefined);
        mocks.enqueueOrderRefundNotificationForOrder.mockResolvedValue({ orderId: "order_1", enqueued: true });
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

    it("enqueues committed refund facts even when a split refund returns an operator-facing failure", async () => {
        mocks.processRefund.mockRejectedValue(new PartialRefundProcessedError(
            "Refund partially processed: 70 was accepted by the provider, but 30 has an unknown provider outcome. Do not retry until the pending refund is reconciled.",
            {
                affectedOrderIds: ["order_1"],
                gateway: "stripe",
                refundNotifications: [{
                    orderId: "order_1",
                    notificationType: "order_partially_refunded",
                    dedupeKey: "refund-reconcile:order_1:rfa_refund_order_1_3_1:partial",
                    amount: 70,
                    refundId: "refund_balance",
                }, {
                    orderId: "order_1",
                    notificationType: "refund_processing",
                    dedupeKey: "refund:order_1:refund_order_1_3:processing",
                    amount: 30,
                }],
            },
        ));
        const { app, env } = createTestApp();

        const response = await app.request("/api/v1/admin/orders/order_1/refund", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: "split_gateway_timeout" }),
        }, env);

        expect(response.status).toBe(503);
        expect(mocks.invalidateProductAvailabilityCaches).toHaveBeenCalledWith(
            db,
            { orderIds: ["order_1"] },
            expect.anything(),
        );
        expect(mocks.enqueueOrderRefundNotificationForOrder).toHaveBeenNthCalledWith(1, {
            db,
            queue,
            orderId: "order_1",
            notificationType: "order_partially_refunded",
            dedupeKey: "refund-reconcile:order_1:rfa_refund_order_1_3_1:partial",
            source: "orders-refund-partial-failure",
            data: { amount: 70, gateway: "stripe", refundId: "refund_balance" },
        });
        expect(mocks.enqueueOrderRefundNotificationForOrder).toHaveBeenNthCalledWith(2, {
            db,
            queue,
            orderId: "order_1",
            notificationType: "refund_processing",
            dedupeKey: "refund:order_1:refund_order_1_3:processing",
            source: "orders-refund-partial-failure",
            data: { amount: 30, gateway: "stripe" },
        });
        const body = await response.json() as { error: { code: string; message: string; details?: unknown } };
        expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
        expect(body.error.message).toContain("Refund partially processed");
        expect(body.error.details).toBeUndefined();
    });

    it("checks a refund attempt and records recovery side effects without leaking notification facts", async () => {
        mocks.reconcileRefundAttemptForOrder.mockResolvedValue({
            found: true,
            status: "finalized",
            orderIds: ["order_1"],
            refundNotifications: [{
                orderId: "order_1",
                notificationType: "order_partially_refunded",
                dedupeKey: "refund-reconcile:order_1:rfa_1:partial",
                amount: 25,
                refundId: "re_1",
            }],
        });
        const { app, env } = createTestApp();

        const response = await app.request("/api/v1/admin/orders/order_1/refund-attempts/rfa_1/reconcile", {
            method: "POST",
        }, env);

        expect(response.status).toBe(200);
        expect(mocks.reconcileRefundAttemptForOrder).toHaveBeenCalledWith(
            db,
            env.CACHE,
            "order_1",
            "rfa_1",
            { encryptionKey: "credential-key" },
        );
        expect(mocks.invalidateProductAvailabilityCaches).toHaveBeenCalledWith(
            db,
            { orderIds: ["order_1"] },
            expect.anything(),
        );
        expect(mocks.enqueueOrderRefundNotificationForOrder).toHaveBeenCalledWith({
            db,
            queue,
            orderId: "order_1",
            notificationType: "order_partially_refunded",
            dedupeKey: "refund-reconcile:order_1:rfa_1:partial",
            source: "orders-refund-reconciliation",
            data: { amount: 25, refundId: "re_1" },
        });
        const body = await response.json() as { data: Record<string, unknown> };
        expect(body.data).toEqual({
            attemptId: "rfa_1",
            status: "finalized",
            orderIds: ["order_1"],
            notificationCount: 1,
            sideEffectErrors: 0,
        });
    });

    it("returns not found for a refund attempt that does not belong to the order", async () => {
        mocks.reconcileRefundAttemptForOrder.mockResolvedValue({
            found: false,
            status: "deferred",
            reason: "not_found",
            orderIds: [],
            refundNotifications: [],
        });
        const { app, env } = createTestApp();

        const response = await app.request("/api/v1/admin/orders/order_1/refund-attempts/rfa_other/reconcile", {
            method: "POST",
        }, env);

        expect(response.status).toBe(404);
        expect(mocks.invalidateProductAvailabilityCaches).not.toHaveBeenCalled();
        expect(mocks.enqueueOrderRefundNotificationForOrder).not.toHaveBeenCalled();
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

});
