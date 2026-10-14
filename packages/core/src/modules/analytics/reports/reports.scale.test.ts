/**
 * Analytics at scale: a generated store (orders over a year with lines,
 * COD tracking, parcels, returns, payments and refunds), every report and
 * the overview run against it, timed, and each statement's query plan
 * checked for full scans of the big tables.
 *
 * Always runs small (4,000 orders) as a boundedness gate. For the measured
 * run, opt in with a size and an output file:
 *
 *   ANALYTICS_SCALE_ORDERS=100000 ANALYTICS_SCALE_RUNS=3 ANALYTICS_SCALE_OUT=/tmp/analytics-scale.json \
 *     pnpm exec vitest run packages/core/src/modules/analytics/reports/reports.scale.test.ts --testTimeout=600000
 *
 * node:sqlite is not D1: absolute times are a local baseline (D1 adds network
 * and storage latency), but rows touched and plan shapes carry over.
 */
import { writeFileSync } from "node:fs";
import type { SQLInputValue } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database, type SqliteTestDatabase } from "@scalius/database/testing/sqlite-d1";
import { ANALYTICS_REPORTS, type AnalyticsReportId } from "@scalius/shared/analytics-reports";
import { createAnalyticsContext } from "./context";
import { exportAnalyticsReportCsv, getAnalyticsOverviewForRequest, getAnalyticsReportPage } from "./service";
import { seedScaleStore } from "./reports.scale-store";

const ORDERS = Number(process.env.ANALYTICS_SCALE_ORDERS ?? 4_000);
const OUT = process.env.ANALYTICS_SCALE_OUT;
const NOW = new Date("2026-09-01T06:00:00+06:00");
const YEAR = { from: "2025-09-02", to: "2026-09-01" };
const MONTH = { from: "2026-08-03", to: "2026-09-01" };
/** Tables a report must never read end to end. */
const BIG_TABLES = ["orders", "order_items", "order_payments", "order_return_lines", "cod_tracking", "delivery_shipments", "customers"];

let database: SqliteTestDatabase;
let captured: Array<{ query: string; values: readonly SQLInputValue[] }> = [];
const RUNS = Math.max(1, Number(process.env.ANALYTICS_SCALE_RUNS ?? 1));
/** `ms` is the median of the runs (a shared machine is noisy), `minMs` the fastest. */
const results: Array<{ name: string; ms: number; minMs: number; statements: number; fullScans: string[] }> = [];


/** The big table an alias in `query` names (`order_items oi`, `orders AS p`), or the name itself. */
function bigTableOf(query: string, name: string): string | undefined {
  if (BIG_TABLES.includes(name)) return name;
  for (const table of BIG_TABLES) {
    if (new RegExp(`["\`]?\\b${table}["\`]?\\s+(?:as\\s+)?["\`]?${name}["\`]?\\b`, "i").test(query)) return table;
  }
  return undefined;
}

/**
 * Full scans of the big tables in the statements a run issued (temp b-trees
 * for small groups are fine): a table scan, by name or alias, or a walk of a
 * whole index of one (`SCAN oi USING INDEX <index>` with no key constraint
 * reads every line in the store).
 */
function fullScans(): string[] {
  const scans = new Set<string>();
  for (const { query, values } of captured) {
    if (!/^\s*(select|with)/i.test(query)) continue;
    const plan = database.sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...values) as Array<{ detail: string }>;
    for (const { detail } of plan) {
      const scan = /^SCAN (\w+)(?: AS \w+)?(?: USING (?:COVERING )?INDEX (\w+))?$/.exec(detail);
      if (scan && bigTableOf(query, scan[1]!)) scans.add(detail);
      // An orders index entered on deleted_at alone walks every live order.
      if (/USING (?:COVERING )?INDEX orders_\w+ \(deleted_at=\?\)$/.test(detail)) scans.add(detail);
    }
  }
  return [...scans];
}

async function measure<T>(name: string, run: () => Promise<T>): Promise<T> {
  const times: number[] = [];
  let value!: T;
  let statements = 0;
  for (let attempt = 0; attempt < RUNS; attempt += 1) {
    captured = [];
    const started = performance.now();
    value = await run();
    times.push(performance.now() - started);
    statements = captured.length;
  }
  times.sort((left, right) => left - right);
  results.push({
    name,
    ms: Math.round(times[Math.floor(times.length / 2)]!),
    minMs: Math.round(times[0]!),
    statements,
    fullScans: fullScans(),
  });
  return value;
}

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  database = createSqliteD1Database({ onQuery: (query, values) => captured.push({ query, values }) });
  const started = performance.now();
  seedScaleStore(database, ORDERS, NOW);
  const seedMs = Math.round(performance.now() - started);
  results.push({ name: `seed ${ORDERS} orders`, ms: seedMs, minMs: seedMs, statements: 0, fullScans: [] });
}, 600_000);

afterAll(() => {
  if (OUT) writeFileSync(OUT, JSON.stringify({ orders: ORDERS, results }, null, 2));
  database?.sqlite.close();
  vi.restoreAllMocks();
});

describe(`analytics on a generated store (${ORDERS} orders)`, () => {
  it("serves the overview for a month and a year without scanning whole tables", async () => {
    const ctx = await createAnalyticsContext(database.db, "Asia/Dhaka", NOW);
    const month = await measure("overview 30 days", () => getAnalyticsOverviewForRequest(ctx, { ...MONTH }));
    const year = await measure("overview 365 days", () => getAnalyticsOverviewForRequest(ctx, { ...YEAR }));
    expect(month.current.totals.orders).toBeGreaterThan(0);
    expect(year.current.totals.orders).toBeGreaterThan(month.current.totals.orders);
    // The year's buckets add up to its totals.
    expect(year.series.reduce((sum, point) => sum + point.current.totalSales, 0)).toBe(year.current.totals.totalSales);
    for (const result of results.filter((entry) => entry.name.startsWith("overview"))) {
      expect(result.fullScans, result.name).toEqual([]);
    }
  });

  it.each(ANALYTICS_REPORTS.map((report) => report.id).filter((id) => id !== "profit_by_product"))(
    "runs %s for a year in bounded statements",
    async (reportId) => {
      const ctx = await createAnalyticsContext(database.db, "Asia/Dhaka", NOW);
      const page = await measure(`report ${reportId}`, () =>
        getAnalyticsReportPage(ctx, reportId as AnalyticsReportId, { ...YEAR, page: 1, pageSize: 50 }, { customers: true, costs: true }));
      expect(page.rows.length).toBeLessThanOrEqual(50);
      const result = results.at(-1)!;
      // Snapshot inventory reads cover the catalogue (every live SKU) by design; sales reads never scan orders.
      expect(result.fullScans.filter((detail) => !/product_variants|inventory_levels|products/.test(detail)), reportId).toEqual([]);
    },
  );

  it("exports the largest report as bounded CSV reads", async () => {
    const ctx = await createAnalyticsContext(database.db, "Asia/Dhaka", NOW);
    const exported = await measure("export sales_by_variant", () =>
      exportAnalyticsReportCsv(ctx, "sales_by_variant", { ...YEAR }, { customers: true, costs: true }));
    expect(exported.artifact.rowCount).toBeGreaterThan(1);
    expect(results.at(-1)!.statements).toBeLessThanOrEqual(6);
  });
});
