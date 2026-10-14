import { afterEach, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { analyticsBuckets, analyticsDateKeyFromEpochDay, analyticsInstantRange, type AnalyticsGranularity, type AnalyticsRange } from "@scalius/shared/analytics-period";
import { analyticsReport } from "@scalius/shared/analytics-reports";
import type { WeekDay } from "@scalius/shared/week-start";
import type { CapturedQuery } from "../../../testing/list-plans";
import { createAnalyticsFixture, type AnalyticsFixture } from "./reports.fixture";
import { AUGUST, seedKnownAnswerStore } from "./metrics.fixture-store";
import { createAnalyticsContext, num, type AnalyticsContext } from "./context";
import { runReportPage, type ReportCell, type RowsReport } from "./engine";
import { createReportCsvBuilder } from "./csv";
import { getAnalyticsReportPage, exportAnalyticsReportCsv } from "./service";
import { bucketStartSql } from "./sales-sql";
import { merchantDaySql, orderMeasuresSql, orderMetricsCtes, salesLinesCtes, salesOrdersCte, scopeOffsets } from "../../../testing/analytics-oracle/source-sales";
import { sealEveryFactDay } from "./overview-rollup.assertions";

const ACCESS = { customers: true, costs: true };
const FIELDS = ["orders", "gross_sales", "discounts", "returns", "net_sales", "shipping", "taxes", "total_sales", "net_items_sold"] as const;
let f: AnalyticsFixture;
let queries: CapturedQuery[];
beforeEach(() => {
  f = createAnalyticsFixture();
  queries = [];
  f.db = createSqliteD1Database({ sqlite: f.sqlite, onQuery: (query, values) => queries.push({ query, values }) }).db;
});
afterEach(() => f.close());

function finishAov(values: Record<string, ReportCell>) {
  values.average_order_value = num(values.orders) > 0
    ? Math.round((num(values.gross_sales) - num(values.discounts)) / num(values.orders)) : 0;
}

// The previous report query and row mapping, backed by frozen source monetary SQL.
const sourceReport: RowsReport = {
  kind: "rows",
  async rows(ctx, params) {
    const range = params.range!;
    const granularity = params.granularity!;
    const instants = analyticsInstantRange(range, ctx.timeZone);
    const bucket = bucketStartSql(merchantDaySql("om.created_at", scopeOffsets(ctx.timeZone, instants)), granularity, range, ctx.weekStart);
    const rows = await ctx.db.all<Record<string, unknown>>(sql`with
      ${salesOrdersCte({ ...instants, currency: ctx.currency.code })}, ${salesLinesCtes()}, ${orderMetricsCtes()}
      select ${bucket} as bucket, ${orderMeasuresSql("om")} from om group by ${bucket}`);
    const found = new Map(rows.map((row) => {
      const values: Record<string, ReportCell> = Object.fromEntries(FIELDS.map((key) => [key, num(row[key])]));
      finishAov(values);
      return [analyticsDateKeyFromEpochDay(num(row.bucket)), values];
    }));
    return { rows: analyticsBuckets(range, granularity, ctx.weekStart).map(({ key }) => ({
      id: key,
      values: { period: key, ...(found.get(key) ?? { ...Object.fromEntries(FIELDS.map((field) => [field, 0])), average_order_value: 0 }) },
    })) };
  },
  finishTotals: finishAov,
};

async function parity(ctx: AnalyticsContext, range: AnalyticsRange, granularity: AnalyticsGranularity, sort = "period", direction: "asc" | "desc" = "asc", page = 1, pageSize = 100) {
  const read = async () => {
    queries.length = 0;
    const actual = await getAnalyticsReportPage(ctx, "sales_over_time", { ...range, granularity, sort, direction, page, pageSize }, ACCESS);
    // The sealed days of the range, then one bucket/fact statement.
    expect(queries).toHaveLength(2);
    expect(queries[0]!.query).toContain("analytics_sealed_days");
    const query = queries[1]!;
    expect(query.query).toContain("analytics_sales_buckets");
    expect(query.query).not.toMatch(/\b(?:from|join)\s+(?:orders|order_items|order_returns|order_return_lines|order_payments)\b/i);
    return { actual, query };
  };
  const expected = await runReportPage(ctx, "sales_over_time", sourceReport, { range, granularity, sort: { key: sort, direction }, page, pageSize });
  expect((await read()).actual).toEqual(expected);
  await sealEveryFactDay(f.db);
  const sealed = await read();
  expect(sealed.actual).toEqual(expected);
  return sealed;
}

it("preserves returns, gift cards, FX rounding, totals, sorting, paging and CSV bytes", async () => {
  seedKnownAnswerStore(f);
  f.order({ id: "fx", createdAt: "2026-08-15T12:00:00Z", currencyCode: "USD", pricesIncludeTax: true,
    shippingMinor: 57, discountMinor: 23, taxMinor: 49, lines: [
      { id: "fx_a", productId: "fx_product", quantity: 3, unitMinor: 101, discountMinor: 11, taxMinor: 31 },
      { id: "fx_gift", productId: "fx_gift", quantity: 1, unitMinor: 51, discountMinor: 7, taxMinor: 13, fulfillmentType: "gift_card" },
    ] });
  f.sqlite.exec("UPDATE orders SET shop_currency = 'BDT', fx_rate = '0.5', currency_decimal_places = 2 WHERE id = 'fx'");
  f.returnCase({ id: "fx_return", orderId: "fx", status: "approved", lines: [{ itemId: "fx_a", approved: 1, requested: 3 }] });
  const ctx = await createAnalyticsContext(f.db, "Asia/Dhaka");
  for (const [sort, direction, page] of [["total_sales", "desc", 1], ["average_order_value", "asc", 2], ["period", "desc", 99]] as const) {
    await parity(ctx, AUGUST, "day", sort, direction, page, 3);
  }
  for (const statement of [
    "UPDATE order_return_lines SET approved_quantity = 2 WHERE id = 'fx_return_l0'",
    "UPDATE order_returns SET status = 'cancelled' WHERE id = 'fx_return'",
    "UPDATE orders SET status = 'refunded' WHERE id = 'fx'",
    "UPDATE orders SET status = 'cancelled' WHERE id = 'o1'",
    "UPDATE orders SET deleted_at = NULL WHERE id = 'o6'",
  ]) {
    f.sqlite.exec(statement);
    await parity(ctx, AUGUST, "day");
  }
  for (const currency of ["JPY", "KWD", "BDT"]) {
    f.sqlite.prepare("UPDATE orders SET shop_currency = ? WHERE id = 'fx'").run(currency);
    await parity({ ...ctx, currency: { ...ctx.currency, code: currency, decimalPlaces: getDecimalPlaces(currency) } }, AUGUST, "month");
  }
  const source = await runReportPage(ctx, "sales_over_time", sourceReport, { range: AUGUST, granularity: "day", sort: { key: "total_sales", direction: "desc" }, page: 1, pageSize: 100 });
  const csv = createReportCsvBuilder(analyticsReport("sales_over_time"), ctx.currency, undefined, ctx.paymentMethodName);
  for (const row of source.rows) csv.append(row);
  csv.appendTotals(source.totals);
  queries.length = 0;
  const exported = await exportAnalyticsReportCsv(ctx, "sales_over_time", { ...AUGUST, granularity: "day", sort: "total_sales", direction: "desc" }, ACCESS);
  expect(queries).toHaveLength(2);
  expect(exported.artifact).toEqual(csv.finish());
  expect(exported).toMatchObject({ totalRows: 31, truncatedBy: "none", filename: "sales-over-time-2026-08-01_2026-08-31.csv" });
});

it.each([
  ["America/New_York", { from: "2026-03-07", to: "2026-03-09" }],
  ["America/New_York", { from: "2026-10-31", to: "2026-11-02" }],
  ["Australia/Lord_Howe", { from: "2026-10-03", to: "2026-10-05" }],
  ["Asia/Kathmandu", { from: "2026-08-01", to: "2026-08-03" }],
  ["Africa/Monrovia", { from: "1971-08-01", to: "1971-08-03" }],
  ["UTC", { from: "1969-12-30", to: "1970-01-01" }],
] as const)("matches exact day/week/month grouping at fractional boundaries in %s", async (zone, range) => {
  const instants = analyticsInstantRange(range, zone);
  const boundaries = [instants.start, instants.endExclusive,
    ...analyticsBuckets(range, "day").map(({ key }) => analyticsInstantRange({ from: key, to: key }, zone).start),
    ...scopeOffsets(zone, instants).changes.map(({ at }) => at)];
  const times = new Set(boundaries.flatMap((at) => [at - 0.25, at, at + 0.25, at + 900]));
  let index = 0;
  for (const createdAt of times) {
    const id = `time_${index++}`;
    f.order({ id, createdAt, requiresShipping: false, lines: [{ id: `${id}_line`, productId: "time_product", quantity: 1, unitMinor: 101, fulfillmentType: "digital" }] });
  }
  const ctx = await createAnalyticsContext(f.db, zone);
  for (const [granularity, weekStart] of [["day", 0], ["week", 0], ["week", 1], ["month", 0]] as const) {
    await parity({ ...ctx, weekStart: weekStart as WeekDay }, range, granularity);
  }
  await parity({ ...ctx, timeZone: "Asia/Dhaka" }, range, "day");
});

it("keeps the maximum span to one bounded bucket/fact statement and zero-fills an empty page", async () => {
  const ctx = await createAnalyticsContext(f.db, "Africa/Monrovia");
  const range = { from: "1971-01-01", to: "1972-12-31" };
  const { actual, query } = await parity(ctx, range, "month");
  expect(actual.totalRows).toBe(24);
  expect(actual.totals.orders).toBe(0);
  expect(query.values.length).toBeLessThanOrEqual(100);
  expect(f.sqlite.prepare(query.query).columns().length).toBeLessThanOrEqual(100);
  const plan = f.sqlite.prepare(`EXPLAIN QUERY PLAN ${query.query}`).all(...query.values as never[]).map((row) => String(row.detail));
  expect(plan.some((line) => /SEARCH b USING .*analytics_sales_buckets.*grain_seconds=\? AND dimension_kind=\? AND bucket_start>\? AND bucket_start<\?/.test(line))).toBe(true);
  expect(plan.some((line) => /SEARCH f USING .*analytics_facts_(?:range|customer_range)_idx.*created_at>\? AND created_at<\?/.test(line))).toBe(true);
  expect(plan.filter((line) => /^SCAN (?:b|f|analytics_sales_buckets|analytics_order_facts)(?: |$)/.test(line))).toEqual([]);
});
