import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANALYTICS_REPORTS, type AnalyticsReportId } from "@scalius/shared/analytics-reports";
import { createSqliteTursoDatabase } from "@scalius/database/testing/sqlite-d1";
import { createAnalyticsFixture, type AnalyticsFixture } from "./reports.fixture";
import { AUGUST, seedKnownAnswerExtras, seedKnownAnswerStore } from "./metrics.fixture-store";
import { createAnalyticsContext } from "./context";
import {
  exportAnalyticsReportCsv,
  getAnalyticsOverviewForRequest,
  getAnalyticsReportPage,
  listAnalyticsReports,
  type AnalyticsAccess,
  type ReportRequest,
} from "./service";

const NOW = new Date("2026-09-01T06:00:00+06:00");
const FULL_ACCESS: AnalyticsAccess = { customers: true, costs: true };
let f: AnalyticsFixture;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  f = createAnalyticsFixture();
  seedKnownAnswerStore(f);
  seedKnownAnswerExtras(f);
});

afterEach(() => {
  f.close();
  vi.restoreAllMocks();
});

async function report(id: AnalyticsReportId, query: ReportRequest = {}, access: AnalyticsAccess = FULL_ACCESS) {
  const ctx = await createAnalyticsContext(f.db, NOW);
  return getAnalyticsReportPage(ctx, id, { ...AUGUST, pageSize: 100, ...query }, access);
}

function byId<T extends { id: string }>(rows: readonly T[]) {
  return Object.fromEntries(rows.map((row) => [row.id, row]));
}

