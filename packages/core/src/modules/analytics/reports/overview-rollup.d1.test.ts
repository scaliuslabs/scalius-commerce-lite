import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { analyticsInstantRange, type AnalyticsRange } from "@scalius/shared/analytics-period";
import { createAnalyticsFixture, type AnalyticsFixture, type FixtureOrder } from "./reports.fixture";
import { AUGUST, seedKnownAnswerStore } from "./metrics.fixture-store";
import { createAnalyticsContext } from "./context";
import { getAnalyticsOverview, rollUpDays } from "./overview";
import { sourceOverviewPeriod } from "./overview.source-oracle";
import { assertRollupProjection } from "./overview-rollup.assertions";

let f: AnalyticsFixture;
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  f = createAnalyticsFixture();
});
afterEach(() => { f.close(); vi.restoreAllMocks(); });

function order(id: string, overrides: Partial<FixtureOrder> = {}) {
  f.order({ id, createdAt: "2026-08-15T12:00:00Z", customerPhone: "NO_PHONE", requiresShipping: false,
    lines: [{ id: `${id}_line`, productId: "p_rollup", quantity: 3, unitMinor: 101, taxMinor: 31, discountMinor: 11, fulfillmentType: "digital" }], ...overrides });
}

function checkProjection() {
  assertRollupProjection(
    f.sqlite.prepare("SELECT * FROM analytics_order_facts").all(),
    f.sqlite.prepare("SELECT * FROM analytics_sales_buckets").all(),
    f.sqlite.prepare("SELECT * FROM analytics_customer_first_sale").all(),
  );
}

function trackProjectionWrites() {
  f.sqlite.exec("CREATE TEMP TABLE projection_writes (name TEXT)");
  for (const table of ["analytics_order_facts", "analytics_sales_buckets", "analytics_customer_first_sale", "analytics_customer_currency_summary"]) {
    for (const action of ["INSERT", "UPDATE", "DELETE"]) {
      f.sqlite.exec(`CREATE TEMP TRIGGER count_${table}_${action} AFTER ${action} ON ${table} BEGIN INSERT INTO projection_writes VALUES ('${table}'); END`);
    }
  }
}

async function parity(range: AnalyticsRange = AUGUST, timeZone = "Asia/Dhaka", currency = "BDT", comparison: "none" | "previous_period" | "previous_year" = "none") {
  const ctx = await createAnalyticsContext(f.db, timeZone);
  ctx.currency = { ...ctx.currency, code: currency, decimalPlaces: getDecimalPlaces(currency) };
  const result = await getAnalyticsOverview(ctx, { range, comparison, granularity: "day" });
  const source = await sourceOverviewPeriod(ctx, range);
  expect(result.current).toEqual(source);
  if (result.previous) expect(result.previous).toEqual(await sourceOverviewPeriod(ctx, result.previous.range));
  expect(result.series.map((row) => row.current)).toEqual(rollUpDays(range, source.days, "day", ctx.weekStart).map((row) => row.measures));
  checkProjection();
  return result.current;
}

