import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getDashboardStats: vi.fn(),
    getDashboardHomeSummary: vi.fn(),
    getDashboardSummaryStats: vi.fn(),
    getRecentOrders: vi.fn(),
    getDailyActivityData: vi.fn(),
}));

vi.mock("@scalius/core/modules/analytics", () => ({
    getDashboardStats: mocks.getDashboardStats,
    getDashboardHomeSummary: mocks.getDashboardHomeSummary,
    getDashboardSummaryStats: mocks.getDashboardSummaryStats,
    getRecentOrders: mocks.getRecentOrders,
    getDailyActivityData: mocks.getDailyActivityData,
}));

import { adminDashboardRoutes } from "./dashboard";

const stats = {
    totalProducts: 12,
    totalCustomers: 34,
    totalRevenue: 5678,
    currentMonth: {
        orders: 9,
        revenue: 1234,
        orderGrowth: 10,
        revenueGrowth: 20,
        orderStatus: {
            delivered: 3,
            processing: 4,
            shipping: 1,
            cancelled: 1,
        },
    },
    lastMonth: {
        orders: 8,
        revenue: 1000,
    },
};

const homeStats = {
    totalProducts: stats.totalProducts,
    totalCustomers: stats.totalCustomers,
    currentMonth: stats.currentMonth,
    lastMonth: stats.lastMonth,
};

const recentOrders = [
    {
        id: "ord_1",
        customerName: "Ada Lovelace",
        totalAmount: 42,
        status: "processing",
        createdAt: "2026-06-14T12:00:00.000Z",
    },
];
const recentOrderId = recentOrders[0]?.id ?? "ord_1";

const dailyActivityData = [
    {
        date: "2026-06-14",
        orders: 2,
        revenue: 100,
        newCustomers: 1,
    },
];

function createTestApp() {
    const db = { id: "db" };
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");

    app.use("*", async (c, next) => {
        c.set("db", db as never);
        await next();
    });
    app.route("/admin/dashboard", adminDashboardRoutes);

    return { app, db };
}

describe("admin dashboard routes", () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it("serves lightweight home summary data without lifetime revenue or activity queries", async () => {
        mocks.getDashboardHomeSummary.mockResolvedValue({ stats: homeStats, recentOrders });
        const { app, db } = createTestApp();

        const response = await app.request("/api/v1/admin/dashboard/home-summary");
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({
            success: true,
            data: { stats: homeStats, recentOrders },
        });
        expect(mocks.getDashboardHomeSummary).toHaveBeenCalledWith(db, 11);
        expect(mocks.getDashboardSummaryStats).not.toHaveBeenCalled();
        expect(mocks.getRecentOrders).not.toHaveBeenCalled();
        expect(mocks.getDashboardStats).not.toHaveBeenCalled();
        expect(mocks.getDailyActivityData).not.toHaveBeenCalled();
    });

    it("returns a bounded recent-order projection without hidden customer fields", async () => {
        mocks.getDashboardHomeSummary.mockResolvedValue({
            stats: homeStats,
            recentOrders: Array.from({ length: 20 }, (_, index) => ({
                ...recentOrders[0],
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

    it("serves metrics summary data without PII, orders, lifetime revenue, or activity data", async () => {
        mocks.getDashboardSummaryStats.mockResolvedValue(homeStats);
        const { app, db } = createTestApp();

        const response = await app.request("/api/v1/admin/dashboard/metrics-summary");
        const responseText = await response.text();
        const body = JSON.parse(responseText);

        expect(response.status).toBe(200);
        expect(body).toEqual({
            success: true,
            data: { stats: homeStats },
        });
        expect(mocks.getDashboardSummaryStats).toHaveBeenCalledWith(db);
        expect(mocks.getDashboardStats).not.toHaveBeenCalled();
        expect(mocks.getRecentOrders).not.toHaveBeenCalled();
        expect(mocks.getDailyActivityData).not.toHaveBeenCalled();
        expect(responseText).not.toContain("recentOrders");
        expect(responseText).not.toContain("customerName");
        expect(responseText).not.toContain("totalRevenue");
        expect(responseText).not.toContain("dailyActivityData");
        expect(responseText).not.toContain(recentOrderId);
    });

    it("serves full summary data without running the activity query", async () => {
        mocks.getDashboardStats.mockResolvedValue(stats);
        mocks.getRecentOrders.mockResolvedValue(recentOrders);
        const { app, db } = createTestApp();

        const response = await app.request("/api/v1/admin/dashboard/summary");
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({
            success: true,
            data: { stats, recentOrders },
        });
        expect(mocks.getDashboardStats).toHaveBeenCalledWith(db);
        expect(mocks.getRecentOrders).toHaveBeenCalledWith(db, 11);
        expect(mocks.getDailyActivityData).not.toHaveBeenCalled();
    });

    it("serves activity data without running summary queries", async () => {
        mocks.getDailyActivityData.mockResolvedValue(dailyActivityData);
        const { app, db } = createTestApp();

        const response = await app.request("/api/v1/admin/dashboard/activity");
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({
            success: true,
            data: { dailyActivityData },
        });
        expect(mocks.getDailyActivityData).toHaveBeenCalledWith(db, 90);
        expect(mocks.getDashboardStats).not.toHaveBeenCalled();
        expect(mocks.getRecentOrders).not.toHaveBeenCalled();
    });

    it("keeps the legacy combined endpoint available", async () => {
        mocks.getDashboardStats.mockResolvedValue(stats);
        mocks.getRecentOrders.mockResolvedValue(recentOrders);
        mocks.getDailyActivityData.mockResolvedValue(dailyActivityData);
        const { app, db } = createTestApp();

        const response = await app.request("/api/v1/admin/dashboard");
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({
            success: true,
            data: { stats, recentOrders, dailyActivityData },
        });
        expect(mocks.getDashboardStats).toHaveBeenCalledWith(db);
        expect(mocks.getRecentOrders).toHaveBeenCalledWith(db, 11);
        expect(mocks.getDailyActivityData).toHaveBeenCalledWith(db, 90);
    });
});
