import { afterEach, beforeEach, expect, it } from "vitest";
import { createSqliteD1Database, createSqliteTursoDatabase } from "@scalius/database/testing/sqlite-d1";
import { analyticsInstantRange, type AnalyticsRange } from "@scalius/shared/analytics-period";
import type { CapturedQuery } from "../../../testing/list-plans";
import { createAnalyticsFixture, type AnalyticsFixture } from "./reports.fixture";
import { createAnalyticsContext } from "./context";
import { getAnalyticsOverview } from "./overview";
import { sourceOverviewPeriod } from "../../../testing/analytics-oracle/source-oracle";
import { sealEveryFactDay } from "./overview-rollup.assertions";

let f: AnalyticsFixture;
let queries: CapturedQuery[];
beforeEach(() => {
  f = createAnalyticsFixture();
  queries = [];
  f.db = createSqliteD1Database({ sqlite: f.sqlite, onQuery: (query, values) => queries.push({ query, values }) }).db;
});
afterEach(() => f.close());

/** `identity` is the guest's phone: checkout keys their customer record by it. */
function order(id: string, identity: string, createdAt: number, currencyCode = "BDT") {
  f.order({ id, createdAt, currencyCode, customerPhone: identity, requiresShipping: false,
    lines: [{ id: `${id}_line`, productId: "customer_summary", quantity: 1, unitMinor: 100, fulfillmentType: "digital" }] });
}

function seedBoundaries(range: AnalyticsRange, zone: string) {
  const { start, endExclusive: end } = analyticsInstantRange(range, zone);
  const middle = start + 36 * 3600;
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

/** Exact against the source query, as written and with every finished day sealed. */
async function parity(range: AnalyticsRange, zone: string, comparison: "none" | "previous_period" = "none") {
  const ctx = await createAnalyticsContext(f.db, zone);
  const read = async () => {
    queries.length = 0;
    const result = await getAnalyticsOverview(ctx, { range, comparison, granularity: "day" });
    // Sealed days of both periods, then one statement per period.
    expect(queries).toHaveLength(comparison === "none" ? 2 : 3);
    for (const statement of queries) expect(statement.values.length).toBeLessThanOrEqual(100);
    expect(result.current).toEqual(await sourceOverviewPeriod(ctx, range));
    if (result.previous) expect(result.previous).toEqual(await sourceOverviewPeriod(ctx, result.previous.range));
    return result;
  };
  const asWritten = await read();
  await sealEveryFactDay(f.db);
  const result = await read();
  expect(result).toEqual(asWritten);
  return { period: result.current, query: queries[1]!, result };
}

function expectCustomerPlan(query: CapturedQuery) {
  const plan = f.sqlite.prepare(`EXPLAIN QUERY PLAN ${query.query}`).all(...query.values as never[]).map((row) => String(row.detail));
  // Customers in range from the covering date index; each one's earlier sale is one probe.
  expect(plan.some((line) => /SEARCH f USING COVERING INDEX analytics_facts_customer_range_idx \(shop_currency=\? AND created_at>\? AND created_at<\?\)/.test(line))).toBe(true);
  expect(plan.some((line) => /SEARCH p USING COVERING INDEX analytics_facts_identity_idx \(identity=\? AND created_at<\?\)/.test(line))).toBe(true);
  expect(plan).toContain("MATERIALIZE cp");
  expect(plan.filter((line) => /^SCAN (f|p|analytics_order_facts)( |$)/.test(line))).toEqual([]);
}

it.each([
  ["UTC", { from: "2026-08-01", to: "2026-08-03" }],
  ["America/New_York", { from: "2026-03-07", to: "2026-03-09" }],
  ["Asia/Kathmandu", { from: "2026-08-01", to: "2026-08-03" }],
  ["Australia/Lord_Howe", { from: "2026-10-03", to: "2026-10-05" }],
  ["Africa/Monrovia", { from: "1971-08-01", to: "1971-08-03" }],
] as const)("counts exact customer boundaries and duplicate instants in %s", async (zone, range) => {
  seedBoundaries(range, zone);
  const { period, query } = await parity(range, zone, "previous_period");
  expect(period.customers).toEqual({ customers: 8, newCustomers: 4, returningCustomers: 4, repeatPurchaseRate: 6 / 8 * 100 });
  expectCustomerPlan(query);
});

it("reads the same counts through Turso", async () => {
  const range = { from: "2026-08-04", to: "2026-08-06" };
  seedBoundaries(range, "UTC");
  const { result } = await parity(range, "UTC", "previous_period");
  const turso = await createAnalyticsContext(createSqliteTursoDatabase(f.sqlite), "UTC");
  expect(await getAnalyticsOverview(turso, { range, comparison: "previous_period", granularity: "day" })).toEqual(result);
});

it("stays exact through status, currency, identity, date and deletion changes", async () => {
  const range = { from: "2026-08-01", to: "2026-08-03" };
  const { start, middle, end } = seedBoundaries(range, "UTC");
  await parity(range, "UTC", "previous_period");
  const customerOf = (phone: string) => String(f.sqlite.prepare("SELECT id FROM customers WHERE phone = ?").get(phone)!.id);
  for (const statement of [
    "UPDATE orders SET status = 'cancelled' WHERE id = 'tie_b'",
    "UPDATE orders SET status = 'pending' WHERE id = 'tie_b'",
    "UPDATE orders SET status = 'cancelled' WHERE id = 'cross_prior'",
    "UPDATE orders SET status = 'pending' WHERE id = 'cross_prior'",
    `UPDATE orders SET created_at = ${end} WHERE id = 'cross_prior'`,
    `UPDATE orders SET created_at = ${start - 0.25} WHERE id = 'cross_prior'`,
    "UPDATE orders SET shop_currency = 'USD' WHERE id = 'cross_current'",
    "UPDATE orders SET shop_currency = 'BDT' WHERE id = 'cross_current'",
    `UPDATE orders SET customer_id = '${customerOf("ties")}' WHERE id = 'cross_current'`,
    `UPDATE orders SET customer_id = '${customerOf("cross")}' WHERE id = 'cross_current'`,
    "UPDATE orders SET customer_id = NULL WHERE id = 'span_inside'",
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
    await parity(range, "UTC", "previous_period");
  }
  order("tie_restored", "ties", middle);
  const before = await parity(range, "UTC", "previous_period");
  f.sqlite.exec("BEGIN");
  f.sqlite.exec("UPDATE orders SET status = 'cancelled' WHERE id = 'cross_prior'");
  f.sqlite.exec("ROLLBACK");
  expect((await parity(range, "UTC", "previous_period")).period).toEqual(before.period);
});
