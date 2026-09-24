import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { createSqliteD1Database, type SqliteTestDatabase } from "@scalius/database/testing/sqlite-d1";

import { adminDashboardRoutes } from "./dashboard";

const NOW = new Date("2026-08-14T05:30:00.000Z");
const HOME = [PERMISSIONS.DASHBOARD_VIEW];
const HOME_AND_ORDERS = [PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.ORDERS_VIEW];
const EVERYTHING = [...HOME_AND_ORDERS, PERMISSIONS.DASHBOARD_ANALYTICS];

let database: SqliteTestDatabase;

function insertOrder(id: string, customerName: string, totalMinor: number, createdAt: Date) {
    database.sqlite.prepare(`
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone,
        shipping_amount_minor, total_amount_minor, status, created_at)
      VALUES (?, ?, '+8801711111111', 'Dhaka', 'dhaka', 'zone_1', 0, ?, 'processing', ?)
    `).run(id, customerName, totalMinor, Math.floor(createdAt.getTime() / 1000));
}

/** The dashboard routes behind the permission set the admin middleware resolved. */
function app(permissions: readonly string[]) {
    const api = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
    api.use("*", async (c, next) => {
        c.set("db", database.db);
        c.set("adminPermissions", new Set(permissions));
        await next();
    });
    api.route("/admin/dashboard", adminDashboardRoutes);
    return api;
}

async function get(permissions: readonly string[], path: string) {
    const response = await app(permissions).request(`/api/v1/admin/dashboard${path}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- asserted field by field below
    return { status: response.status, text: await response.clone().text(), body: await response.json() as any };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    database = createSqliteD1Database();
    insertOrder("ord_today", "Ada Lovelace", 1_689_000, NOW);
    insertOrder("ord_earlier", "Grace Hopper", 1_003_000, new Date("2026-08-02T06:00:00.000Z"));
    insertOrder("ord_last_month", "Katherine Johnson", 500_000, new Date("2026-07-10T06:00:00.000Z"));
});

afterEach(() => {
    database.sqlite.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("Home sales numbers follow the View sales numbers permission", () => {
    it("gives a role without it order counts but no money at all", async () => {
        const summary = await get(HOME_AND_ORDERS, "/home-summary");
        expect(summary.status).toBe(200);
        expect(summary.body.data.stats.currentMonth).toMatchObject({
            orders: 2,
            revenue: null,
            revenueGrowth: null,
            orderGrowth: 100,
        });
        expect(summary.body.data.stats.lastMonth).toEqual({ orders: 1, revenue: null });
        expect(summary.text).not.toContain("26920");

        const activity = await get(HOME_AND_ORDERS, "/activity?days=30");
        const today = activity.body.data.dailyActivityData.at(-1);
        expect(today).toMatchObject({ date: "2026-08-14", orders: 1, revenue: null });
        expect(activity.body.data.dailyActivityData.every(
            (day: { revenue: number | null }) => day.revenue === null,
        )).toBe(true);
        expect(activity.text).not.toContain("16890");
    });

    it("gives a role with it the sales totals and chart", async () => {
        const summary = await get(EVERYTHING, "/home-summary");
        expect(summary.body.data.stats.currentMonth).toMatchObject({ orders: 2, revenue: 26_920 });
        expect(summary.body.data.stats.currentMonth.revenueGrowth).toBeCloseTo(438.4, 8);
        expect(summary.body.data.stats.lastMonth).toEqual({ orders: 1, revenue: 5_000 });

        const activity = await get(EVERYTHING, "/activity?days=1");
        expect(activity.body.data.dailyActivityData).toEqual([
            { date: "2026-08-14", orders: 1, revenue: 16_890, newCustomers: 0 },
        ]);
    });

    it("never sends the order feed (names and totals) to a role that can't view orders", async () => {
        const homeOnly = await get(HOME, "/home-summary");
        expect(homeOnly.body.data.recentOrders).toEqual([]);
        expect(homeOnly.text).not.toContain("Ada Lovelace");

        const withOrders = await get(HOME_AND_ORDERS, "/home-summary");
        expect(withOrders.body.data.recentOrders.map((order: { id: string }) => order.id))
            .toEqual(["ord_today", "ord_earlier", "ord_last_month"]);
        expect(withOrders.body.data.recentOrders[0]).toEqual({
            id: "ord_today",
            orderNumber: null,
            customerName: "Ada Lovelace",
            totalAmount: 16_890,
            status: "processing",
            createdAt: expect.anything(),
        });
    });

    it("bounds the recent-order feed", async () => {
        for (let index = 0; index < 20; index += 1) {
            insertOrder(`ord_bulk_${index}`, `Customer ${"n".repeat(1_000)}`, 100, NOW);
        }
        const { body } = await get(HOME_AND_ORDERS, "/home-summary");
        expect(body.data.recentOrders).toHaveLength(11);
        expect(body.data.recentOrders[0].customerName).toHaveLength(256);
    });

    it.each(["0", "91", "1.5", "not-a-number"])(
        "rejects an invalid activity day window (%s)",
        async (days) => {
            const { status } = await get(EVERYTHING, `/activity?days=${days}`);
            expect(status).toBe(400);
        },
    );
});
