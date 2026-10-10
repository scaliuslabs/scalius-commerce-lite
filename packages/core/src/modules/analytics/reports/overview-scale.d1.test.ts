// No ANALYZE statistics: this is the planner a large D1 store uses.
import { afterEach, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { analyticsRollupBackfillStatements } from "@scalius/database/analytics-rollup";
import type { CapturedQuery } from "../../../testing/list-plans";
import { createAnalyticsContext } from "./context";
import { getAnalyticsOverviewForRequest } from "./service";
import { seedScaleStore } from "./reports.scale-store";

let sqlite: DatabaseSync | undefined;
afterEach(() => sqlite?.close());

function customerAccessPlan(query: CapturedQuery): string[] {
  const rows = sqlite!.prepare(`EXPLAIN QUERY PLAN ${query.query}`).all(...query.values as never[]);
  const group = rows.find((row) => /^(?:CO-ROUTINE|MATERIALIZE) cu$/.test(String(row.detail)));
  expect(group).toBeDefined();
  const descendants = new Set([group!.id]);
  for (const row of rows) if (descendants.has(row.parent)) descendants.add(row.id);
  return rows.filter((row) => descendants.has(row.id)).map((row) => String(row.detail));
}

function expectCustomerIndex(query: CapturedQuery, summarized: boolean): void {
  if (summarized) {
    const plan = sqlite!.prepare(`EXPLAIN QUERY PLAN ${query.query}`).all(...query.values as never[]).map((row) => String(row.detail));
    expect(plan.filter((line) => /SEARCH cs USING COVERING INDEX analytics_customer_currency_range_idx.*shop_currency=\? AND first_sale_at>\? AND first_sale_at<\?/.test(line))).toHaveLength(1);
    expect(plan.filter((line) => /SEARCH f USING COVERING INDEX analytics_facts_customer_identity_idx.*shop_currency=\? AND identity=\? AND created_at>\? AND created_at<\?/.test(line))).toHaveLength(1);
    expect(query.query).not.toContain("analytics_customer_first_sale");
    expect(plan.some((line) => /(?:CO-ROUTINE|MATERIALIZE) cu/.test(line))).toBe(false);
    return;
  }
  const plan = customerAccessPlan(query);
  const dateSearch = /SEARCH f USING COVERING INDEX analytics_facts_customer_range_idx.*shop_currency=\? AND created_at>\? AND created_at<\?/;
  const identitySearch = /SEARCH f USING COVERING INDEX analytics_facts_customer_identity_idx \(shop_currency=\?\)/;
  expect(plan.filter((line) => dateSearch.test(line))).toHaveLength(1);
  expect(plan.filter((line) => identitySearch.test(line))).toHaveLength(0);
  expect(query.query).not.toContain("analytics_customer_currency_summary");
}

it("reads buckets and bounded facts for both periods without reopening the order ledger", async () => {
  const queries: CapturedQuery[] = [];
  const harness = createSqliteD1Database({ onQuery: (query, values) => queries.push({ query, values }) });
  sqlite = harness.sqlite;
  const now = new Date("2026-10-10T12:00:00+06:00");
  seedScaleStore(harness, 20_000, now);
  // Guest identities share phones across purchases; registered identities stay separate.
  sqlite.exec("UPDATE orders SET customer_id = NULL WHERE rowid % 3 = 0");
  // The scale loader deliberately disables triggers; refresh after this source edit.
  for (const table of ["analytics_customer_currency_summary", "analytics_sales_buckets", "analytics_customer_first_sale", "analytics_order_facts"]) sqlite.exec(`DELETE FROM ${table}`);
  for (const statement of analyticsRollupBackfillStatements()) sqlite.exec(statement);
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
  expect(queries).toHaveLength(3);
  // Strategy selection reads sparse daily totals only, once for both periods.
  expect(queries[0]!.query).toContain("analytics_sales_buckets");
  expect(queries[0]!.query).not.toContain("analytics_order_facts");
  for (const { query, values } of queries.slice(1)) {
    expect(values.length).toBeLessThanOrEqual(100);
    expect(sqlite.prepare(query).columns().length).toBeLessThanOrEqual(100);
    const planRows = sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...values as never[]);
    const plan = planRows.map((row) => String(row.detail));
    expect(plan.some((line) => /SEARCH f USING .*analytics_facts_range_idx.*created_at>\? AND created_at<\?/.test(line))).toBe(true);
    expectCustomerIndex({ query, values }, false);
    expect(plan.some((line) => /SEARCH b USING .*analytics_sales_buckets.*grain_seconds=\? AND dimension_kind=\? AND bucket_start>\? AND bucket_start<\?/.test(line))).toBe(true);
    expect(plan.some((line) => /SEARCH fs USING .*analytics_customer_first_sale.*identity=\?/.test(line))).toBe(true);
    expect(plan).not.toContain("MATERIALIZE cp");
    expect(plan).toContain("MATERIALIZE px");
    expect(query).not.toMatch(/\b(?:from|join)\s+(?:orders|order_items|order_payments|cod_tracking|order_returns|order_return_lines)\b/i);
    // A renamed table must not disguise the old full-store scan.
    expect(plan.filter((line) => /^SCAN (f|b|fs|analytics_order_facts|analytics_sales_buckets|analytics_customer_first_sale)( |$)/.test(line))).toEqual([]);
  }
  queries.length = 0;
  // The maximum accepted span includes two DST cycles without one bind per day.
  await getAnalyticsOverviewForRequest({ ...ctx, timeZone: "America/New_York" }, {
    from: "2024-01-01", to: "2025-12-31", comparison: "none",
  });
  expect(queries).toHaveLength(2);
  for (const query of queries) {
    expect(query.values.length).toBeLessThanOrEqual(100);
    expect(sqlite.prepare(query.query).columns().length).toBeLessThanOrEqual(100);
  }
  for (const [range, strategy] of [
    [{ from: "2025-10-01", to: "2026-10-10" }, 1],
    [{ from: "2025-10-01", to: "2025-11-01" }, 1],
    // An interior range covering between a quarter and half of the store's sales.
    [{ from: "2026-02-01", to: "2026-06-30" }, 1],
    [{ from: "2026-10-09", to: "2026-10-09" }, 0],
    [{ from: "2020-01-01", to: "2020-01-01" }, 1],
  ] as const) {
    queries.length = 0;
    await getAnalyticsOverviewForRequest(ctx, { ...range, comparison: "none" });
    expect(queries).toHaveLength(2);
    expectCustomerIndex(queries[1]!, strategy === 1);
  }
});