describe("sales reports on the known-answer store", () => {
  it("sales by product splits line measures and adds up to the line totals", async () => {
    const page = await report("sales_by_product");
    expect(page.rows.map((row) => row.values.product)).toEqual(["Panjabi", "Tee", "Wallet", "Perfume", "Saree"]);
    expect(page.rows[0]).toMatchObject({
      id: "prod_a",
      productId: "prod_a",
      values: {
        orders: 3, net_items_sold: 4, gross_sales: 200_000, discounts: 10_000, returns: 0,
        net_sales: 190_000, taxes: 5_000, total_sales: 195_000,
      },
    });
    // Tee: one of three returned → returns (60000 − 6000) ÷ 3 = 18000, kept tax 5400 − 1800.
    expect(byId(page.rows).prod_c?.values).toMatchObject({
      net_items_sold: 2, gross_sales: 60_000, discounts: 6_000, returns: 18_000, net_sales: 36_000, taxes: 3_600, total_sales: 39_600,
    });
    // The parcel came back: the whole sale reversed.
    expect(byId(page.rows).prod_b?.values).toMatchObject({ net_items_sold: 0, gross_sales: 30_000, returns: 30_000, net_sales: 0 });
    // The gift card line is not merchandise; distinct orders don't add up across products.
    expect(page.rows.some((row) => row.id === "prod_gc")).toBe(false);
    expect(page.totals).toMatchObject({
      orders: null, net_items_sold: 8, gross_sales: 320_000, discounts: 16_000, returns: 48_000,
      net_sales: 256_000, taxes: 10_100, total_sales: 266_100,
    });
    expect(page.totalRows).toBe(5);
  });

  it("pages and sorts in the database, with totals over every row", async () => {
    const first = await report("sales_by_product", { pageSize: 2, sort: "product", direction: "asc" });
    expect(first.rows.map((row) => row.values.product)).toEqual(["Panjabi", "Perfume"]);
    expect(first.totalRows).toBe(5);
    expect(first.totals.net_sales).toBe(256_000);
    const third = await report("sales_by_product", { pageSize: 2, page: 3, sort: "product", direction: "asc" });
    expect(third.rows.map((row) => row.values.product)).toEqual(["Wallet"]);
    const beyond = await report("sales_by_product", { pageSize: 2, page: 9 });
    expect(beyond.rows).toEqual([]);
    expect(beyond.totals.net_sales).toBe(256_000);
    // An unknown sort column falls back to the report default.
    expect((await report("sales_by_product", { sort: "nope" })).sort).toEqual({ key: "net_sales", direction: "desc" });
  });

  it("groups by category, brand and variant", async () => {
    const categories = byId((await report("sales_by_category")).rows);
    expect(categories.cat_shirts?.values).toMatchObject({ category: "Shirts", net_sales: 226_000 });
    expect(categories[""]?.values).toMatchObject({ category: "", net_sales: 30_000 });
    const brands = byId((await report("sales_by_brand")).rows);
    expect(brands.brd_aarong?.values).toMatchObject({ brand: "Aarong", net_sales: 190_000 });
    const variants = byId((await report("sales_by_variant")).rows);
    expect(variants.var_c?.values).toMatchObject({ product: "Tee", sku: "TEE-1", net_items_sold: 2 });
  });

  it("attributes collection sales by today's membership, manual and dynamic", async () => {
    f.sqlite.prepare(`INSERT INTO collections (id, name, presentation, config, is_active) VALUES (?, ?, 'grid', ?, 1)`)
      .run("col_manual", "Eid picks", JSON.stringify({ source: "manual", productIds: ["prod_a", "prod_d"], categoryIds: [] }));
    f.sqlite.prepare(`INSERT INTO collections (id, name, presentation, config, is_active) VALUES (?, ?, 'grid', ?, 1)`)
      .run("col_shirts", "All shirts", JSON.stringify({ source: "dynamic", productIds: [], categoryIds: ["cat_shirts"] }));
    const rows = byId((await report("sales_by_collection")).rows);
    expect(rows.col_manual?.values).toMatchObject({ collection: "Eid picks", net_sales: 200_000, net_items_sold: 5 });
    expect(rows.col_shirts?.values).toMatchObject({ collection: "All shirts", net_sales: 226_000, net_items_sold: 6 });
  });

  it("reports discounts by promotion code, with discounts that have no promotion in one row", async () => {
    const rows = byId((await report("sales_by_discount")).rows);
    expect(rows["promo_1|EID10"]?.values).toMatchObject({
      discount: "Eid sale", code: "EID10", method: "code", orders: 1, discount_amount: 10_000,
      gross_sales: 100_000, net_sales: 90_000, total_sales: 96_000,
    });
    expect(rows.__manual?.values).toMatchObject({
      method: "manual", orders: 1, discount_amount: 8_000, gross_sales: 110_000, net_sales: 86_000, total_sales: 99_200,
    });
  });

  it("breaks orders down by channel, payment method, city, delivery zone and location", async () => {
    const channels = byId((await report("sales_by_channel")).rows);
    // (300000 − 16000) ÷ 5
    expect(channels["online_store|"]?.values).toMatchObject({ orders: 5, total_sales: 256_700, average_order_value: 56_800 });
    expect(channels["admin|facebook"]?.values).toMatchObject({ channel: "admin", source: "facebook", total_sales: 20_000 });
    const methods = await report("sales_by_payment_method");
    expect(byId(methods.rows).cod?.values).toMatchObject({ orders: 4, total_sales: 166_000 });
    expect(methods.totals).toMatchObject({ orders: 6, total_sales: 276_700, average_order_value: 50_667 });
    const cities = byId((await report("sales_by_city")).rows);
    expect(cities.Dhaka?.values).toMatchObject({ orders: 4 });
    expect(cities.Chattogram?.values).toMatchObject({ orders: 1, total_sales: 0 });
    expect(cities[""]?.values).toMatchObject({ orders: 1, total_sales: 11_500 });
    const zones = byId((await report("sales_by_delivery_zone")).rows);
    expect(zones["__no_delivery|"]?.values).toMatchObject({ delivery_zone: "__no_delivery", orders: 1 });
    const locations = (await report("sales_by_location")).rows;
    expect(locations).toEqual([expect.objectContaining({ id: "loc_default", values: expect.objectContaining({ location: "Main location", orders: 6 }) })]);
  });

  it("buckets sales over time on store days and weeks", async () => {
    const days = await report("sales_over_time", { granularity: "day" });
    expect(days.rows).toHaveLength(31);
    expect(days.rows[0]?.values).toMatchObject({ period: "2026-08-01", orders: 1, total_sales: 50_000 });
    expect(days.totals).toMatchObject({ orders: 6, total_sales: 276_700, average_order_value: 50_667 });
    const weeks = await report("sales_over_time", { granularity: "week" });
    // Sunday weeks: 26 Jul (holds 1 Aug) … 30 Aug (holds 30–31 Aug).
    expect(weeks.rows.map((row) => row.id)).toEqual(["2026-07-26", "2026-08-02", "2026-08-09", "2026-08-16", "2026-08-23", "2026-08-30"]);
    expect(weeks.rows.reduce((sum, row) => sum + Number(row.values.total_sales), 0)).toBe(276_700);
    const months = await report("sales_over_time", { from: "2026-07-01", to: "2026-08-31", granularity: "month" });
    expect(months.rows.map((row) => [row.id, row.values.total_sales])).toEqual([["2026-07-01", 23_000], ["2026-08-01", 276_700]]);
  });
});

