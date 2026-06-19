// src/server/routes/admin/dashboard.ts
// Admin OpenAPI routes for dashboard summary and activity data.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    getDashboardStats,
    getDashboardSummaryStats,
    getRecentOrders,
    getDailyActivityData,
} from "@scalius/core/modules/analytics";

import { ok } from "../../utils/api-response";
import { successEnvelope } from "../../schemas/responses";
import { timestampSchema } from "../../schemas/timestamps";

const app = new OpenAPIHono<{ Bindings: Env }>();

// ─── Inline response schemas ──

const dashboardStatsSchema = z.object({
    totalProducts: z.number(),
    totalCustomers: z.number(),
    totalRevenue: z.number(),
    currentMonth: z.object({
        orders: z.number(),
        revenue: z.number(),
        orderGrowth: z.number(),
        revenueGrowth: z.number(),
        orderStatus: z.object({
            delivered: z.number(),
            processing: z.number(),
            shipping: z.number(),
            cancelled: z.number(),
        }),
    }),
    lastMonth: z.object({
        orders: z.number(),
        revenue: z.number(),
    }),
});

const recentOrderSchema = z.object({
    id: z.string(),
    customerName: z.string(),
    totalAmount: z.number(),
    status: z.string(),
    createdAt: timestampSchema,
}).passthrough();

const dailyActivitySchema = z.object({
    date: z.string(),
    orders: z.number(),
    revenue: z.number(),
    newCustomers: z.number(),
});

const dashboardResponseSchema = successEnvelope(z.object({
    stats: dashboardStatsSchema,
    recentOrders: z.array(recentOrderSchema),
    dailyActivityData: z.array(dailyActivitySchema),
}));

const dashboardSummaryResponseSchema = successEnvelope(z.object({
    stats: dashboardStatsSchema,
    recentOrders: z.array(recentOrderSchema),
}));

const dashboardHomeSummaryResponseSchema = successEnvelope(z.object({
    stats: dashboardStatsSchema.omit({ totalRevenue: true }),
    recentOrders: z.array(recentOrderSchema),
}));

const dashboardActivityResponseSchema = successEnvelope(z.object({
    dailyActivityData: z.array(dailyActivitySchema),
}));

// ── Dashboard Summary ──

const dashboardHomeSummaryRoute = createRoute({
    method: "get",
    path: "/home-summary",
    tags: ["Admin - Dashboard"],
    summary: "Get lightweight dashboard home metrics and recent orders",
    responses: {
        200: {
            description: "Dashboard home summary data",
            content: { "application/json": { schema: dashboardHomeSummaryResponseSchema } },
        },
    },
});

app.openapi(dashboardHomeSummaryRoute, async (c) => {
    const db = c.get("db");

    const [stats, recentOrders] = await Promise.all([
        getDashboardSummaryStats(db),
        getRecentOrders(db, 11),
    ]);

    return ok(c, { stats, recentOrders });
});

const dashboardSummaryRoute = createRoute({
    method: "get",
    path: "/summary",
    tags: ["Admin - Dashboard"],
    summary: "Get dashboard summary metrics and recent orders",
    responses: {
        200: {
            description: "Dashboard summary data",
            content: { "application/json": { schema: dashboardSummaryResponseSchema } },
        },
    },
});

app.openapi(dashboardSummaryRoute, async (c) => {
    const db = c.get("db");

    const [stats, recentOrders] = await Promise.all([
        getDashboardStats(db),
        getRecentOrders(db, 11),
    ]);

    return ok(c, { stats, recentOrders });
});

// ── Dashboard Activity ──

const dashboardActivityRoute = createRoute({
    method: "get",
    path: "/activity",
    tags: ["Admin - Dashboard"],
    summary: "Get dashboard daily activity chart data",
    responses: {
        200: {
            description: "Dashboard daily activity data",
            content: { "application/json": { schema: dashboardActivityResponseSchema } },
        },
    },
});

app.openapi(dashboardActivityRoute, async (c) => {
    const db = c.get("db");

    const dailyActivityData = await getDailyActivityData(db, 90);

    return ok(c, { dailyActivityData });
});

// ── Legacy Combined Dashboard ──

const dashboardRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Dashboard"],
    summary: "Get dashboard summary, recent orders, and daily activity",
    responses: {
        200: {
            description: "Dashboard data",
            content: { "application/json": { schema: dashboardResponseSchema } },
        },
    }
});

app.openapi(dashboardRoute, async (c) => {
    const db = c.get("db");

    const [stats, recentOrders, dailyActivityData] = await Promise.all([
        getDashboardStats(db),
        getRecentOrders(db, 11),
        getDailyActivityData(db, 90),
    ]);

    return ok(c, { stats, recentOrders, dailyActivityData });
});

export { app as adminDashboardRoutes };
