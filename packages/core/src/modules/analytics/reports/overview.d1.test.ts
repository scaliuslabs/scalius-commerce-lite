import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAnalyticsFixture, type AnalyticsFixture } from "./reports.fixture";
import { AUGUST, seedKnownAnswerStore } from "./metrics.fixture-store";
import { createAnalyticsContext } from "./context";
import { getAnalyticsOverview } from "./overview";

let f: AnalyticsFixture;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  f = createAnalyticsFixture();
  seedKnownAnswerStore(f);
});

afterEach(() => {
  f.close();
  vi.restoreAllMocks();
});

async function overview(comparison: "previous_period" | "previous_year" | "none" = "previous_period", granularity: "day" | "week" | "month" = "day") {
  const ctx = await createAnalyticsContext(f.db, "Asia/Dhaka");
  return getAnalyticsOverview(ctx, { range: AUGUST, comparison, granularity });
}

describe("analytics overview on the known-answer store", () => {
  it("adds up the sales of August exactly (gross → discounts → returns → net → shipping → taxes → total)", async () => {
    const { current, currency } = await overview();
    expect(currency).toEqual({ code: "BDT", decimalPlaces: 2 });
    // O1, O2, O3, O8, O10, O12 (O4 cancelled, O5 incomplete, O6 deleted, O7 USD, O9 July, O11 September).
    expect(current.totals).toEqual({
      orders: 6,
      grossSales: 320_000,
      discounts: 16_000,
      returns: 48_000,
      netSales: 256_000,
      shipping: 10_000,
      taxes: 10_700,
      totalSales: 276_700,
      netItemsSold: 8,
      // (320000 − 16000) ÷ 6 = 50666.67 → 50667
      averageOrderValue: 50_667,
    });
    expect(current.otherCurrencyOrders).toBe(1);
  });

  it("measures customers, COD, returns to sender, refunds and cancellations", async () => {
    const { current } = await overview();
    // c1 (two orders), c2, c4, c5 are new; guest +8801799999999 ordered in July.
    expect(current.customers).toEqual({
      customers: 5,
      newCustomers: 4,
      returningCustomers: 1,
      repeatPurchaseRate: 40,
    });
    expect(current.payments.codOrders).toBe(4);
    expect(current.payments.prepaidOrders).toBe(2);
    expect(current.payments.codShare).toBeCloseTo(66.667, 2);
    // O2 came back uncollected; O1 was collected; O10 and O12 are unresolved.
    expect(current.payments.returnedToSender).toBe(1);
    expect(current.payments.codDelivered).toBe(1);
    expect(current.payments.rtsRate).toBe(50);
    // Only the confirmed refund on O3 counts.
    expect(current.payments.refunded).toBe(20_000);
    expect(current.cancellations).toMatchObject({ placed: 7, cancelled: 1 });
    expect(current.cancellations.cancellationRate).toBeCloseTo(14.2857, 3);
  });

  it("buckets on Dhaka calendar days, so the first and last seconds of the month land inside it", async () => {
    const { current } = await overview();
    expect(current.days).toHaveLength(31);
    expect(current.days[0]).toMatchObject({ date: "2026-08-01", orders: 1, totalSales: 50_000 });
    expect(current.days[30]).toMatchObject({ date: "2026-08-31", orders: 1, totalSales: 20_000 });
    expect(current.days.reduce((sum, day) => sum + day.totalSales, 0)).toBe(276_700);
  });

  it("compares with the previous period of equal length and lines up the buckets", async () => {
    const result = await overview("previous_period", "week");
    expect(result.previous?.range).toEqual({ from: "2026-07-01", to: "2026-07-31" });
    // O9: 23000 incl. 3000 tax → gross 20000, total 23000.
    expect(result.previous?.totals).toMatchObject({ orders: 1, grossSales: 20_000, taxes: 3_000, totalSales: 23_000 });
    expect(result.series[0]).toMatchObject({ key: "2026-07-26", from: "2026-08-01", to: "2026-08-01" });
    expect(result.series.reduce((sum, point) => sum + point.current.totalSales, 0)).toBe(276_700);
    expect(result.series.reduce((sum, point) => sum + (point.previous?.measures.totalSales ?? 0), 0)).toBe(23_000);
  });

  it("breaks sales down by channel, payment method, city and delivery zone", async () => {
    const { current } = await overview("none");
    expect(current.breakdowns.channel.map(({ key, label, totalSales }) => ({ key, label, totalSales }))).toEqual([
      { key: "online_store", label: "", totalSales: 256_700 },
      { key: "admin", label: "facebook", totalSales: 20_000 },
    ]);
    expect(current.breakdowns.paymentMethod.map(({ key, orders }) => ({ key, orders }))).toEqual([
      { key: "cod", orders: 4 },
      { key: "sslcommerz", orders: 1 },
      { key: "stripe", orders: 1 },
    ]);
    expect(current.breakdowns.city.find((row) => row.key === "Chattogram")).toMatchObject({ orders: 1, totalSales: 0 });
    expect(current.breakdowns.deliveryZone.map((row) => row.key).sort()).toEqual(["__no_delivery", "__unknown"]);
    expect(current.breakdowns.location).toEqual([
      expect.objectContaining({ key: "loc_default", orders: 6, totalSales: 276_700 }),
    ]);
  });
});
