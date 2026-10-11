import { afterEach, beforeEach, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { analyticsInstantRange, type AnalyticsRange } from "@scalius/shared/analytics-period";
import type { CapturedQuery } from "../../../testing/list-plans";
import { createAnalyticsFixture, type AnalyticsFixture } from "./reports.fixture";
import { createAnalyticsContext } from "./context";
import { getAnalyticsOverview } from "./overview";
import { sourceOverviewPeriod } from "./overview.source-oracle";

let f: AnalyticsFixture;
let queries: CapturedQuery[];
beforeEach(() => {
  f = createAnalyticsFixture();
  queries = [];
  f.db = createSqliteD1Database({ sqlite: f.sqlite, onQuery: (query, values) => queries.push({ query, values }) }).db;
});
afterEach(() => f.close());

function order(id: string, identity: string, createdAt: number, currencyCode = "BDT") {
  f.order({ id, createdAt, currencyCode, customerPhone: identity, requiresShipping: false,
    lines: [{ id: `${id}_line`, productId: "customer_summary", quantity: 1, unitMinor: 100, fulfillmentType: "digital" }] });
}

function seedBoundaries(range: AnalyticsRange, zone: string) {
  const { start, endExclusive: end } = analyticsInstantRange(range, zone);
  const middle = start + 36 * 3600;
  // These complete-day sales select the broad path without changing distinct counts.
  for (let i = 0; i < 12; i++) order(`steady_${i}`, "steady", middle);
  order("at_start", "at_start", start);
  order("at_end", "at_end", end);
  order("tie_a", "ties", middle);
  order("tie_b", "ties", middle);
  order("cross_prior", "cross", start - 0.25, "USD");
  order("cross_current", "cross", middle);
  order("gap_before", "gap", start - 0.25);
  order("gap_after", "gap", end);
  order("span_before", "span", start - 0.25);
  order("span_inside", "span", middle);
  order("span_after", "span", end);
  for (const [identity, first, second] of [
    ["deep_span", 2, 1], ["deep_gap", 2, 1], ["z_deep_early", 4, 3], ["a_deep_late", 0.75, 0.5],
  ] as const) {
    order(`${identity}_first`, identity, start - first);
    order(`${identity}_second`, identity, start - second);
    order(`${identity}_third`, identity, start - second / 2);
    order(`${identity}_fourth`, identity, start - second / 4);
    for (let i = 0; i < 4; i++) order(`${identity}_after_${i}`, identity, end);
  }
  order("deep_span_inside", "deep_span", middle);
  order("second_inside", "second_at_end", middle);
  order("second_end", "second_at_end", end);
  order("last_before", "last_inside", start - 0.25);
  order("last_inside", "last_inside", end - 0.25);
  return { start, middle, end };
}

async function parity(range: AnalyticsRange, zone: string, comparison: "none" | "previous_period" = "none") {
  const ctx = await createAnalyticsContext(f.db, zone);
  queries.length = 0;
  const result = await getAnalyticsOverview(ctx, { range, comparison, granularity: "day" });
  expect(queries).toHaveLength(comparison === "none" ? 2 : 3);
  const query = queries[1]!;
  for (const statement of queries) expect(statement.values.length).toBeLessThanOrEqual(100);
  expect(query.query).toContain("analytics_customer_currency_summary");
  expect(query.query).not.toContain("analytics_customer_first_sale");
  expect(result.current).toEqual(await sourceOverviewPeriod(ctx, range));
  if (result.previous) expect(result.previous).toEqual(await sourceOverviewPeriod(ctx, result.previous.range));
  return { period: result.current, query };
}

function expectBoundaryProbes(query: CapturedQuery) {
  // The lazy CASE touches facts only for histories unresolved by all eight endpoints.
  const probed: string[] = [];
  f.sqlite.function("customer_boundary_probe", (identity) => { probed.push(String(identity)); return 1; });
  const instrumented = query.query.replace("then case when exists (",
    "then customer_boundary_probe(cs.identity) * case when exists (");
  expect(instrumented).not.toBe(query.query);
  expect(f.sqlite.prepare(instrumented).all(...query.values as never[])).toEqual(f.sqlite.prepare(query.query).all(...query.values as never[]));
  expect(probed.sort()).toEqual(["p:a_deep_late", "p:deep_gap", "p:deep_span", "p:z_deep_early"]);
  const plan = f.sqlite.prepare(`EXPLAIN QUERY PLAN ${query.query}`).all(...query.values as never[]).map((row) => String(row.detail));
  expect(plan).not.toContain("MATERIALIZE unresolved");
  expect(plan.filter((line) => /SEARCH cs USING COVERING INDEX analytics_customer_currency_range_idx/.test(line))).toHaveLength(1);
  expect(plan.filter((line) => /SEARCH f (?:EXISTS )?USING COVERING INDEX analytics_facts_customer_identity_idx.*identity=\? AND created_at>\? AND created_at<\?/.test(line))).toHaveLength(1);
}

it.each([
  ["UTC", { from: "2026-08-01", to: "2026-08-03" }],
  ["America/New_York", { from: "2026-03-07", to: "2026-03-09" }],
  ["Asia/Kathmandu", { from: "2026-08-01", to: "2026-08-03" }],
  ["Australia/Lord_Howe", { from: "2026-10-03", to: "2026-10-05" }],
  ["Africa/Monrovia", { from: "1971-08-01", to: "1971-08-03" }],
] as const)("counts exact customer boundaries and duplicate instants in %s", async (zone, range) => {
  seedBoundaries(range, zone);
  const { period, query } = await parity(range, zone);
  expect(period.customers).toEqual({ customers: 8, newCustomers: 4, returningCustomers: 4, repeatPurchaseRate: 6 / 8 * 100 });
  // Eight sales split four/four still need the gap check; a ninth middle sale is present.
  expectBoundaryProbes(query);
});

it("proves membership at each added endpoint, including start and fractional end boundaries", async () => {
  const range = { from: "2026-08-01", to: "2026-08-03" };
  const { start, middle, end } = seedBoundaries(range, "UTC");
  for (let i = 0; i < 64; i++) order(`endpoint_steady_${i}`, "steady", middle);
  for (const [name, before, after] of [
    ["third", 2, 5], ["fourth", 3, 4], ["penultimate", 6, 1],
    ["third_last", 6, 2], ["fourth_last", 6, 3],
  ] as const) {
    for (const [boundary, instant] of [["start", start], ["middle", middle], ["end", end - 0.25]] as const) {
      const identity = `${name}_${boundary}`;
      for (let i = 0; i < before; i++) order(`${identity}_before_${i}`, identity, start - 0.25);
      order(`${identity}_inside`, identity, instant);
      for (let i = 0; i < after; i++) order(`${identity}_after_${i}`, identity, end);
    }
  }
  const { period, query } = await parity(range, "UTC", "previous_period");
  expect(period.customers).toMatchObject({ customers: 23, newCustomers: 4, returningCustomers: 19 });
  // Each added history has exactly one stored endpoint inside; none needs a fact probe.
  expectBoundaryProbes(query);
});

it("refreshes all sale endpoints through status, currency, identity, date and deletion changes", async () => {
  const range = { from: "2026-08-01", to: "2026-08-03" };
  const { start, middle, end } = seedBoundaries(range, "UTC");
  await parity(range, "UTC");
  for (const statement of [
    "UPDATE orders SET status = 'cancelled' WHERE id = 'tie_b'",
    "UPDATE orders SET status = 'pending' WHERE id = 'tie_b'",
    "UPDATE orders SET status = 'cancelled' WHERE id = 'cross_prior'",
    "UPDATE orders SET status = 'pending' WHERE id = 'cross_prior'",
    `UPDATE orders SET created_at = ${end} WHERE id = 'cross_prior'`,
    `UPDATE orders SET created_at = ${start - 0.25} WHERE id = 'cross_prior'`,
    "UPDATE orders SET shop_currency = 'USD' WHERE id = 'cross_current'",
    "UPDATE orders SET shop_currency = 'BDT' WHERE id = 'cross_current'",
    "UPDATE orders SET customer_phone = 'ties' WHERE id = 'cross_current'",
    "UPDATE orders SET customer_phone = 'cross' WHERE id = 'cross_current'",
    "UPDATE orders SET deleted_at = 123 WHERE id = 'span_inside'",
    "UPDATE orders SET deleted_at = NULL WHERE id = 'span_inside'",
    "UPDATE orders SET status = 'cancelled' WHERE id = 'deep_span_first'",
    "UPDATE orders SET status = 'pending' WHERE id = 'deep_span_first'",
    `UPDATE orders SET created_at = ${end - 0.25} WHERE id = 'deep_gap_fourth'`,
    `UPDATE orders SET created_at = ${start - 0.25} WHERE id = 'deep_gap_fourth'`,
    "DELETE FROM orders WHERE id = 'deep_span_after_3'",
    "DELETE FROM orders WHERE id = 'tie_a'",
    "DELETE FROM orders WHERE id = 'tie_b'",
  ]) {
    f.sqlite.exec(statement);
    await parity(range, "UTC");
  }
  order("tie_restored", "ties", middle);
  await parity(range, "UTC");
  const before = await parity(range, "UTC");
  f.sqlite.exec("BEGIN");
  f.sqlite.exec("UPDATE orders SET status = 'cancelled' WHERE id = 'cross_prior'");
  await parity(range, "UTC");
  f.sqlite.exec("ROLLBACK");
  expect((await parity(range, "UTC")).period).toEqual(before.period);
});
