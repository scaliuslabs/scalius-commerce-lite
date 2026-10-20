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

/** A same-currency order: revenue sums its shop total, which equals its total. */
function insertOrder(id: string, customerName: string, totalMinor: number, createdAt: Date) {
    database.sqlite.prepare(`
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone,
        shipping_amount_minor, total_amount_minor, total_shop_minor, status, created_at)
      VALUES (?, ?, '+8801711111111', 'Dhaka', 'dhaka', 'zone_1', 0, ?, ?, 'processing', ?)
    `).run(id, customerName, totalMinor, totalMinor, Math.floor(createdAt.getTime() / 1000));
}

/** The dashboard routes behind the permission set the admin middleware resolved. */
function app(permissions: readonly string[], userId = "user_1") {
    const api = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
    api.use("*", async (c, next) => {
        c.set("db", database.db);
        c.set("user", { id: userId } as never);
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
            // Keep the long-name orders ahead of the seed rows regardless
            // of which index SQLite chooses for equal timestamps.
            insertOrder(`ord_bulk_${index}`, `Customer ${"n".repeat(1_000)}`, 100, new Date(NOW.getTime() + (index + 1) * 1_000));
        }
        const { body } = await get(HOME_AND_ORDERS, "/home-summary");
        expect(body.data.recentOrders).toHaveLength(11);
        expect(body.data.recentOrders.map((order: { id: string }) => order.id))
            .toEqual(Array.from({ length: 11 }, (_, index) => `ord_bulk_${19 - index}`));
        for (const order of body.data.recentOrders) expect(order.customerName).toHaveLength(256);
    });

    it.each(["0", "91", "1.5", "not-a-number"])(
        "rejects an invalid activity day window (%s)",
        async (days) => {
            const { status } = await get(EVERYTHING, `/activity?days=${days}`);
            expect(status).toBe(400);
        },
    );
});

describe("Home setup guide", () => {
    const guide = async (userId = "user_1") =>
        (await (await app(HOME, userId).request("/api/v1/admin/dashboard/setup-guide", {}, {})).json()) as { data: Record<string, unknown> };

    it("reads each step from the store and starts undismissed", async () => {
        const { data } = await guide();
        expect(data).toMatchObject({
            dismissed: false,
            countryCode: "BD",
            setupNeeded: false,
            steps: { product: false, details: false, theme: false, payments: true, shipping: false, domain: false, order: true },
            bangladeshPack: { active: false },
            drafts: { count: 0, newestId: null },
            testOrderUrl: null,
        });
    });

    it("counts drafts apart from live products and links a test order to the storefront", async () => {
        database.sqlite.exec("INSERT INTO products (id, name, slug, is_active) VALUES ('p_draft', 'Panjabi', 'panjabi', 0)");
        expect((await guide()).data).toMatchObject({ steps: { product: false }, drafts: { count: 1, newestId: "p_draft" }, testOrderUrl: null });
        database.sqlite.exec("UPDATE products SET is_active = 1");
        expect((await guide()).data).toMatchObject({ steps: { product: true }, drafts: { count: 0, newestId: null }, testOrderUrl: null });
        // With a web address, the step's link puts the product in the storefront's cart.
        database.sqlite.prepare("INSERT INTO settings (id, key, value, type, category) VALUES ('s_platform', 'document', ?, 'json', 'platform')")
            .run(JSON.stringify({ storefrontUrl: "https://shop.example.com" }));
        expect((await guide()).data.testOrderUrl).toBe("https://shop.example.com/buy/panjabi");
    });

    it("counts the digital products and gift cards a cash-only checkout can't take", async () => {
        // Checkout itself works (a delivery rate and a place to deliver to); it offers cash on delivery only.
        database.sqlite.exec(`
          INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active)
          VALUES ('city_1', 'Rajshahi', 'BD', 1, NULL, '{}', '{}', 1), ('zone_1', 'Bagmara', 'BD', 2, 'city_1', '{}', '{}', 1);
          INSERT INTO delivery_zones (id, name) VALUES ('dz_bd', 'Bangladesh'); INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('BD', 'dz_bd');
          INSERT INTO shipping_methods (id, name, fee_minor, kind, zone_id) VALUES ('m_std', 'Standard', 6000, 'delivery', 'dz_bd');
        `);
        expect((await guide()).data.onlinePayment).toEqual({ ready: false, blockedProducts: 0 });
        database.sqlite.exec(`
          INSERT INTO products (id, name, slug, is_gift_card) VALUES ('p_key', 'Licence key', 'licence-key', 0), ('p_card', 'Gift card', 'gift-card', 1);
          INSERT INTO product_variants (id, product_id, sku, price_minor, is_default, fulfillment_kind) VALUES
            ('v_key', 'p_key', 'KEY-1', 50000, 1, 'digital'), ('v_card', 'p_card', 'CARD-1', 100000, 1, 'physical');
        `);
        expect((await guide()).data.onlinePayment).toEqual({ ready: false, blockedProducts: 2 });
        // A checkout that is unavailable for another reason says nothing about online payment.
        database.sqlite.exec("UPDATE shipping_methods SET is_active = 0");
        expect((await guide()).data.onlinePayment).toEqual({ ready: null, blockedProducts: 0 });
    });

    it("gives a store that sells everywhere no country's own steps", async () => {
        // The primary market names no country: the setup form's Bangladesh starting point is not the store's country.
        database.sqlite.prepare("DELETE FROM market_countries WHERE market_id = 'mkt_backup'").run();
        const { data } = await guide();
        expect(data).toMatchObject({ countryCode: "ZZ", bangladeshPack: null });
    });

    it("dismisses for the signed-in staff member only", async () => {
        const response = await app(HOME).request("/api/v1/admin/dashboard/setup-guide/dismiss", { method: "POST" }, {});
        expect(response.status).toBe(200);
        expect((await guide()).data.dismissed).toBe(true);
        expect((await guide("user_2")).data.dismissed).toBe(false);
        // Undo, or Home's "Show setup guide".
        const shown = await app(HOME).request("/api/v1/admin/dashboard/setup-guide/show", { method: "POST" }, {});
        expect(shown.status).toBe(200);
        expect((await guide()).data.dismissed).toBe(false);
    });
});
