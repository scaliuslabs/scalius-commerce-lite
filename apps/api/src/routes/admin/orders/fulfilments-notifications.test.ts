import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    recordOrderFulfilment: vi.fn(),
    recordOrderEvent: vi.fn(),
    bumpCacheGeneration: vi.fn(),
    enqueueOrderStatusChangeNotification: vi.fn(),
    enqueueOrderNotificationsForStatus: vi.fn(),
}));

vi.mock("@scalius/core/modules/fulfilment", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@scalius/core/modules/fulfilment")>();
    return {
        ...actual,
        recordOrderFulfilment: mocks.recordOrderFulfilment,
    };
});

vi.mock("@scalius/core/modules/orders", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@scalius/core/modules/orders")>();
    return {
        ...actual,
        recordOrderEvent: mocks.recordOrderEvent,
    };
});

vi.mock("../../../utils/cache-generation", () => ({
    bumpCacheGeneration: mocks.bumpCacheGeneration,
}));

vi.mock("../../../utils/order-notification-queue", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../utils/order-notification-queue")>();
    return {
        ...actual,
        enqueueOrderStatusChangeNotification: mocks.enqueueOrderStatusChangeNotification,
        enqueueOrderNotificationsForStatus: mocks.enqueueOrderNotificationsForStatus,
    };
});

import { adminOrderFulfilmentRoutes } from "./fulfilments";

const db = { id: "db" };
const queue = { send: vi.fn(async () => undefined) };

function createTestApp() {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    const env = {
        JOBS_QUEUE: queue,
    } as unknown as Env;

    app.use("*", async (c, next) => {
        c.set("db", db as never);
        c.set("user", { id: "admin_1" } as never);
        await next();
    });
    app.route("/orders", adminOrderFulfilmentRoutes);

    return { app, env };
}

function sent(overrides: Record<string, unknown> = {}) {
    return {
        orderId: "order_1",
        fulfillmentId: "ful_1",
        kind: "ship",
        lines: [{ orderItemId: "item_1", quantity: 2 }],
        shipmentId: "shp_1",
        orderStatus: "shipped",
        fulfillmentStatus: "complete",
        replayed: false,
        isFinalShipment: true,
        availabilityTransitionVariantIds: [],
        awaitingPayment: false,
        ...overrides,
    };
}

function post(app: ReturnType<typeof createTestApp>["app"], env: Env) {
    return app.request("/api/v1/admin/orders/order_1/fulfillments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            requestKey: "8a0f4f7e-7a4f-4f63-9d7e-3b8f0d1c2e4a",
            kind: "ship",
            lines: [{ itemId: "item_1", quantity: 2 }],
            tracking: { trackingId: "TRK-1" },
        }),
    }, env);
}

describe("admin own-rider fulfilment notifications", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.bumpCacheGeneration.mockResolvedValue(undefined);
        mocks.recordOrderEvent.mockResolvedValue(undefined);
        mocks.enqueueOrderStatusChangeNotification.mockResolvedValue({ orderId: "order_1", enqueued: true });
        mocks.enqueueOrderNotificationsForStatus.mockResolvedValue(undefined);
    });

    it("enqueues a shipped notification when the last parcel moves the order to shipped", async () => {
        mocks.recordOrderFulfilment.mockResolvedValue(sent({
            statusChange: { orderId: "order_1", previousStatus: "confirmed", newStatus: "shipped", version: 7 },
        }));
        const { app, env } = createTestApp();

        const response = await post(app, env);

        expect(response.status).toBe(201);
        expect(mocks.bumpCacheGeneration).not.toHaveBeenCalled();
        expect(mocks.enqueueOrderStatusChangeNotification).toHaveBeenCalledWith({
            db,
            queue,
            statusChange: { orderId: "order_1", previousStatus: "confirmed", newStatus: "shipped", version: 7 },
            trackingId: "TRK-1",
            source: "orders-fulfilment",
        });
        expect(mocks.enqueueOrderNotificationsForStatus).not.toHaveBeenCalled();

        const body = await response.json() as { data: Record<string, unknown> };
        expect(body.data).toMatchObject({ shipmentId: "shp_1", fulfillmentStatus: "complete", replayed: false });
        expect(body.data).not.toHaveProperty("statusChange");
        expect(body.data).not.toHaveProperty("availabilityTransitionVariantIds");
    });

    it("tells the buyer about an earlier parcel of a split shipment (R2-ORD-06)", async () => {
        mocks.recordOrderFulfilment.mockResolvedValue(sent({
            orderStatus: "confirmed",
            fulfillmentStatus: "partial",
            isFinalShipment: false,
        }));
        const { app, env } = createTestApp();

        const response = await post(app, env);

        expect(response.status).toBe(201);
        expect(mocks.enqueueOrderStatusChangeNotification).not.toHaveBeenCalled();
        expect(mocks.enqueueOrderNotificationsForStatus).toHaveBeenCalledWith(expect.objectContaining({
            orderIds: ["order_1"],
            newStatus: "shipped",
            trackingByOrderId: { order_1: "TRK-1" },
            dedupeKeyByOrderId: { order_1: "shipment:shp_1:order_shipped" },
        }));
    });

    it("sends nothing again for a replayed request", async () => {
        mocks.recordOrderFulfilment.mockResolvedValue(sent({ replayed: true }));
        const { app, env } = createTestApp();

        const response = await post(app, env);

        expect(response.status).toBe(201);
        expect(mocks.recordOrderEvent).not.toHaveBeenCalled();
        expect(mocks.enqueueOrderStatusChangeNotification).not.toHaveBeenCalled();
        expect(mocks.enqueueOrderNotificationsForStatus).not.toHaveBeenCalled();
    });
});
