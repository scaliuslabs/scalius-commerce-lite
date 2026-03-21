// src/server/routes/admin/dashboard.ts
// Admin OpenAPI route for the dashboard summary (stats, recent orders, activity).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getDashboardStats, getRecentOrders, getDailyActivityData } from "@scalius/core/modules/analytics";

import { ok } from "../../utils/api-response";
import { successEnvelope } from "../../schemas/responses";

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
    createdAt: z.string().or(z.date()),
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

// ── Dashboard Summary ──

const dashboardRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Dashboard"],
    summary: "Get dashboard summary (stats, recent orders, daily activity)",
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
