import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    listOrderSupportRequests: vi.fn(),
    listOrderReturns: vi.fn(),
    createOrderReturn: vi.fn(),
    updateAdminOrderSupportRequestStatus: vi.fn(),
    enqueueOrderSupportRequestNotificationForOrder: vi.fn(),
}));

vi.mock("@scalius/core/modules/orders/order-support-requests", async (importOriginal) => ({
    ...await importOriginal<typeof import("@scalius/core/modules/orders/order-support-requests")>(),
    updateAdminOrderSupportRequestStatus: mocks.updateAdminOrderSupportRequestStatus,
}));
vi.mock("@scalius/core/modules/orders", async (importOriginal) => ({
    ...await importOriginal<typeof import("@scalius/core/modules/orders")>(),
    listOrderSupportRequests: mocks.listOrderSupportRequests,
    listOrderReturns: mocks.listOrderReturns,
    createOrderReturn: mocks.createOrderReturn,
}));
vi.mock("../../utils/order-notification-queue", () => ({
    enqueueOrderSupportRequestNotificationForOrder: mocks.enqueueOrderSupportRequestNotificationForOrder,
}));

import { adminOrdersSupportRequestRoutes } from "./orders-support-requests";

const db = { name: "db" };
const env = { ORDER_NOTIFICATIONS_QUEUE: { send: vi.fn() } } as unknown as Env;

function app() {
    const instance = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    instance.use("*", async (c, next) => {
        c.set("db", db as never);
        c.set("user", { id: "admin_1" } as never);
        await next();
    });
    instance.route("/orders", adminOrdersSupportRequestRoutes);
    return instance;
}

describe("support return approval linkage", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.listOrderSupportRequests.mockResolvedValue([{
            id: "osr_1", orderId: "order_1", type: "return", status: "submitted", returnId: null,
        }]);
        mocks.listOrderReturns.mockResolvedValue([]);
        mocks.createOrderReturn.mockResolvedValue({ returnId: "ret_1" });
        mocks.updateAdminOrderSupportRequestStatus.mockResolvedValue({
            request: { id: "osr_1", type: "return", label: "Return approved" },
            supportRequests: [], statusChanged: true, previousStatus: "submitted", newStatus: "approved",
        });
    });

    it("creates and links an item return before approving buyer support", async () => {
        const response = await app().request(
            "/api/v1/admin/orders/order_1/support-requests/osr_1/status",
            {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    status: "approved",
                    returnRequest: {
                        commandKey: "support-return-1",
                        expectedOrderVersion: 6,
                        reason: "wrong size",
                        lines: [{ orderItemId: "item_1", quantity: 1 }],
                    },
                }),
            },
            env,
        );

        expect(response.status).toBe(200);
        expect(mocks.createOrderReturn).toHaveBeenCalledWith(
            db, "order_1", expect.objectContaining({ commandKey: "support-return-1" }),
            { type: "admin", id: "admin_1" },
            { source: "support_request", sourceReferenceId: "osr_1" },
        );
        expect(mocks.updateAdminOrderSupportRequestStatus).toHaveBeenCalledWith(
            db, "order_1", "osr_1",
            expect.objectContaining({ status: "approved", returnId: "ret_1" }),
        );
    });

    it("recovers an existing source-linked return without duplicate creation", async () => {
        mocks.listOrderReturns.mockResolvedValue([{
            id: "ret_existing", source: "support_request", sourceReferenceId: "osr_1",
        }]);
        const response = await app().request(
            "/api/v1/admin/orders/order_1/support-requests/osr_1/status",
            { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "approved" }) },
            env,
        );

        expect(response.status).toBe(200);
        expect(mocks.createOrderReturn).not.toHaveBeenCalled();
        expect(mocks.updateAdminOrderSupportRequestStatus).toHaveBeenCalledWith(
            db, "order_1", "osr_1", expect.objectContaining({ returnId: "ret_existing" }),
        );
    });
});
