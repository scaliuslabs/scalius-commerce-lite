import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
    createOrder: vi.fn(),
    findCheckoutReservationAvailabilityTransitions: vi.fn(),
    invalidateProductAvailabilityCaches: vi.fn(),
}));

vi.mock("@scalius/core/modules/orders", async (importOriginal) => ({
    ...await importOriginal<typeof import("@scalius/core/modules/orders")>(),
    createOrder: mocks.createOrder,
}));

vi.mock("../../utils/cache-invalidation", async (importOriginal) => ({
    ...await importOriginal<typeof import("../../utils/cache-invalidation")>(),
    findCheckoutReservationAvailabilityTransitions: mocks.findCheckoutReservationAvailabilityTransitions,
    invalidateProductAvailabilityCaches: mocks.invalidateProductAvailabilityCaches,
}));

import { adminOrdersRoutes } from "./orders";

const requestKey = "11111111-1111-4111-8111-111111111111";
const otherRequestKey = "22222222-2222-4222-8222-222222222222";
const createBody = {
    customerName: "Test Buyer",
    customerPhone: "+8801712345678",
    customerEmail: null,
    shippingAddress: "House 1, Test Road",
    city: "dhaka",
    zone: "zone_1",
    area: null,
    notes: null,
    discountAmount: 0,
    shippingCharge: 0,
    items: [{ productId: "product_1", variantId: "variant_1", quantity: 1 }],
};

function createApp() {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    app.onError((error, c) => {
        const { body, status } = errorResponseFromError(error);
        return c.json(body, status);
    });
    app.use("*", async (c, next) => {
        c.set("db", { id: "db" } as never);
        c.set("user", { id: "admin_1" } as never);
        await next();
    });
    app.route("/orders", adminOrdersRoutes);
    return app;
}

describe("admin order create idempotency boundary", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createOrder.mockResolvedValue({ id: "order_1" });
        mocks.findCheckoutReservationAvailabilityTransitions.mockResolvedValue([]);
    });

    it("passes one canonical header key through exact request replay", async () => {
        const app = createApp();
        const request = () => app.request("/api/v1/admin/orders", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Idempotency-Key": requestKey },
            body: JSON.stringify(createBody),
        });

        expect((await request()).status).toBe(201);
        expect((await request()).status).toBe(201);
        expect(mocks.createOrder).toHaveBeenCalledTimes(2);
        for (const call of mocks.createOrder.mock.calls) {
            expect(call[1]).toMatchObject({ requestKey });
        }
    });

    it("preserves the legacy body key and rejects an exact header/body mismatch", async () => {
        const app = createApp();
        const legacy = await app.request("/api/v1/admin/orders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...createBody, requestKey }),
        });
        expect(legacy.status).toBe(201);

        mocks.createOrder.mockClear();
        const mismatch = await app.request("/api/v1/admin/orders", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Idempotency-Key": otherRequestKey },
            body: JSON.stringify({ ...createBody, requestKey }),
        });
        expect(mismatch.status).toBe(400);
        expect(mocks.createOrder).not.toHaveBeenCalled();
    });

    it("requires a header or legacy body key", async () => {
        const response = await createApp().request("/api/v1/admin/orders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(createBody),
        });
        expect(response.status).toBe(400);
        expect(mocks.createOrder).not.toHaveBeenCalled();
    });
});
