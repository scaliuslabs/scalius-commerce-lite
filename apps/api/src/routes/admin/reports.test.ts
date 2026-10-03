import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { getRoutePermission } from "@scalius/core/auth/rbac/route-permissions";
import { getPagePermission } from "@scalius/core/auth/rbac/page-permissions";
import { createSqliteD1Database, type SqliteTestDatabase } from "@scalius/database/testing/sqlite-d1";

import { adminReportRoutes } from "./reports";
import { errorResponseFromError } from "../../utils/api-response";

const ANALYTICS = [PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.DASHBOARD_ANALYTICS];
const ANALYTICS_AND_CUSTOMERS = [...ANALYTICS, PERMISSIONS.CUSTOMERS_VIEW];
const ANALYTICS_AND_COSTS = [...ANALYTICS, PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.PRODUCTS_VIEW_COSTS];

let database: SqliteTestDatabase;

function epoch(value: string) {
  return Math.floor(Date.parse(value) / 1000);
}

function insertOrder(id: string, totalMinor: number, createdAt: string, status = "delivered", customerPhone = "+8801711111111") {
  database.sqlite.prepare(`
    INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, city_name,
      subtotal_amount_minor, shipping_amount_minor, total_amount_minor, status, created_at, updated_at)
    VALUES (?, 'Rahim', ?, 'Road 1', 'city_1', 'zone_1', 'Dhaka', ?, 0, ?, ?, ?, ?)
  `).run(id, customerPhone, totalMinor, totalMinor, status, epoch(createdAt), epoch(createdAt));
  database.sqlite.prepare(`
    INSERT INTO order_items (id, order_id, product_id, quantity, product_name, unit_price_minor, line_subtotal_minor, fulfillment_type)
    VALUES (?, ?, 'prod_1', 1, 'Panjabi', ?, ?, 'ship')
  `).run(`${id}_line`, id, totalMinor, totalMinor);
}

function app(permissions: readonly string[]) {
  const api = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  api.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  api.use("*", async (c, next) => {
    c.set("db", database.db);
    c.set("adminPermissions", new Set(permissions));
    await next();
  });
  api.route("/admin/reports", adminReportRoutes);
  return api;
}

async function get(permissions: readonly string[], path: string) {
  const response = await app(permissions).request(`/api/v1/admin/reports${path}`);
  const text = await response.clone().text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- asserted field by field below
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, headers: response.headers, text, body };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  database = createSqliteD1Database();
  database.sqlite.prepare(`INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('prod_1', 'Panjabi', 'panjabi', 0, 1)`).run();
  insertOrder("ord_1", 150_000, "2026-08-05T10:00:00+06:00");
  insertOrder("ord_2", 50_000, "2026-08-06T10:00:00+06:00", "pending", "+8801722222222");
  insertOrder("ord_3", 99_000, "2026-08-07T10:00:00+06:00", "cancelled");
  insertOrder("ord_july", 70_000, "2026-07-20T10:00:00+06:00");
});

afterEach(() => {
  database.sqlite.close();
  vi.restoreAllMocks();
});

