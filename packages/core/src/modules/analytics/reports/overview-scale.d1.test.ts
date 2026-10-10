// No ANALYZE statistics: this is the planner a large D1 store uses.
import { afterEach, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { CapturedQuery } from "../../../testing/list-plans";
import { createAnalyticsContext } from "./context";
import { getAnalyticsOverviewForRequest } from "./service";
import { seedScaleStore } from "./reports.scale-store";

let sqlite: DatabaseSync | undefined;
afterEach(() => sqlite?.close());

it("bounds both overview periods to covering date indexes and probes each customer once", async () => {
  const queries: CapturedQuery[] = [];
  const harness = createSqliteD1Database({ onQuery: (query, values) => queries.push({ query, values }) });
  sqlite = harness.sqlite;
  const now = new Date("2026-10-10T12:00:00+06:00");
  seedScaleStore(harness, 20_000, now);
  // Guest identities share phones across purchases; registered identities stay separate.
  sqlite.exec("UPDATE orders SET customer_id = NULL WHERE rowid % 3 = 0");
  for (const table of ["sqlite_stat1", "sqlite_stat4"]) {
    if (sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(table)) sqlite.exec(`DELETE FROM ${table}`);
  }
  sqlite.exec("ANALYZE sqlite_schema");
  const ctx = await createAnalyticsContext(harness.db, "Asia/Dhaka", now);
  queries.length = 0;
  const overview = await getAnalyticsOverviewForRequest(ctx, {});
  expect(overview.current.totals.orders).toBeGreaterThan(1_000);
  expect(overview.previous!.totals.orders).toBeGreaterThan(1_000);
  for (const period of [overview.current, overview.previous!]) {
    expect(period.days.reduce((sum, day) => sum + day.totalSales, 0)).toBe(period.totals.totalSales);
    expect(period.customers.newCustomers + period.customers.returningCustomers).toBe(period.customers.customers);
    for (const breakdown of Object.values(period.breakdowns)) {
      expect(breakdown.reduce((sum, row) => sum + row.orders, 0)).toBe(period.totals.orders);
      expect(breakdown.reduce((sum, row) => sum + row.totalSales, 0)).toBe(period.totals.totalSales);
    }
  }
  expect(queries).toHaveLength(2);
  for (const { query, values } of queries) {
    expect(values.length).toBeLessThanOrEqual(100);
    expect(sqlite.prepare(query).columns().length).toBeLessThanOrEqual(100);
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...values as never[]).map((row) => String(row.detail));
    expect(plan).toContain("SEARCH o USING COVERING INDEX orders_overview_idx (deleted_at=? AND shop_currency=? AND created_at>? AND created_at<?)");
    expect(plan).toContain("SEARCH oi USING COVERING INDEX order_items_sales_idx (order_id=?)");
    expect(plan).toContain("SEARCH ct USING COVERING INDEX cod_tracking_status_idx (cod_status=? AND order_id=?) LEFT-JOIN");
    expect(plan).toContain("SEARCH rl USING COVERING INDEX order_return_lines_sales_idx (order_id=?)");
    expect(plan).toContain("SEARCH rr USING COVERING INDEX order_returns_sales_idx (id=? AND status=?)");
    expect(plan.some((line) => line.includes("COVERING INDEX order_payments_refund_sum_idx"))).toBe(true);
    expect(plan.filter((line) => line.includes("orders_customer_sales_idx"))).toHaveLength(1);
    expect(plan.filter((line) => line.includes("orders_guest_sales_idx"))).toHaveLength(1);
    expect(plan).toContain("MATERIALIZE cp");
    expect(plan).toContain("MATERIALIZE ox");
    expect(query).toContain("sum(ox.order_count)");
    // The seven breakdowns sort dimension groups, not the period's orders.
    const ctes = query.slice(query.indexOf("with so"), query.indexOf("-- D1 allows"));
    const bound = values.slice(0, (ctes.match(/\?/g) ?? []).length);
    const groups = sqlite.prepare(`${ctes} SELECT count(*) AS groups, sum(order_count) AS orders FROM ox`).get(...bound as never[])!;
    expect(Number(groups.groups)).toBeLessThan(Number(groups.orders));
    // A historical date scan per phone can look index-backed but is unbounded.
    expect(plan.filter((line) => /SEARCH p USING .*orders_sales_rollup_idx/.test(line))).toEqual([]);
    expect(plan.filter((line) => /^SCAN (o|oi|p|ct|rl|rr)( |$)/.test(line))).toEqual([]);
  }
});