describe("customer reports", () => {
  it("ranks customers by sales with their first order ever", async () => {
    const page = await report("customers_top");
    expect(page.rows[0]).toMatchObject({
      id: "c:c1",
      values: { customer: "Buyer", phone: "+8801711000001", orders: 2, total_sales: 195_200, first_order: "2026-08-05", last_order: "2026-08-10" },
    });
    expect(byId(page.rows)["p:+8801799999999"]?.values).toMatchObject({ orders: 1, first_order: "2026-07-31" });
  });

  it("refuses to name customers without the View customers permission", async () => {
    await expect(report("customers_top", {}, { customers: false, costs: true })).rejects.toMatchObject({ status: 403 });
    // Counts of new and returning customers name no one.
    await expect(report("customers_over_time", {}, { customers: false, costs: true })).resolves.toBeDefined();
  });

  it("counts new and returning customers per bucket", async () => {
    const days = byId((await report("customers_over_time", { granularity: "day" })).rows);
    expect(days["2026-08-05"]?.values).toMatchObject({ customers: 1, new_customers: 1, returning_customers: 0, new_customer_sales: 96_000 });
    expect(days["2026-08-10"]?.values).toMatchObject({ customers: 1, new_customers: 0, returning_customers: 1 });
    expect(days["2026-08-20"]?.values).toMatchObject({ new_customers: 0, returning_customers: 1 });
    const month = await report("customers_over_time", { granularity: "month" });
    // c1 counts once in the month even with two orders.
    expect(month.rows[0]?.values).toMatchObject({ customers: 5, new_customers: 4, returning_customers: 1, orders: 6 });
  });
});

describe("inventory reports", () => {
  it("values stock on hand per location", async () => {
    const page = await report("inventory_by_location");
    expect(page.rows[0]).toMatchObject({ id: "loc_default", values: { skus: 4, units_on_hand: 17, retail_value: 623_000 } });
    expect((await report("inventory_on_hand")).totalRows).toBe(4);
  });

  it("lists SKUs that need restocking with their recent pace", async () => {
    const rows = byId((await report("inventory_low_stock")).rows);
    expect(Object.keys(rows).sort()).toEqual(["var_b", "var_c"]);
    // Three Tees sold since 2 August; four left last 4 × 30 ÷ 3 = 40 days.
    expect(rows.var_c?.values).toMatchObject({ available: 4, threshold: 5, units_sold_30_days: 3, days_of_cover: 40 });
    expect(rows.var_c?.productId).toBe("prod_c");
  });

  it("measures sell-through and days of cover over the range", async () => {
    const page = await report("inventory_sell_through");
    const rows = byId(page.rows);
    expect(rows.var_a?.values.units_sold).toBe(4);
    expect(rows.var_a?.values.sell_through_rate).toBeCloseTo(28.571, 2);
    expect(rows.var_e?.values).toMatchObject({ units_sold: 1, units_on_hand: 1, sell_through_rate: 50, days_of_cover: 31 });
    expect(rows.var_b?.values).toMatchObject({ units_sold: 0, sell_through_rate: null, days_of_cover: null });
    expect(page.totals).toMatchObject({ units_sold: 8, units_on_hand: 17 });
  });
});

