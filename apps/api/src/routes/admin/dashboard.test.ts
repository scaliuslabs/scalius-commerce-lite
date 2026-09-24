import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getDashboardHomeSummary: vi.fn(),
    getDailyActivityData: vi.fn(),
}));

vi.mock("@scalius/core/modules/analytics", () => ({
    getDashboardStats: vi.fn(),
    getDashboardHomeSummary: mocks.getDashboardHomeSummary,
    getDashboardSummaryStats: vi.fn(),
    getRecentOrders: vi.fn(),
    getDailyActivityData: mocks.getDailyActivityData,
}));

import { adminDashboardRoutes } from "./dashboard";

const homeStats = {
    totalProducts: 12,
    totalCustomers: 34,
    currentMonth: {
        orders: 9,
        revenue: 1234,
        orderGrowth: 10,
        revenueGrowth: 20,
        orderStatus: { delivered: 3, processing: 4, shipping: 1, cancelled: 1 },
    },
    lastMonth: { orders: 8, revenue: 1000 },
};

const recentOrder = {
    id: "ord_1",
    orderNumber: 1001,
    customerName: "Ada Lovelace",
    totalAmount: 42,
    status: "processing",
    createdAt: "2026-06-14T12:00:00.000Z",
};

function createTestApp() {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");

    app.use("*", async (c, next) => {
        c.set("db", { id: "db" } as never);
        await next();
    });
    app.route("/admin/dashboard", adminDashboardRoutes);

    return { app };
}

describe("admin dashboard routes", () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it("returns a bounded recent-order projection without hidden customer fields", async () => {
        mocks.getDashboardHomeSummary.mockResolvedValue({
            stats: homeStats,
            recentOrders: Array.from({ length: 20 }, (_, index) => ({
                ...recentOrder,
                id: `ord_${index}_${"i".repeat(300)}`,
                customerName: `Merchant customer ${index} ${"n".repeat(1_000)}`,
                status: `processing_${"s".repeat(200)}`,
                customerEmail: "must-not-project@example.com",
                receiptProof: "chk_must_not_project",
            })),
        });
        const { app } = createTestApp();

        const response = await app.request("/api/v1/admin/dashboard/home-summary");
        const responseText = await response.text();
        const body = JSON.parse(responseText);

        expect(response.status).toBe(200);
        expect(new TextEncoder().encode(responseText).byteLength).toBeLessThan(65_536);
        expect(body.data.recentOrders).toHaveLength(11);
        expect(body.data.recentOrders[0]).toEqual({
            id: expect.stringMatching(/^ord_0_/),
            orderNumber: 1001,
            customerName: expect.stringMatching(/^Merchant customer 0 /),
            totalAmount: 42,
            status: expect.stringMatching(/^processing_/),
            createdAt: "2026-06-14T12:00:00.000Z",
        });
        expect(body.data.recentOrders[0].id).toHaveLength(128);
        expect(body.data.recentOrders[0].customerName).toHaveLength(256);
        expect(body.data.recentOrders[0].status).toHaveLength(64);
        expect(responseText).not.toContain("must-not-project@example.com");
        expect(responseText).not.toContain("chk_must_not_project");
    });

    it.each(["0", "91", "1.5", "not-a-number"])(
        "rejects an invalid activity day window (%s)",
        async (days) => {
            const { app } = createTestApp();

            const response = await app.request(`/api/v1/admin/dashboard/activity?days=${days}`);

            expect(response.status).toBe(400);
            expect(mocks.getDailyActivityData).not.toHaveBeenCalled();
        },
    );
});
