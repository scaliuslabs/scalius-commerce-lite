import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getDashboardStats: vi.fn(),
    getDashboardSummaryStats: vi.fn(),
    getRecentOrders: vi.fn(),
    getDailyActivityData: vi.fn(),
}));

vi.mock("@scalius/core/modules/analytics", () => ({
    getDashboardStats: mocks.getDashboardStats,
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
        mocks.getDashboardSummaryStats.mockResolvedValue(homeStats);
        mocks.getRecentOrders.mockResolvedValue(recentOrders);
        const { app, db } = createTestApp();

        const response = await app.request("/api/v1/admin/dashboard/home-summary");
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toEqual({
            success: true,
            data: { stats: homeStats, recentOrders },
        });
        expect(mocks.getDashboardSummaryStats).toHaveBeenCalledWith(db);
        expect(mocks.getRecentOrders).toHaveBeenCalledWith(db, 11);
        expect(mocks.getDashboardStats).not.toHaveBeenCalled();
        expect(mocks.getDailyActivityData).not.toHaveBeenCalled();
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
