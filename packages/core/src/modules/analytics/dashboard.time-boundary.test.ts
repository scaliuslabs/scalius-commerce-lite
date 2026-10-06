import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDailyActivityData, getDashboardHomeSummary } from "./dashboard.service";

const summaryStats = async (db: Database) => (await getDashboardHomeSummary(db, 0, "Asia/Dhaka")).stats;

function epoch(value: string): number {
  return Date.parse(value) / 1000;
}

describe("dashboard merchant calendar boundaries", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    vi.setSystemTime(new Date("2026-08-14T05:30:00.000Z"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    ({ sqlite, db } = createSqliteD1Database());
  });

  afterEach(() => {
    sqlite.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function insertOrder(
    id: string,
    total: number,
    status: string,
    createdAt: string,
    deletedAt: number | null = null,
  ) {
    sqlite.prepare(`
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone,
        shipping_amount_minor, total_amount_minor, total_shop_minor, status, created_at, deleted_at)
      VALUES (?, 'Buyer', '+8801711111111', 'Dhaka', 'dhaka', 'zone_1', 0, ?, ?, ?, ?, ?)
    `).run(id, Math.round(total * 100), Math.round(total * 100), status, epoch(createdAt), deletedAt);
  }

  it("compares equal month populations and values with the same order inclusion", async () => {
    insertOrder("current_pending", 100, "pending", "2026-08-05T00:00:00.000Z");
    insertOrder("current_cancelled", 50, "cancelled", "2026-08-06T00:00:00.000Z");
    insertOrder("current_returned", 25, "returned", "2026-08-07T00:00:00.000Z");
    insertOrder("previous_pending", 100, "pending", "2026-07-05T00:00:00.000Z");
    insertOrder("previous_cancelled", 50, "cancelled", "2026-07-06T00:00:00.000Z");
    insertOrder("previous_returned", 25, "returned", "2026-07-07T00:00:00.000Z");
    insertOrder("current_deleted", 999, "pending", "2026-08-08T00:00:00.000Z", 1);
    insertOrder("previous_deleted", 999, "pending", "2026-07-08T00:00:00.000Z", 1);

    const result = await summaryStats(db);

    expect(result.currentMonth).toMatchObject({
      orders: 3,
      revenue: 100,
      orderGrowth: 0,
      revenueGrowth: 0,
    });
    expect(result.lastMonth).toEqual({ orders: 3, revenue: 100 });
  });

  it.each([
    [2, 1, 100, 50, 100, 100],
    [1, 2, 50, 100, -50, -50],
  ])("reports signed growth for %s/%s orders and %s/%s value", async (currentOrders, previousOrders, currentValue, previousValue, orderGrowth, revenueGrowth) => {
    for (let index = 0; index < previousOrders; index += 1) {
      insertOrder(`previous_${index}`, previousValue / previousOrders, "pending", `2026-07-${String(index + 5).padStart(2, "0")}T00:00:00.000Z`);
    }
    for (let index = 0; index < currentOrders; index += 1) {
      insertOrder(`current_${index}`, currentValue / currentOrders, "pending", `2026-08-${String(index + 5).padStart(2, "0")}T00:00:00.000Z`);
    }

    const result = await summaryStats(db);

    expect(result.currentMonth).toMatchObject({ orderGrowth, revenueGrowth });
  });

  it.each([
    [100.01, 100, 0.01],
    [99.99, 100, -0.01],
    [1000000.01, 1000000, 0.000001],
    [999999.99, 1000000, -0.000001],
  ])("preserves tiny signed growth for %s/%s values", async (currentValue, previousValue, expectedGrowth) => {
    insertOrder("previous_tiny", previousValue, "pending", "2026-07-05T00:00:00.000Z");
    insertOrder("current_tiny", currentValue, "pending", "2026-08-05T00:00:00.000Z");

    const result = await summaryStats(db);

    expect(result.currentMonth.revenueGrowth).toBeCloseTo(expectedGrowth, 8);
  });

  it("returns unavailable growth when the previous month has no baseline", async () => {
    insertOrder("current_only", 100, "pending", "2026-08-05T00:00:00.000Z");

    const result = await summaryStats(db);

    expect(result.currentMonth).toMatchObject({
      orders: 1,
      revenue: 100,
      orderGrowth: null,
      revenueGrowth: null,
    });
  });

  it("groups both sides of UTC midnight by the Bangladesh merchant day", async () => {
    insertOrder("before_boundary", 100, "processing", "2026-08-13T17:59:59.000Z");
    insertOrder("after_boundary", 200, "processing", "2026-08-13T18:00:00.000Z");
    insertOrder("after_utc_midnight", 300, "processing", "2026-08-14T00:30:00.000Z");
    sqlite.prepare("INSERT INTO customers (id, name, phone, created_at) VALUES (?, 'Buyer', '+8801711111111', ?)")
      .run("customer_today", epoch("2026-08-13T18:00:01.000Z"));

    const activity = await getDailyActivityData(db, 2, "Asia/Dhaka");

    expect(activity).toHaveLength(2);
    expect(activity).toEqual([
      { date: "2026-08-13", orders: 1, revenue: 100, newCustomers: 0 },
      { date: "2026-08-14", orders: 2, revenue: 500, newCustomers: 1 },
    ]);
  });

  it("groups by the store's day across a daylight saving change", async () => {
    // New York falls back on 2026-11-01 at 06:00 UTC, so 1 November runs
    // 04:00 UTC (EDT midnight) to 05:00 UTC on 2 November (EST midnight).
    insertOrder("ny_oct31_late", 10, "processing", "2026-11-01T03:59:59.000Z");
    insertOrder("ny_nov1_start", 20, "processing", "2026-11-01T04:00:00.000Z");
    insertOrder("ny_nov1_end", 40, "processing", "2026-11-02T04:59:59.000Z");
    insertOrder("ny_nov2_start", 80, "processing", "2026-11-02T05:00:00.000Z");

    const activity = await getDailyActivityData(db, 3, "America/New_York", new Date("2026-11-02T12:00:00.000Z"));

    expect(activity).toEqual([
      { date: "2026-10-31", orders: 1, revenue: 10, newCustomers: 0 },
      { date: "2026-11-01", orders: 2, revenue: 60, newCustomers: 0 },
      { date: "2026-11-02", orders: 1, revenue: 80, newCustomers: 0 },
    ]);
  });

  it("counts cancelled and returned orders while excluding them from order value", async () => {
    insertOrder("daily_pending", 100, "pending", "2026-08-13T18:30:00.000Z");
    insertOrder("daily_cancelled", 50, "cancelled", "2026-08-13T19:30:00.000Z");
    insertOrder("daily_returned", 25, "returned", "2026-08-13T20:30:00.000Z");

    const activity = await getDailyActivityData(db, 1, "Asia/Dhaka");

    expect(activity).toEqual([
      { date: "2026-08-14", orders: 3, revenue: 100, newCustomers: 0 },
    ]);
  });

  it("returns exactly the requested number of rows including today", async () => {
    const activity = await getDailyActivityData(db, 90, "Asia/Dhaka");

    expect(activity).toHaveLength(90);
    expect(activity[0]?.date).toBe("2026-05-17");
    expect(activity.at(-1)?.date).toBe("2026-08-14");
  });
});
