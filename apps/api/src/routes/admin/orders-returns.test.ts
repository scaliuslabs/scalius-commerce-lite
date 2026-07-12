import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    createOrderReturn: vi.fn(),
    approveOrderReturn: vi.fn(),
    receiveOrderReturn: vi.fn(),
    cancelOrderReturn: vi.fn(),
    reconcileOrderReturnReceipt: vi.fn(),
    listOrderReturns: vi.fn(),
    getOrderReturn: vi.fn(),
    invalidateProductAvailabilityCaches: vi.fn(),
    enqueueOrderNotificationsForStatus: vi.fn(),
}));

vi.mock("@scalius/core/modules/orders", async (importOriginal) => ({
    ...await importOriginal<typeof import("@scalius/core/modules/orders")>(),
    createOrderReturn: mocks.createOrderReturn,
    approveOrderReturn: mocks.approveOrderReturn,
    receiveOrderReturn: mocks.receiveOrderReturn,
    cancelOrderReturn: mocks.cancelOrderReturn,
    reconcileOrderReturnReceipt: mocks.reconcileOrderReturnReceipt,
    listOrderReturns: mocks.listOrderReturns,
    getOrderReturn: mocks.getOrderReturn,
}));

vi.mock("../../utils/cache-invalidation", () => ({
    invalidateProductAvailabilityCaches: mocks.invalidateProductAvailabilityCaches,
}));

vi.mock("../../utils/order-notification-queue", () => ({
    enqueueOrderNotificationsForStatus: mocks.enqueueOrderNotificationsForStatus,
}));

import { adminOrdersReturnRoutes } from "./orders-returns";

const db = { name: "db" };
const env = { ORDER_NOTIFICATIONS_QUEUE: { send: vi.fn() } } as unknown as Env;
const baseResult = {
    orderId: "order_1",
    returnId: "ret_1",
    status: "requested",
    version: 1,
    restockedQuantity: 0,
    wholeOrderReturned: false,
};

function createApp() {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    app.use("*", async (c, next) => {
        c.set("db", db as never);
        c.set("user", { id: "admin_1" } as never);
        await next();
    });
    app.route("/orders", adminOrdersReturnRoutes);
    return app;
}

describe("admin item return routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createOrderReturn.mockResolvedValue(baseResult);
        mocks.approveOrderReturn.mockResolvedValue({ ...baseResult, status: "approved", version: 2 });
        mocks.receiveOrderReturn.mockResolvedValue({ ...baseResult, status: "receiving", version: 3 });
        mocks.reconcileOrderReturnReceipt.mockResolvedValue({ ...baseResult, status: "receiving", version: 3 });
    });

    it("does not invalidate stock on request or approval", async () => {
        const app = createApp();
        const requestResponse = await app.request("/api/v1/admin/orders/order_1/returns", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                commandKey: "return-create-1",
                expectedOrderVersion: 4,
                reason: "wrong size",
                lines: [{ orderItemId: "item_1", quantity: 1 }],
            }),
        }, env);
        const approveResponse = await app.request("/api/v1/admin/orders/order_1/returns/ret_1/approve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                commandKey: "return-approve-1",
                expectedVersion: 1,
                lines: [{ lineId: "line_1", approvedQuantity: 1, rejectedQuantity: 0 }],
            }),
        }, env);

        expect(requestResponse.status).toBe(201);
        expect(approveResponse.status).toBe(200);
        expect(mocks.invalidateProductAvailabilityCaches).not.toHaveBeenCalled();
    });

    it("invalidates availability only after an explicit restock disposition", async () => {
        mocks.receiveOrderReturn.mockResolvedValue({
            ...baseResult,
            status: "completed",
            version: 3,
            restockedQuantity: 1,
        });
        const app = createApp();
        const response = await app.request("/api/v1/admin/orders/order_1/returns/ret_1/receive", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                commandKey: "return-receive-1",
                expectedVersion: 2,
                lines: [{
                    lineId: "line_1",
                    receivedQuantity: 1,
                    restockQuantity: 1,
                    damagedQuantity: 0,
                }],
            }),
        }, env);

        expect(response.status).toBe(200);
        expect(mocks.invalidateProductAvailabilityCaches).toHaveBeenCalledWith(
            db,
            { orderIds: ["order_1"] },
            expect.anything(),
        );
        expect(mocks.enqueueOrderNotificationsForStatus).not.toHaveBeenCalled();
    });

    it("emits returned status only when receipt completion derives a fully returned order", async () => {
        mocks.receiveOrderReturn.mockResolvedValue({
            ...baseResult,
            status: "completed",
            version: 3,
            wholeOrderReturned: true,
        });
        const app = createApp();
        const response = await app.request("/api/v1/admin/orders/order_1/returns/ret_1/receive", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                commandKey: "return-receive-2",
                expectedVersion: 2,
                lines: [{ lineId: "line_1", receivedQuantity: 1, restockQuantity: 0, damagedQuantity: 1 }],
            }),
        }, env);

        expect(response.status).toBe(200);
        expect(mocks.enqueueOrderNotificationsForStatus).toHaveBeenCalledWith(expect.objectContaining({
            orderIds: ["order_1"],
            newStatus: "returned",
        }));
    });
});
