// src/server/routes/admin/dashboard.ts
// Admin OpenAPI route for the dashboard summary (stats, recent orders, activity).

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { getDashboardStats, getRecentOrders, getDailyActivityData } from "@scalius/core/modules/analytics";

import { ok } from "../../utils/api-response";

const app = new OpenAPIHono();

// ── Dashboard Summary ──

const dashboardRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Dashboard"],
    summary: "Get dashboard summary (stats, recent orders, daily activity)",
    responses: {
        200: { description: "Dashboard data" }
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
