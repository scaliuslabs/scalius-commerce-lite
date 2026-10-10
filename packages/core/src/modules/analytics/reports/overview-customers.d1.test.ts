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
  for (const identity of ["deep_span", "deep_gap"]) {
    order(`${identity}_first`, identity, start - 2);
    order(`${identity}_second`, identity, start - 1);
    order(`${identity}_last`, identity, end);
  }
  order("deep_span_inside", "deep_span", middle);
  order("second_inside", "second_at_end", middle);
  order("second_end", "second_at_end", end);
  order("last_before", "last_inside", start - 0.25);
  order("last_inside", "last_inside", end - 0.25);
  return { start, middle, end };
}

async function parity(range: AnalyticsRange, zone: string) {
  const ctx = await createAnalyticsContext(f.db, zone);
  queries.length = 0;
  const result = await getAnalyticsOverview(ctx, { range, comparison: "none", granularity: "day" });
  expect(queries).toHaveLength(2);
  const query = queries[1]!;
  expect(query.query).toContain("analytics_customer_currency_summary");
  expect(query.query).not.toContain("analytics_customer_first_sale");
  expect(result.current).toEqual(await sourceOverviewPeriod(ctx, range));
  return { period: result.current, query };
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

  // The second sale proves span present and gap absent; only deeper histories need probes.
  const probed: string[] = [];
  f.sqlite.function("customer_boundary_probe", (identity) => { probed.push(String(identity)); return 1; });
  const instrumented = query.query.replace("else case when exists (", "else customer_boundary_probe(cs.identity) * case when exists (");
  expect(instrumented).not.toBe(query.query);
  expect(f.sqlite.prepare(instrumented).all(...query.values as never[])).toEqual(f.sqlite.prepare(query.query).all(...query.values as never[]));
  expect(probed.sort()).toEqual(["p:deep_gap", "p:deep_span"]);
});

it("refreshes first, second and last sales through status, currency, identity, date and deletion changes", async () => {
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