describe("transactional analytics overview projections", () => {
  it("matches the independent source query before and after every eligibility transition", async () => {
    seedKnownAnswerStore(f);
    await parity(AUGUST, "Asia/Dhaka", "BDT", "previous_period");
    for (const statement of [
      "UPDATE orders SET status = 'pending' WHERE id = 'o5'",
      "UPDATE orders SET archived_at = 123 WHERE id = 'o1'",
      "UPDATE orders SET status = 'cancelled' WHERE id = 'o1'",
      "UPDATE orders SET status = 'returned' WHERE id = 'o1'",
      "UPDATE orders SET status = 'refunded' WHERE id = 'o3'",
      "UPDATE orders SET deleted_at = 123 WHERE id = 'o12'",
      "UPDATE orders SET deleted_at = NULL WHERE id IN ('o6', 'o12')",
      "UPDATE orders SET status = 'cancelled' WHERE id = 'o7'",
    ]) {
      f.sqlite.exec(statement);
      await parity();
    }
  });

  it("maintains exact cross-currency first sales and shared NO_PHONE identities after identity and date moves", async () => {
    order("prior", { createdAt: "2026-07-01T00:00:00Z", currencyCode: "USD" });
    order("a");
    order("b", { createdAt: "2026-08-16T00:00:00Z" });
    expect((await parity()).customers).toEqual({ customers: 1, newCustomers: 0, returningCustomers: 1, repeatPurchaseRate: 100 });
    f.customer("registered", "Registered", "+8801712345678");
    for (const statement of [
      "UPDATE orders SET customer_id = 'registered' WHERE id = 'b'",
      "UPDATE orders SET customer_phone = '+8801799999988' WHERE id = 'a'",
      "UPDATE orders SET created_at = created_at + 86400 * 62 WHERE id = 'prior'",
      "UPDATE orders SET customer_id = NULL, customer_phone = 'NO_PHONE' WHERE id = 'b'",
      "UPDATE orders SET status = 'cancelled' WHERE id = 'a'",
      "UPDATE orders SET deleted_at = 123 WHERE id = 'b'",
      "UPDATE orders SET deleted_at = NULL WHERE id = 'b'",
    ]) {
      f.sqlite.exec(statement);
      await parity(AUGUST, "Asia/Dhaka", "BDT", "previous_period");
    }
  });

  it.each(["BDT", "JPY", "KWD"])("preserves per-line FX rounding and residuals when shop currency is %s", async (currency) => {
    order("fx", { currencyCode: "USD", shippingMinor: 57, discountMinor: 23, taxMinor: 49, pricesIncludeTax: true,
      lines: [
        { id: "fx_a", productId: "p_fx", quantity: 3, unitMinor: 101, discountMinor: 11, taxMinor: 31 },
        { id: "fx_gc", productId: "p_gc", quantity: 1, unitMinor: 51, discountMinor: 7, taxMinor: 13, fulfillmentType: "gift_card" },
      ] });
    f.sqlite.prepare("UPDATE orders SET shop_currency = ?, currency_decimal_places = 2, fx_rate = '0.5' WHERE id = 'fx'").run(currency);
    f.payment({ id: "fx_ref1", orderId: "fx", amountMinor: 1, type: "refund", status: "refunded" });
    f.payment({ id: "fx_ref2", orderId: "fx", amountMinor: 1, type: "refund", status: "refunded" });
    f.returnCase({ id: "fx_return", orderId: "fx", status: "approved", lines: [{ itemId: "fx_a", approved: 1, requested: 3 }] });
    await parity(AUGUST, "Asia/Dhaka", currency);
    for (const statement of [
      "UPDATE order_return_lines SET approved_quantity = 2 WHERE id = 'fx_return_l0'",
      "UPDATE order_returns SET status = 'cancelled' WHERE id = 'fx_return'",
      "UPDATE orders SET fx_rate = '1.25', prices_include_tax = 0 WHERE id = 'fx'",
      "UPDATE orders SET currency_decimal_places = 0 WHERE id = 'fx'",
      "UPDATE orders SET status = 'refunded' WHERE id = 'fx'",
    ]) {
      f.sqlite.exec(statement);
      await parity(AUGUST, "Asia/Dhaka", currency);
    }
  });

  it("refreshes source-line moves, refunds, COD collection and transaction rollback atomically", async () => {
    order("a");
    order("b", { createdAt: "2026-08-17T00:00:00Z", channel: "admin", channelSource: "campaign" });
    f.payment({ id: "refund", orderId: "a", amountMinor: 17, type: "refund", status: "pending" });
    f.cod({ orderId: "a", status: "pending" });
    for (const statement of [
      "UPDATE order_items SET line_subtotal_minor = 401, discount_amount_minor = 13, tax_amount_minor = 47 WHERE id = 'a_line'",
      "UPDATE order_items SET order_id = 'b' WHERE id = 'a_line'",
      "UPDATE order_payments SET status = 'refunded' WHERE id = 'refund'",
      "UPDATE order_payments SET amount_minor = 19, order_id = 'b' WHERE id = 'refund'",
      "UPDATE orders SET status = 'returned' WHERE id = 'a'",
      "UPDATE cod_tracking SET cod_status = 'collected' WHERE order_id = 'a'",
      "UPDATE cod_tracking SET order_id = 'b' WHERE order_id = 'a'",
      "DELETE FROM cod_tracking WHERE order_id = 'b'",
      "DELETE FROM order_payments WHERE id = 'refund'",
      "DELETE FROM order_items WHERE id = 'a_line'",
    ]) {
      f.sqlite.exec(statement);
      await parity();
    }
    const before = await parity();
    f.sqlite.exec("BEGIN");
    f.sqlite.exec("UPDATE orders SET shop_currency = 'USD', created_at = created_at - 86400 * 60 WHERE id = 'b'");
    await parity();
    f.sqlite.exec("ROLLBACK");
    expect(await parity()).toEqual(before);
  });

  it("resolves current zone labels, method assignments and the default location without rewriting facts", async () => {
    f.sqlite.exec("INSERT INTO delivery_zones (id, name) VALUES ('z_a', 'Zone A'), ('z_b', 'Zone B')");
    f.sqlite.exec("INSERT INTO shipping_methods (id, name, zone_id) VALUES ('sm_a', 'Delivery', 'z_a')");
    f.sqlite.exec("INSERT INTO inventory_locations (id, name, code) VALUES ('loc_b', 'Second', 'SECOND')");
    order("delivery", { requiresShipping: true, shippingMethodId: "sm_a", shippingMethodKind: "delivery" });
    order("legacy", { requiresShipping: false, shippingMethodId: "sm_a", shippingMethodKind: "pickup" });
    await parity();
    const facts = f.sqlite.prepare("SELECT * FROM analytics_order_facts ORDER BY order_id").all();
    for (const statement of [
      "UPDATE delivery_zones SET name = 'Renamed' WHERE id = 'z_a'",
      "UPDATE shipping_methods SET zone_id = 'z_b' WHERE id = 'sm_a'",
      "UPDATE inventory_locations SET is_default = 0 WHERE is_default = 1",
      "UPDATE inventory_locations SET is_default = 1, name = 'New default' WHERE id = 'loc_b'",
    ]) {
      f.sqlite.exec(statement);
      await parity();
      expect(f.sqlite.prepare("SELECT * FROM analytics_order_facts ORDER BY order_id").all()).toEqual(facts);
    }
  });

  it.each([
    ["America/New_York", { from: "2026-03-07", to: "2026-03-09" }],
    ["America/New_York", { from: "2026-10-31", to: "2026-11-02" }],
    ["Asia/Kathmandu", { from: "2026-08-01", to: "2026-08-02" }],
    ["Australia/Lord_Howe", { from: "2026-10-03", to: "2026-10-05" }],
    ["Africa/Monrovia", { from: "1971-08-01", to: "1971-08-02" }],
  ] as const)("keeps exact fractional boundaries and editable timezone grouping in %s", async (timeZone, range) => {
    const { start, endExclusive } = analyticsInstantRange(range, timeZone);
    const instants = new Set([start - 0.25, start, start + 0.25, endExclusive - 0.25, endExclusive, endExclusive + 0.25]);
    for (let at = start; at < endExclusive; at += 900) instants.add(at + 0.5);
    let index = 0;
    for (const createdAt of instants) order(`time_${index++}`, { createdAt });
    await parity(range, timeZone);
    await parity(range, "UTC");
    await parity(range, "Asia/Dhaka");
  });

  it("bounds projection writes for the supported 99-line order and ignores unrelated or unchanged updates", async () => {
    trackProjectionWrites();
    const started = performance.now();
    order("large", { lines: Array.from({ length: 99 }, (_, i) => ({ id: `large_${i}`, productId: "p_large", quantity: 1, unitMinor: 101, fulfillmentType: "digital" })) });
    const elapsedMs = performance.now() - started;
    const writes = Number(f.sqlite.prepare("SELECT count(*) AS n FROM projection_writes").get()!.n);
    // One fact + at most seven bucket writes per refresh, and two customer-summary inserts.
    expect(writes).toBeLessThanOrEqual(8 * 100 + 2);
    expect((await parity()).totals).toMatchObject({ orders: 1, grossSales: 9_999, netItemsSold: 99 });
    f.sqlite.exec("DELETE FROM projection_writes");
    f.sqlite.exec("UPDATE orders SET customer_name = 'Changed label', updated_at = updated_at + 1 WHERE id = 'large'");
    f.sqlite.exec("UPDATE order_items SET line_subtotal_minor = line_subtotal_minor WHERE order_id = 'large'");
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM projection_writes").get()!.n).toBe(0);
    // Evidence, not a machine-dependent unit-test latency threshold.
    process.stdout.write(`${JSON.stringify({ analyticsRollup99Lines: { elapsedMs, projectionWrites: writes } })}\n`);
  });

  it("changes only the fact and two total buckets for COD collection or a refund", async () => {
    order("payment_only");
    f.cod({ orderId: "payment_only", status: "pending" });
    f.payment({ id: "payment_only_refund", orderId: "payment_only", amountMinor: 17, type: "refund", status: "pending" });
    trackProjectionWrites();
    for (const statement of [
      "UPDATE cod_tracking SET cod_status = 'collected' WHERE order_id = 'payment_only'",
      "UPDATE order_payments SET status = 'refunded' WHERE id = 'payment_only_refund'",
    ]) {
      f.sqlite.exec("DELETE FROM projection_writes");
      f.sqlite.exec(statement);
      expect(f.sqlite.prepare("SELECT name, count(*) AS n FROM projection_writes GROUP BY name ORDER BY name").all()).toEqual([
        { name: "analytics_order_facts", n: 1 },
        { name: "analytics_sales_buckets", n: 2 },
      ]);
      await parity();
    }
  });
});
