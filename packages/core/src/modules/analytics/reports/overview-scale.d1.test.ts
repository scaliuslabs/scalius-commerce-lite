// No ANALYZE statistics: this is the planner a large D1 store uses.
import { afterEach, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { analyticsFactsBackfillStatement } from "@scalius/database/analytics-rollup";
import type { CapturedQuery } from "../../../testing/list-plans";
import { createAnalyticsContext } from "./context";
import { getAnalyticsOverviewForRequest } from "./service";
import { seedScaleStore } from "./reports.scale-store";

let sqlite: DatabaseSync | undefined;
afterEach(() => sqlite?.close());

function expectBoundedPlan({ query, values }: CapturedQuery): void {
  expect(values.length).toBeLessThanOrEqual(100);
  expect(sqlite!.prepare(query).columns().length).toBeLessThanOrEqual(100);
  const plan = sqlite!.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...values as never[]).map((row) => String(row.detail));
  expect(plan.some((line) => /SEARCH f USING .*analytics_facts_range_idx.*created_at>\? AND created_at<\?/.test(line))).toBe(true);
  expect(plan.some((line) => /SEARCH b USING .*analytics_sales_buckets.*grain_seconds=\? AND dimension_kind=\? AND bucket_start>\? AND bucket_start<\?/.test(line))).toBe(true);
  expect(plan.some((line) => /SEARCH f USING COVERING INDEX analytics_facts_customer_range_idx \(shop_currency=\? AND created_at>\? AND created_at<\?\)/.test(line))).toBe(true);
  expect(plan.some((line) => /SEARCH p USING COVERING INDEX analytics_facts_identity_idx \(identity=\? AND created_at<\?\)/.test(line))).toBe(true);
  expect(plan).toContain("MATERIALIZE px");
  expect(query).not.toMatch(/\b(?:from|join)\s+(?:orders|order_items|order_payments|cod_tracking|order_returns|order_return_lines)\b/i);
  // A renamed table must not disguise a full-store scan.
  expect(plan.filter((line) => /^SCAN (f|b|p|analytics_order_facts|analytics_sales_buckets)( |$)/.test(line))).toEqual([]);
}

it("reads sealed buckets and bounded facts for both periods without reopening the order ledger", async () => {
  const queries: CapturedQuery[] = [];
  const harness = createSqliteD1Database({ onQuery: (query, values) => queries.push({ query, values }) });
  sqlite = harness.sqlite;
  const now = new Date("2026-10-10T12:00:00+06:00");
  seedScaleStore(harness, 20_000, now);
  // Orders whose customer record is gone count as their own customers.
  sqlite.exec("UPDATE orders SET customer_id = NULL WHERE rowid % 3 = 0");
  // The scale loader drops triggers; recompute the facts after this source edit.
  sqlite.exec("DELETE FROM analytics_order_facts");
  sqlite.exec(analyticsFactsBackfillStatement());
  for (const table of ["sqlite_stat1", "sqlite_stat4"]) {
    if (sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(table)) sqlite.exec(`DELETE FROM ${table}`);
  }
  sqlite.exec("ANALYZE sqlite_schema");
  const ctx = await createAnalyticsContext(harness.db, "Asia/Dhaka", now);
  for (const request of [{}, { from: "2024-01-01", to: "2025-12-31", comparison: "previous_period" as const },
    { from: "2025-10-01", to: "2026-10-10" }, { from: "2026-02-01", to: "2026-06-30" }, { from: "2026-10-09", to: "2026-10-09" }]) {
    queries.length = 0;
    const overview = await getAnalyticsOverviewForRequest({ ...ctx, timeZone: "comparison" in request ? "America/New_York" : ctx.timeZone }, request);
    // The range's sealed days, then one statement per period.
    expect(queries.length).toBeLessThanOrEqual(3);
    expect(queries[0]!.query).toContain("analytics_sealed_days");
    for (const query of queries.slice(1)) expectBoundedPlan(query);
    for (const period of [overview.current, overview.previous].filter((period) => period !== null)) {
      expect(period.days.reduce((sum, day) => sum + day.totalSales, 0)).toBe(period.totals.totalSales);
      expect(period.customers.newCustomers + period.customers.returningCustomers).toBe(period.customers.customers);
      for (const breakdown of Object.values(period.breakdowns)) {
        expect(breakdown.reduce((sum, row) => sum + row.orders, 0)).toBe(period.totals.orders);
        expect(breakdown.reduce((sum, row) => sum + row.totalSales, 0)).toBe(period.totals.totalSales);
      }
    }
    if (Object.keys(request).length === 0) {
      expect(overview.current.totals.orders).toBeGreaterThan(1_000);
      expect(overview.previous!.totals.orders).toBeGreaterThan(1_000);
    }
  }
});
