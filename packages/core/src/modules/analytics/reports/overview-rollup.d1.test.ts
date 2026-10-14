import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { NO_PHONE } from "@scalius/shared/customer-auth-policy";
import { analyticsInstantRange, type AnalyticsRange } from "@scalius/shared/analytics-period";
import { createAnalyticsFixture, type AnalyticsFixture, type FixtureOrder } from "./reports.fixture";
import { AUGUST, seedKnownAnswerStore } from "./metrics.fixture-store";
import { createAnalyticsContext } from "./context";
import { getAnalyticsOverview, rollUpDays } from "./overview";
import { sourceOverviewPeriod } from "../../../testing/analytics-oracle/source-oracle";
import { assertRollupProjection, sealEveryFactDay } from "./overview-rollup.assertions";

let f: AnalyticsFixture;
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  f = createAnalyticsFixture();
});
afterEach(() => { f.close(); vi.restoreAllMocks(); });

function order(id: string, overrides: Partial<FixtureOrder> = {}) {
  f.order({ id, createdAt: "2026-08-15T12:00:00Z", requiresShipping: false,
    lines: [{ id: `${id}_line`, productId: "p_rollup", quantity: 3, unitMinor: 101, taxMinor: 31, discountMinor: 11, fulfillmentType: "digital" }], ...overrides });
}

function trackProjectionWrites() {
  f.sqlite.exec("CREATE TEMP TABLE projection_writes (name TEXT)");
  for (const table of ["analytics_order_facts", "analytics_sales_buckets", "analytics_sealed_days"]) {
    for (const action of ["INSERT", "UPDATE", "DELETE"]) {
      f.sqlite.exec(`CREATE TEMP TRIGGER count_${table}_${action} AFTER ${action} ON ${table} BEGIN INSERT INTO projection_writes VALUES ('${table}'); END`);
    }
  }
}
const projectionWrites = () => f.sqlite.prepare("SELECT name, count(*) AS n FROM projection_writes GROUP BY name ORDER BY name").all();

/**
 * The overview equals the independent source query with the days as they are
 * (unsealed after a write), and again once every day is sealed into buckets.
 */