describe("analytics routes", () => {
  it("are behind View analytics, and the pages too", () => {
    expect(getRoutePermission("/api/v1/admin/reports", "GET")).toMatchObject({ permission: PERMISSIONS.DASHBOARD_ANALYTICS });
    expect(getRoutePermission("/api/v1/admin/reports/overview", "GET")).toMatchObject({ permission: PERMISSIONS.DASHBOARD_ANALYTICS });
    expect(getRoutePermission("/api/v1/admin/reports/customers_top/export", "GET")).toMatchObject({ permission: PERMISSIONS.DASHBOARD_ANALYTICS });
    expect(getPagePermission("/admin/analytics")).toMatchObject({ permission: PERMISSIONS.DASHBOARD_ANALYTICS });
    expect(getPagePermission("/admin/analytics/reports/sales_by_product")).toMatchObject({ permission: PERMISSIONS.DASHBOARD_ANALYTICS });
  });

  it("returns the overview in decimal store currency with the comparison period", async () => {
    const result = await get(ANALYTICS, "/overview?from=2026-08-01&to=2026-08-31&granularity=week");
    expect(result.status).toBe(200);
    const data = result.body.data;
    expect(data.currency).toEqual({ code: "BDT", decimalPlaces: 2 });
    expect(data.current.totals).toMatchObject({ orders: 2, grossSales: 2_000, netSales: 2_000, totalSales: 2_000, averageOrderValue: 1_000 });
    expect(data.current.cancellations).toMatchObject({ placed: 3, cancelled: 1 });
    expect(data.previous.range).toEqual({ from: "2026-07-01", to: "2026-07-31" });
    expect(data.previous.totals.totalSales).toBe(700);
    expect(data.series[0]).toMatchObject({ key: "2026-07-26", previousKey: "2026-06-28" });
    expect(data.breakdowns.city).toEqual([expect.objectContaining({ key: "Dhaka", totalSales: 2_000 })]);
  });

  it("rejects an impossible range", async () => {
    expect((await get(ANALYTICS, "/overview?from=2026-08-31&to=2026-08-01")).status).toBe(400);
    expect((await get(ANALYTICS, "/overview?from=2023-01-01&to=2026-08-01")).status).toBe(400);
    expect((await get(ANALYTICS, "/sales_by_product?from=2026-02-30&to=2026-03-01")).status).toBe(400);
  });

  it("lists reports with what this caller can run", async () => {
    const result = await get(ANALYTICS, "");
    const reports = result.body.data.reports as Array<{ id: string; available: boolean; unavailableReason: string | null }>;
    expect(reports.find((report) => report.id === "customers_top")).toMatchObject({ available: false, unavailableReason: "customer_access" });
    expect(reports.find((report) => report.id === "profit_by_product")).toMatchObject({ available: false, unavailableReason: "cost_access" });
    expect(reports.find((report) => report.id === "sales_by_product")).toMatchObject({ available: true });
    const withCustomers = await get(ANALYTICS_AND_CUSTOMERS, "");
    expect(withCustomers.body.data.reports.find((report: { id: string }) => report.id === "customers_top").available).toBe(true);
    const withCosts = await get(ANALYTICS_AND_COSTS, "");
    expect(withCosts.body.data.reports.find((report: { id: string }) => report.id === "profit_by_product"))
      .toMatchObject({ available: true, unavailableReason: null, requiresCostAccess: true });
  });

  it("returns a sorted report page with totals and product links", async () => {
    const result = await get(ANALYTICS, "/sales_by_product?from=2026-08-01&to=2026-08-31&pageSize=10");
    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({
      sort: { key: "net_sales", direction: "desc" },
      page: 1,
      totalRows: 1,
      totalPages: 1,
      rows: [{ id: "prod_1", productId: "prod_1", values: { product: "Panjabi", net_sales: 2_000, net_items_sold: 2 } }],
      totals: { net_sales: 2_000, orders: null },
    });
  });

  it("names customers only for staff who may view customers", async () => {
    const denied = await get(ANALYTICS, "/customers_top?from=2026-08-01&to=2026-08-31");
    expect(denied.status).toBe(403);
    expect(denied.text).not.toContain("+8801711111111");
    const exportDenied = await get(ANALYTICS, "/customers_top/export?from=2026-08-01&to=2026-08-31");
    expect(exportDenied.status).toBe(403);
    const allowed = await get(ANALYTICS_AND_CUSTOMERS, "/customers_top?from=2026-08-01&to=2026-08-31");
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.rows[0].values).toMatchObject({ customer: "Rahim", phone: "+8801711111111", total_sales: 1_500 });
  });

  it("runs the profit report from sale-time unit costs only with View product costs", async () => {
    const denied = await get(ANALYTICS, "/profit_by_product?from=2026-08-01&to=2026-08-31");
    expect(denied.status).toBe(403);
    expect((await get(ANALYTICS, "/profit_by_product/export?from=2026-08-01&to=2026-08-31")).status).toBe(403);
    const result = await get(ANALYTICS_AND_COSTS, "/profit_by_product?from=2026-08-01&to=2026-08-31");
    expect(result.status).toBe(200);
  });

  it("exports a private CSV artifact", async () => {
    const result = await get(ANALYTICS, "/sales_by_city/export?from=2026-08-01&to=2026-08-31");
    expect(result.status).toBe(200);
    expect(result.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(result.headers.get("Content-Disposition")).toBe('attachment; filename="sales-by-city-2026-08-01_2026-08-31.csv"');
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
    expect(result.headers.get("X-Export-Limited")).toBe("false");
    expect(result.headers.get("X-Export-Row-Count")).toBe("2");
    expect(result.text).toContain("\"Dhaka\",\"2\",\"2000.00\"");
  });
});