describe("finance, tax and operations reports", () => {
  it("lists payment records and refunds of the range's orders", async () => {
    const payments = byId((await report("finance_payments")).rows);
    expect(payments["sslcommerz|payment|confirmed"]?.values).toMatchObject({ transactions: 1, amount: 119_000 });
    expect(payments["sslcommerz|refund|refunded"]?.values).toMatchObject({ amount: 20_000 });
    const refunds = (await report("finance_refunds")).rows;
    expect(refunds).toEqual([{ id: "sslcommerz", values: { payment_method: "sslcommerz", orders: 1, refunds: 2, refunded: 20_000, pending: 5_000, failed: 0 } }]);
  });

  it("splits cash on delivery into collected, outstanding and returned", async () => {
    const page = await report("finance_cod");
    const rows = byId(page.rows);
    expect(rows.collected?.values).toMatchObject({ orders: 1, order_value: 96_000, collected: 96_000, outstanding: 0 });
    expect(rows.with_courier?.values).toMatchObject({ orders: 1, order_value: 50_000, outstanding: 50_000 });
    expect(rows.not_shipped?.values).toMatchObject({ orders: 1, order_value: 120_000, outstanding: 120_000 });
    expect(rows.returned_to_sender?.values).toMatchObject({ orders: 1, order_value: 36_000, outstanding: 0 });
    expect(page.totals).toMatchObject({ orders: 4, collected: 96_000, outstanding: 170_000 });
  });

  it("reports gift card liability, issues and redemptions", async () => {
    const rows = Object.fromEntries((await report("finance_gift_cards")).rows.map((row) => [row.values.measure, row.values]));
    expect(rows.outstanding_balance).toMatchObject({ cards: 1, amount: 30_000 });
    expect(rows.issued_manual).toMatchObject({ cards: 1, amount: 50_000 });
    expect(rows.redeemed).toMatchObject({ cards: 1, amount: 20_000 });
    expect(rows.unusable_balance).toMatchObject({ cards: 0, amount: 0 });
  });

  it("reports tax kept on sales and on shipping", async () => {
    const rows = byId((await report("taxes")).rows);
    expect(rows[""]?.values).toMatchObject({ taxable_sales: 256_000, tax_collected: 10_100 });
    expect(rows.__shipping?.values).toMatchObject({ taxable_sales: 10_000, tax_collected: 600 });
  });

  it("measures couriers: outcomes, rates and days to dispatch and to collect", async () => {
    const rows = byId((await report("delivery_performance")).rows);
    expect(rows.Pathao?.values).toMatchObject({ parcels: 2, delivered: 1, returned: 1, delivery_rate: 50, return_rate: 50, average_days_to_dispatch: 1 });
    expect(rows.Pathao?.values.average_days_to_collect).toBeCloseTo(26 / 24, 5);
    expect(rows.Steadfast?.values).toMatchObject({ parcels: 1, in_transit: 1, delivery_rate: null });
  });

  it("counts abandoned checkouts recovered by an order from the same phone within a week", async () => {
    const page = await report("abandoned_checkouts", { granularity: "month" });
    expect(page.rows[0]?.values).toMatchObject({ abandoned_checkouts: 3, reachable: 2, recovered: 1, recovery_rate: 50, recovered_sales: 120_000 });
    // 1 August is more than 30 days before "now": the oldest checkouts may already be cleaned up.
    expect(page.notes).toEqual(["abandoned_retention"]);
    const recent = await report("abandoned_checkouts", { from: "2026-08-15", to: "2026-08-31", granularity: "week" });
    expect(recent.notes).toEqual([]);
    expect(recent.totals).toMatchObject({ abandoned_checkouts: 2, reachable: 1, recovered: 1, recovery_rate: 100 });
  });
});