async function parity(range: AnalyticsRange = AUGUST, timeZone = "Asia/Dhaka", currency = "BDT", comparison: "none" | "previous_period" | "previous_year" = "none", seal = true) {
  const ctx = await createAnalyticsContext(f.db, timeZone);
  ctx.currency = { ...ctx.currency, code: currency, decimalPlaces: getDecimalPlaces(currency) };
  const check = async () => {
    const result = await getAnalyticsOverview(ctx, { range, comparison, granularity: "day" });
    const source = await sourceOverviewPeriod(ctx, range);
    expect(result.current).toEqual(source);
    if (result.previous) expect(result.previous).toEqual(await sourceOverviewPeriod(ctx, result.previous.range));
    expect(result.series.map((row) => row.current)).toEqual(rollUpDays(range, source.days, "day", ctx.weekStart).map((row) => row.measures));
    return result.current;
  };
  await assertRollupProjection(f.db);
  const asWritten = await check();
  if (!seal) return asWritten;
  await sealEveryFactDay(f.db);
  await assertRollupProjection(f.db);
  expect(await check()).toEqual(asWritten);
  return asWritten;
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

  it("keys customers by record: phoneless orders without one never merge, merges and date moves stay exact", async () => {
    // Production stores a missing phone as NO_PHONE (''); without a customer record each order is its own customer.
    order("prior", { createdAt: "2026-07-01T00:00:00Z", currencyCode: "USD", customerPhone: NO_PHONE });
    order("a", { customerPhone: NO_PHONE });
    order("b", { createdAt: "2026-08-16T00:00:00Z", customerPhone: NO_PHONE });
    expect((await parity()).customers).toEqual({ customers: 2, newCustomers: 2, returningCustomers: 0, repeatPurchaseRate: 0 });
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM analytics_order_facts WHERE identity LIKE 'p:%' OR identity LIKE '%+880%'").get()!.n).toBe(0);
    f.customer("registered", "Registered", "+8801712345678");
    for (const statement of [
      "UPDATE orders SET customer_id = 'registered' WHERE id IN ('prior', 'b')",
      "UPDATE orders SET customer_id = 'registered' WHERE id = 'a'",
      "UPDATE orders SET created_at = created_at + 86400 * 62 WHERE id = 'prior'",
      "UPDATE orders SET customer_id = NULL WHERE id = 'b'",
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
    await parity(AUGUST, "Asia/Dhaka", "BDT", "none", false);
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
    // A day unsealed by a late write is read from facts beside its sealed neighbours.
    f.sqlite.exec("UPDATE orders SET status = 'cancelled' WHERE id = 'time_3'");
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM analytics_sealed_days").get()!.n).toBeGreaterThan(0);
    await parity(range, timeZone);
  });

  it("writes one fact row per order and per line, never a shared row, and nothing for unrelated or unchanged updates", async () => {
    trackProjectionWrites();
    const started = performance.now();
    order("large", { lines: Array.from({ length: 300 }, (_, i) => ({ id: `large_${i}`, productId: "p_large", quantity: 1, unitMinor: 101, fulfillmentType: "digital" })) });
    const elapsedMs = performance.now() - started;
    // One fact insert, then one update per line: linear, and no bucket or day row.
    expect(projectionWrites()).toEqual([{ name: "analytics_order_facts", n: 301 }]);
    expect((await parity()).totals).toMatchObject({ orders: 1, grossSales: 30_300, netItemsSold: 300 });
    f.sqlite.exec("DELETE FROM projection_writes");
    f.sqlite.exec("UPDATE orders SET customer_name = 'Changed label', updated_at = updated_at + 1 WHERE id = 'large'");
    f.sqlite.exec("UPDATE order_items SET line_subtotal_minor = line_subtotal_minor WHERE order_id = 'large'");
    expect(projectionWrites()).toEqual([]);
    // Evidence, not a machine-dependent unit-test latency threshold.
    process.stdout.write(`${JSON.stringify({ analyticsRollup300Lines: { elapsedMs } })}\n`);
  });

  it("equals a rebuild after a random sequence of order writes, with days sealed in between", async () => {
    let state = 20_260_815;
    const random = (n: number) => { state = (state * 1_103_515_245 + 12_345) % 2_147_483_648; return state % n; };
    f.customer("merge_into", "Kept", "+8801712000001");
    f.customer("merge_from", "Merged", "+8801712000002");
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const id = `rnd_${i}`;
      ids.push(id);
      order(id, {
        createdAt: `2026-08-${String(10 + (i % 9)).padStart(2, "0")}T0${i % 10}:00:00Z`,
        customerId: i % 4 === 0 ? "merge_from" : i % 4 === 1 ? "merge_into" : undefined,
        customerPhone: i % 4 === 2 ? NO_PHONE : undefined,
        currencyCode: i % 5 === 0 ? "USD" : "BDT", status: i % 3 === 0 ? "delivered" : "pending",
        paymentMethod: i % 2 ? "cod" : "stripe", shippingMinor: 60, pricesIncludeTax: i % 2 === 0,
        lines: [
          { id: `${id}_a`, productId: "p_rnd", quantity: 1 + (i % 3), unitMinor: 97 + i, discountMinor: i % 4, taxMinor: i % 5, fulfillmentType: "digital" },
          { id: `${id}_b`, productId: "p_rnd_b", quantity: 2, unitMinor: 51, taxMinor: 3, fulfillmentType: i % 6 === 0 ? "gift_card" : "digital" },
        ],
      });
      if (i % 5 === 0) f.sqlite.prepare("UPDATE orders SET shop_currency = 'BDT', fx_rate = '1.37' WHERE id = ?").run(id);
    }
    const pick = () => ids[random(ids.length)]!;
    const writes: Array<() => void> = [
      () => f.payment({ id: `pay_${random(1e9)}`, orderId: pick(), amountMinor: 1 + random(40), type: "refund", status: random(2) ? "refunded" : "pending" }),
      () => f.sqlite.exec(`UPDATE order_payments SET status = 'refunded' WHERE id = (SELECT id FROM order_payments ORDER BY id LIMIT 1)`),
      () => { const id = pick(); f.returnCase({ id: `ret_${random(1e9)}`, orderId: id, status: random(2) ? "approved" : "completed", lines: [{ itemId: `${id}_a`, approved: 1 }] }); },
      () => f.sqlite.exec(`UPDATE orders SET status = '${["cancelled", "pending", "delivered", "returned", "refunded", "incomplete"][random(6)]}' WHERE id = '${pick()}'`),
      () => f.sqlite.exec(`UPDATE order_items SET line_subtotal_minor = line_subtotal_minor + ${random(30)}, quantity = quantity + ${random(2)} WHERE id = '${pick()}_a'`),
      () => f.sqlite.exec(`UPDATE orders SET fx_rate = '${(0.5 + random(100) / 37).toFixed(4)}' WHERE id = '${pick()}' AND currency_code <> shop_currency`),
      () => f.sqlite.exec(`UPDATE orders SET deleted_at = ${random(2) ? 123 : "NULL"} WHERE id = '${pick()}'`),
      () => f.sqlite.exec("UPDATE orders SET customer_id = 'merge_into' WHERE customer_id = 'merge_from'"),
      () => f.sqlite.exec(`UPDATE orders SET created_at = created_at + ${(random(5) - 2) * 86_400} WHERE id = '${pick()}'`),
      () => f.cod({ orderId: pick(), status: random(2) ? "collected" : "pending" }),
      () => f.sqlite.exec(`DELETE FROM order_items WHERE id = '${pick()}_b'`),
      () => f.sqlite.exec(`UPDATE orders SET prices_include_tax = 1 - prices_include_tax, tax_amount_minor = tax_amount_minor + 1 WHERE id = '${pick()}'`),
    ];
    let applied = 0;
    for (let step = 0; step < 60; step++) {
      try { writes[random(writes.length)]!(); applied++; } catch { /* a write the schema refuses changes nothing */ }
      await assertRollupProjection(f.db);
      if (step % 7 === 0) await sealEveryFactDay(f.db);
    }
    expect(applied).toBeGreaterThan(40);
    await parity(AUGUST, "Asia/Dhaka", "BDT", "previous_period");
  });

  it("changes only the order's fact for COD collection or a refund, and unseals a finished day", async () => {
    order("payment_only");
    f.cod({ orderId: "payment_only", status: "pending" });
    f.payment({ id: "payment_only_refund", orderId: "payment_only", amountMinor: 17, type: "refund", status: "pending" });
    await sealEveryFactDay(f.db);
    trackProjectionWrites();
    for (const [statement, expected] of [
      ["UPDATE cod_tracking SET cod_status = 'collected' WHERE order_id = 'payment_only'",
        [{ name: "analytics_order_facts", n: 1 }, { name: "analytics_sealed_days", n: 1 }]],
      ["UPDATE order_payments SET status = 'refunded' WHERE id = 'payment_only_refund'", [{ name: "analytics_order_facts", n: 1 }]],
    ] as const) {
      f.sqlite.exec("DELETE FROM projection_writes");
      f.sqlite.exec(statement);
      expect(projectionWrites()).toEqual(expected);
      await assertRollupProjection(f.db);
    }
    await parity();
  });
});
