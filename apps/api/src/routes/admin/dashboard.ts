// src/server/routes/admin/dashboard.ts
// Admin OpenAPI routes for dashboard summary and activity data.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    getDashboardStats,
    getDashboardHomeSummary,
    getDashboardSummaryStats,
    getRecentOrders,
    getDailyActivityData,
} from "@scalius/core/modules/analytics";

import { ok } from "../../utils/api-response";
import { successEnvelope } from "../../schemas/responses";
import { timestampSchema } from "../../schemas/timestamps";

const app = new OpenAPIHono<{ Bindings: Env }>();
const DASHBOARD_RECENT_ORDER_LIMIT = 11;
const DASHBOARD_ORDER_ID_MAX_LENGTH = 128;
const DASHBOARD_CUSTOMER_NAME_MAX_LENGTH = 256;
const DASHBOARD_ORDER_STATUS_MAX_LENGTH = 64;

function boundedText(value: unknown, maximumLength: number): string {
    return typeof value === "string" ? value.slice(0, maximumLength) : "";
}

function projectRecentOrders(
    recentOrders: Awaited<ReturnType<typeof getRecentOrders>>,
) {
    return recentOrders.slice(0, DASHBOARD_RECENT_ORDER_LIMIT).map((order) => ({
        id: boundedText(order.id, DASHBOARD_ORDER_ID_MAX_LENGTH),
        customerName: boundedText(
            order.customerName,
            DASHBOARD_CUSTOMER_NAME_MAX_LENGTH,
        ),
        totalAmount: order.totalAmount,
        status: boundedText(order.status, DASHBOARD_ORDER_STATUS_MAX_LENGTH),
        createdAt: order.createdAt,
    }));
}

function projectDailyActivity(
    activity: Awaited<ReturnType<typeof getDailyActivityData>>,
) {
    return activity.slice(0, 90).map((entry) => ({
        date: boundedText(entry.date, 10),
        orders: entry.orders,
        revenue: entry.revenue,
        newCustomers: entry.newCustomers,
    }));
}

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
    id: z.string().max(DASHBOARD_ORDER_ID_MAX_LENGTH),
    customerName: z.string().max(DASHBOARD_CUSTOMER_NAME_MAX_LENGTH),
    totalAmount: z.number(),
    status: z.string().max(DASHBOARD_ORDER_STATUS_MAX_LENGTH),
    createdAt: timestampSchema,
});

const dailyActivitySchema = z.object({
    date: z.string().max(10),
    orders: z.number(),
    revenue: z.number(),
    newCustomers: z.number(),
});

const dashboardResponseSchema = successEnvelope(z.object({
    stats: dashboardStatsSchema,
    recentOrders: z.array(recentOrderSchema).max(DASHBOARD_RECENT_ORDER_LIMIT),
    dailyActivityData: z.array(dailyActivitySchema).max(90),
}));

const dashboardSummaryResponseSchema = successEnvelope(z.object({
    stats: dashboardStatsSchema,
    recentOrders: z.array(recentOrderSchema).max(DASHBOARD_RECENT_ORDER_LIMIT),
}));

const dashboardHomeSummaryResponseSchema = successEnvelope(z.object({
    stats: dashboardStatsSchema.omit({ totalRevenue: true }),
    recentOrders: z.array(recentOrderSchema).max(DASHBOARD_RECENT_ORDER_LIMIT),
}));

const dashboardMetricsSummaryResponseSchema = successEnvelope(z.object({
    stats: dashboardStatsSchema.omit({ totalRevenue: true }),
}));

const dashboardActivityResponseSchema = successEnvelope(z.object({
    dailyActivityData: z.array(dailyActivitySchema).max(90),
}));

// ── Dashboard Summary ──

const dashboardHomeSummaryRoute = createRoute({
    method: "get",
    path: "/home-summary",
    tags: ["Admin - Dashboard"],
    summary: "Get lightweight dashboard home metrics and recent orders",
    operationId: "dashboard.home.summary",
    responses: {
        200: {
            description: "Dashboard home summary data",
            content: { "application/json": { schema: dashboardHomeSummaryResponseSchema } },
        },
    },
});

app.openapi(dashboardHomeSummaryRoute, async (c) => {
    const db = c.get("db");
    const summary = await getDashboardHomeSummary(
        db,
        DASHBOARD_RECENT_ORDER_LIMIT,
    );
    return ok(c, {
        stats: summary.stats,
        recentOrders: projectRecentOrders(summary.recentOrders),
    });
});

const dashboardMetricsSummaryRoute = createRoute({
    method: "get",
    path: "/metrics-summary",
    tags: ["Admin - Dashboard"],
    summary: "Get lightweight dashboard metrics summary",
    operationId: "dashboard.home.metrics",
    responses: {
        200: {
            description: "Dashboard metrics summary data",
            content: { "application/json": { schema: dashboardMetricsSummaryResponseSchema } },
        },
    },
});

app.openapi(dashboardMetricsSummaryRoute, async (c) => {
    const db = c.get("db");

    const stats = await getDashboardSummaryStats(db);

    return ok(c, { stats });
});

const dashboardSummaryRoute = createRoute({
    method: "get",
    path: "/summary",
    tags: ["Admin - Dashboard"],
    summary: "Get dashboard summary metrics and recent orders",
    operationId: "dashboard.home.full_summary",
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
        getRecentOrders(db, DASHBOARD_RECENT_ORDER_LIMIT),
    ]);

    return ok(c, { stats, recentOrders: projectRecentOrders(recentOrders) });
});

// ── Dashboard Activity ──

const dashboardActivityRoute = createRoute({
    method: "get",
    path: "/activity",
    tags: ["Admin - Dashboard"],
    summary: "Get dashboard daily activity chart data",
    operationId: "dashboard.home.activity",
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

    return ok(c, { dailyActivityData: projectDailyActivity(dailyActivityData) });
});

// ── Legacy Combined Dashboard ──

const dashboardRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Dashboard"],
    summary: "Get dashboard summary, recent orders, and daily activity",
    operationId: "dashboard.home.legacy_combined",
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
        getRecentOrders(db, DASHBOARD_RECENT_ORDER_LIMIT),
        getDailyActivityData(db, 90),
    ]);

    return ok(c, {
        stats,
        recentOrders: projectRecentOrders(recentOrders),
        dailyActivityData: projectDailyActivity(dailyActivityData),
    });
});

export { app as adminDashboardRoutes };
