import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    createFulfillmentShipment: vi.fn(),
    invalidateProductAvailabilityCaches: vi.fn(),
    enqueueOrderStatusChangeNotification: vi.fn(),
}));

vi.mock("@scalius/core/modules/orders", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@scalius/core/modules/orders")>();
    return {
        ...actual,
        createFulfillmentShipment: mocks.createFulfillmentShipment,
    };
});

vi.mock("../../utils/cache-invalidation", () => ({
    invalidateProductAvailabilityCaches: mocks.invalidateProductAvailabilityCaches,
}));

vi.mock("../../utils/order-notification-queue", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../utils/order-notification-queue")>();
    return {
        ...actual,
        enqueueOrderStatusChangeNotification: mocks.enqueueOrderStatusChangeNotification,
    };
});

import { adminOrdersStatusRoutes } from "./orders-status";

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
    app.route("/orders", adminOrdersStatusRoutes);

    return { app, env };
}

describe("admin manual fulfillment notifications", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.invalidateProductAvailabilityCaches.mockResolvedValue(undefined);
        mocks.enqueueOrderStatusChangeNotification.mockResolvedValue({
            orderId: "order_1",
            enqueued: true,
        });
    });

    it("enqueues a shipped notification after final manual fulfillment changes order status", async () => {
        mocks.createFulfillmentShipment.mockResolvedValue({
            shipmentId: "shp_1",
            isFinalShipment: true,
            fulfillmentStatus: "complete",
            statusChange: {
                orderId: "order_1",
                previousStatus: "confirmed",
                newStatus: "shipped",
                version: 7,
            },
        });
        const { app, env } = createTestApp();

        const response = await app.request("/api/v1/admin/orders/order_1/fulfill", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                itemIds: ["item_1"],
                isFinalShipment: true,
                trackingId: "TRK-1",
            }),
        }, env);

        expect(response.status).toBe(201);
        expect(mocks.invalidateProductAvailabilityCaches).toHaveBeenCalledWith(
            db,
            { orderIds: ["order_1"] },
            expect.anything(),
        );
        expect(mocks.enqueueOrderStatusChangeNotification).toHaveBeenCalledWith({
            db,
            queue,
            statusChange: {
                orderId: "order_1",
                previousStatus: "confirmed",
                newStatus: "shipped",
                version: 7,
            },
            trackingId: "TRK-1",
            source: "orders-manual-fulfillment",
        });

        const body = await response.json() as { data: Record<string, unknown> };
        expect(body.data).toMatchObject({
            shipmentId: "shp_1",
            isFinalShipment: true,
            fulfillmentStatus: "complete",
        });
        expect(body.data).not.toHaveProperty("statusChange");
    });

    it("does not invent a notification when manual fulfillment only changes fulfillment status", async () => {
        mocks.createFulfillmentShipment.mockResolvedValue({
            shipmentId: "shp_2",
            isFinalShipment: false,
            fulfillmentStatus: "partial",
        });
        const { app, env } = createTestApp();

        const response = await app.request("/api/v1/admin/orders/order_1/fulfill", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                itemIds: ["item_1"],
                isFinalShipment: false,
            }),
        }, env);

        expect(response.status).toBe(201);
        expect(mocks.enqueueOrderStatusChangeNotification).toHaveBeenCalledWith({
            db,
            queue,
            statusChange: undefined,
            trackingId: null,
            source: "orders-manual-fulfillment",
        });
    });
});