describe("profit (unit costs recorded at the time of sale)", () => {
  it("uses only the sale-time cost and reports coverage", async () => {
    const ctx = await createAnalyticsContext(f.db, NOW);
    expect((await listAnalyticsReports(ctx, FULL_ACCESS)).find((entry) => entry.id === "profit_by_product"))
      .toMatchObject({ available: true, unavailableReason: null });
    f.sqlite.exec("UPDATE order_items SET unit_cost_minor = 30000 WHERE product_id = 'prod_a'");
    const page = await report("profit_by_product");
    expect(byId(page.rows).prod_a?.values).toMatchObject({
      net_items_sold: 4, costed_items: 4, net_sales: 190_000, cost_of_goods: 120_000, gross_profit: 70_000, cost_coverage: 100,
    });
    expect(byId(page.rows).prod_a?.values.gross_margin).toBeCloseTo(36.842, 2);
    // Tee has no recorded cost: no cost, no profit, 0% coverage (never today's cost).
    expect(byId(page.rows).prod_c?.values).toMatchObject({ costed_items: 0, cost_of_goods: 0, gross_profit: 0, gross_margin: null, cost_coverage: 0 });
    expect(page.totals).toMatchObject({ costed_items: 4, net_items_sold: 8, cost_coverage: 50 });
  });

  it("needs the View product costs permission", async () => {
    const ctx = await createAnalyticsContext(f.db, NOW);
    const noCosts: AnalyticsAccess = { customers: true, costs: false };
    expect((await listAnalyticsReports(ctx, noCosts)).find((entry) => entry.id === "profit_by_product"))
      .toMatchObject({ available: false, unavailableReason: "cost_access" });
    await expect(report("profit_by_product", {}, noCosts)).rejects.toMatchObject({ status: 403 });
    await expect(exportAnalyticsReportCsv(ctx, "profit_by_product", { ...AUGUST }, noCosts)).rejects.toMatchObject({ status: 403 });
    // Sales reports carry no costs.
    await expect(report("sales_by_product", {}, noCosts)).resolves.toBeDefined();
  });
});

describe("CSV export", () => {
  it("writes headings with the currency, decimal amounts and a totals row", async () => {
    const ctx = await createAnalyticsContext(f.db, NOW);
    const result = await exportAnalyticsReportCsv(ctx, "sales_by_product", { ...AUGUST }, FULL_ACCESS);
    const csv = result.artifact.chunks.join("");
    expect(csv.startsWith("﻿\"Product\",\"Orders\",\"Net items sold\",\"Gross sales (BDT)\"")).toBe(true);
    expect(csv).toContain("\"Panjabi\",\"3\",\"4\",\"2000.00\",\"100.00\",\"0.00\",\"1900.00\",\"50.00\",\"1950.00\"");
    expect(csv.trim().split("\n").at(-1)).toBe("\"Total\",\"\",\"8\",\"3200.00\",\"160.00\",\"480.00\",\"2560.00\",\"101.00\",\"2661.00\"");
    expect(result).toMatchObject({ totalRows: 5, truncatedBy: "none", filename: "sales-by-product-2026-08-01_2026-08-31.csv" });
    expect(result.artifact.rowCount).toBe(6);
  });

  it("words enums and placeholders in English", async () => {
    const ctx = await createAnalyticsContext(f.db, NOW);
    const csv = (await exportAnalyticsReportCsv(ctx, "finance_cod", { ...AUGUST }, FULL_ACCESS)).artifact.chunks.join("");
    expect(csv).toContain("\"Returned to sender\"");
    const zones = (await exportAnalyticsReportCsv(ctx, "sales_by_delivery_zone", { ...AUGUST }, FULL_ACCESS)).artifact.chunks.join("");
    expect(zones).toContain("\"No delivery\"");
  });

  it("refuses customer exports without the permission", async () => {
    const ctx = await createAnalyticsContext(f.db, NOW);
    await expect(exportAnalyticsReportCsv(ctx, "customers_top", { ...AUGUST }, { customers: false, costs: true })).rejects.toMatchObject({ status: 403 });
  });
});

describe("TursoDB parity", () => {
  it("answers the overview and every report exactly as D1 on the same rows", async () => {
    const turso = createSqliteTursoDatabase(f.sqlite);
    const [onD1, onTurso] = await Promise.all([
      createAnalyticsContext(f.db, NOW),
      createAnalyticsContext(turso, NOW),
    ]);
    expect(await getAnalyticsOverviewForRequest(onTurso, { ...AUGUST })).toEqual(await getAnalyticsOverviewForRequest(onD1, { ...AUGUST }));
    for (const definition of ANALYTICS_REPORTS) {
      if (definition.id === "profit_by_product") continue;
      const query = { ...AUGUST, pageSize: 100 };
      expect(await getAnalyticsReportPage(onTurso, definition.id, query, FULL_ACCESS), definition.id)
        .toEqual(await getAnalyticsReportPage(onD1, definition.id, query, FULL_ACCESS));
    }
  });
});
