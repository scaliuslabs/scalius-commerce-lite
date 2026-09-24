// src/server/routes/admin/dashboard.ts
// Admin OpenAPI routes for the Home summary and daily activity.
//
// Home is open to `dashboard.view`, but money is not: every revenue value is
// null unless the caller also holds `dashboard.analytics` ("View sales
// numbers"), and the recent-order feed (customer names and order totals) is
// empty unless they hold `orders.view`. The projection happens here, at the
// boundary, so no client can read what the role excludes.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
    getDashboardHomeSummary,
    getDailyActivityData,
} from "@scalius/core/modules/analytics";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";

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

/** What this caller may see on Home beyond counts. */
function homeAccess(c: Context) {
    const permissions: ReadonlySet<string> = c.get("adminPermissions") ?? new Set();
    return {
        sales: permissions.has(PERMISSIONS.DASHBOARD_ANALYTICS),
        orders: permissions.has(PERMISSIONS.ORDERS_VIEW),
    };
}

/** Revenue only for callers who may see sales numbers. */
const money = (value: number, sales: boolean) => (sales ? value : null);

// ─── Response schemas ──

const dashboardStatsSchema = z.object({
    totalProducts: z.number(),
    totalCustomers: z.number(),
    currentMonth: z.object({
        orders: z.number(),
        /** Null without the "View sales numbers" permission. */
        revenue: z.number().nullable(),
        orderGrowth: z.number().nullable(),
        revenueGrowth: z.number().nullable(),
        orderStatus: z.object({
            delivered: z.number(),
            processing: z.number(),
            shipping: z.number(),
            cancelled: z.number(),
        }),
    }),
    lastMonth: z.object({
        orders: z.number(),
        revenue: z.number().nullable(),
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
    /** Null without the "View sales numbers" permission. */
    revenue: z.number().nullable(),
    newCustomers: z.number(),
});

const dashboardHomeSummaryResponseSchema = successEnvelope(z.object({
    stats: dashboardStatsSchema,
    recentOrders: z.array(recentOrderSchema).max(DASHBOARD_RECENT_ORDER_LIMIT),
}));

const dashboardActivityResponseSchema = successEnvelope(z.object({
    dailyActivityData: z.array(dailyActivitySchema).max(90),
}));

// ── Home summary ──

const dashboardHomeSummaryRoute = createRoute({
    method: "get",
    path: "/home-summary",
    tags: ["Admin - Dashboard"],
    summary: "Get dashboard home metrics and recent orders",
    description: "Answer current-month order-count, customer and recent-order questions. Revenue values are null unless the caller may view sales numbers; recent orders are empty unless the caller may view orders.",
    operationId: "dashboard.home.summary",
    responses: {
        200: {
            description: "Dashboard home summary data",
            content: { "application/json": { schema: dashboardHomeSummaryResponseSchema } },
        },
    },
});

app.openapi(dashboardHomeSummaryRoute, async (c) => {
    const access = homeAccess(c);
    const { stats, recentOrders } = await getDashboardHomeSummary(
        c.get("db"),
        access.orders ? DASHBOARD_RECENT_ORDER_LIMIT : 0,
    );
    return ok(c, {
        stats: {
            ...stats,
            currentMonth: {
                ...stats.currentMonth,
                revenue: money(stats.currentMonth.revenue, access.sales),
                revenueGrowth: access.sales ? stats.currentMonth.revenueGrowth : null,
            },
            lastMonth: {
                ...stats.lastMonth,
                revenue: money(stats.lastMonth.revenue, access.sales),
            },
        },
        recentOrders: recentOrders.slice(0, DASHBOARD_RECENT_ORDER_LIMIT).map((order) => ({
            id: boundedText(order.id, DASHBOARD_ORDER_ID_MAX_LENGTH),
            customerName: boundedText(order.customerName, DASHBOARD_CUSTOMER_NAME_MAX_LENGTH),
            totalAmount: order.totalAmount,
            status: boundedText(order.status, DASHBOARD_ORDER_STATUS_MAX_LENGTH),
            createdAt: order.createdAt,
        })),
    });
});

// ── Daily activity ──

const dashboardActivityRoute = createRoute({
    method: "get",
    path: "/activity",
    tags: ["Admin - Dashboard"],
    summary: "Get dashboard daily activity chart data",
    description: "Answer daily or today's sales, revenue, order-count, and new-customer questions. Request days=1 for a minimal current-day result; the dashboard defaults to 90 days. Revenue is null unless the caller may view sales numbers.",
    operationId: "dashboard.home.activity",
    request: {
        query: z.object({
            days: z.coerce.number().int().min(1).max(90).optional().default(90)
                .openapi({ description: "Merchant-calendar days ending today; use 1 for today's summary" }),
        }),
    },
    responses: {
        200: {
            description: "Dashboard daily activity data",
            content: { "application/json": { schema: dashboardActivityResponseSchema } },
        },
    },
});

app.openapi(dashboardActivityRoute, async (c) => {
    const { days } = c.req.valid("query");
    const { sales } = homeAccess(c);
    const activity = await getDailyActivityData(c.get("db"), days);

    return ok(c, {
        dailyActivityData: activity.slice(0, 90).map((entry) => ({
            date: boundedText(entry.date, 10),
            orders: entry.orders,
            revenue: money(entry.revenue, sales),
            newCustomers: entry.newCustomers,
        })),
    });
});

export { app as adminDashboardRoutes };
