import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    listOrderNotificationOutboxForOrder: vi.fn(),
    retryFailedOrderNotificationOutboxById: vi.fn(),
}));

vi.mock("@scalius/core/modules/notifications", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@scalius/core/modules/notifications")>();
    return {
        ...actual,
        listOrderNotificationOutboxForOrder: mocks.listOrderNotificationOutboxForOrder,
        retryFailedOrderNotificationOutboxById: mocks.retryFailedOrderNotificationOutboxById,
    };
});

import { adminOrdersRoutes } from "./orders";

const db = { id: "db" };
const queue = { send: vi.fn(async () => undefined) };

function createTestApp() {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    const env = {
        ORDER_NOTIFICATIONS_QUEUE: queue,
    } as unknown as Env;

    app.use("*", async (c, next) => {
        c.set("db", db as never);
        c.set("user", { id: "admin_1" } as never);
        await next();
    });
    app.route("/orders", adminOrdersRoutes);

    return { app, env };
}

describe("admin order notification routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.listOrderNotificationOutboxForOrder.mockResolvedValue([{
            id: "outbox_1",
            dedupeKey: "order_status:order_1:v2:confirmed->shipped",
            orderId: "order_1",
            notificationType: "order_shipped",
            source: "orders-status",
            status: "failed",
            attempts: 2,
            nextAttemptAt: 1_765_000_000,
            lastError: "SMS provider timeout",
            queuedAt: null,
            sentAt: null,
            createdAt: 1_765_000_000,
            updatedAt: 1_765_000_060,
            receipts: [{
                id: "receipt_1",
                receiptKey: "outbox_1:sms:hash",
                channel: "sms",
                provider: "gennet",
                recipientMasked: "***8888",
                status: "failed",
                providerMessageId: null,
                providerStatus: "timeout",
                attempts: 2,
                nextAttemptAt: 1_765_000_120,
                lastAttemptAt: 1_765_000_060,
                lastError: "timeout",
                acceptedAt: null,
                deliveredAt: null,
                failedAt: 1_765_000_060,
                skippedAt: null,
                createdAt: 1_765_000_000,
                updatedAt: 1_765_000_060,
            }],
        }]);
        mocks.retryFailedOrderNotificationOutboxById.mockResolvedValue({
            outboxId: "outbox_1",
            dedupeKey: "order_status:order_1:v2:confirmed->shipped",
            created: false,
            enqueued: true,
        });
    });

    it("returns outbox and receipt delivery state for an order", async () => {
        const { app, env } = createTestApp();

        const response = await app.request(
            "/api/v1/admin/orders/order_1/notifications",
            undefined,
            env,
        );

        expect(response.status).toBe(200);
        expect(mocks.listOrderNotificationOutboxForOrder).toHaveBeenCalledWith(db, "order_1");
        const body = await response.json() as { data: { notifications: Array<Record<string, unknown>> } };
        expect(body.data.notifications).toHaveLength(1);
        expect(body.data.notifications[0]).toMatchObject({
            id: "outbox_1",
            status: "failed",
            receipts: [{
                channel: "sms",
                provider: "gennet",
                status: "failed",
            }],
        });
    });

    it("retries a failed notification through the durable outbox", async () => {
        const { app, env } = createTestApp();

        const response = await app.request(
            "/api/v1/admin/orders/order_1/notifications/outbox_1/retry",
            { method: "POST" },
            env,
        );

        expect(response.status).toBe(200);
        expect(mocks.retryFailedOrderNotificationOutboxById).toHaveBeenCalledWith({
            db,
            queue,
            orderId: "order_1",
            outboxId: "outbox_1",
        });
        const body = await response.json() as { data: Record<string, unknown> };
        expect(body.data).toMatchObject({
            outboxId: "outbox_1",
            enqueued: true,
        });
    });
});
