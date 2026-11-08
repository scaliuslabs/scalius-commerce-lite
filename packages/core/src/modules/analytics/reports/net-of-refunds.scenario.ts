// Test-only: one store where money went back with no goods returned, as
// portable SQL every provider runs, and the figures every reader must give.
// Shared by the D1 and PostgreSQL tests, so net sales = gross − refunds is
// pinned on both.
import { expect } from "vitest";
import type { Database } from "@scalius/database/client";
import { getDailyActivityData } from "../dashboard.service";
import { createAnalyticsContext } from "./context";
import { getAnalyticsOverview } from "./overview";
import { getAnalyticsReportPage } from "./service";
import { sealEveryFactDay } from "./overview-rollup.assertions";

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
/** 10 August 2026, noon in Dhaka. */
const PLACED = at("2026-08-10T12:00:00+06:00");
const RANGE = { from: "2026-08-01", to: "2026-08-31" } as const;
const NOW = new Date("2026-08-20T12:00:00+06:00");

function order(id: string, status: string, paymentMethod: string, refundMinor: number): string[] {
  // Two Kurtas at ৳500 (৳1,000 merchandise) and ৳60 delivery: ৳1,060, paid in full.
  return [
    `INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, city_name,
      currency_code, subtotal_amount_minor, shipping_amount_minor, discount_amount_minor, tax_amount_minor, total_amount_minor,
      shop_currency, subtotal_shop_minor, shipping_shop_minor, discount_shop_minor, tax_shop_minor, total_shop_minor,
      prices_include_tax, status, payment_method, payment_status, paid_amount_minor, balance_due_minor,
      fulfillment_status, requires_shipping, channel, created_at, updated_at)
    VALUES ('${id}', 'Buyer', '+8801711000000', 'Road 1', 'city_dhaka', 'zone_1', 'Dhaka',
      'BDT', 100000, 6000, 0, 0, 106000, 'BDT', 100000, 6000, 0, 0, 106000,
      0, '${status}', '${paymentMethod}', 'partially_refunded', ${106000 - refundMinor}, 0,
      'complete', 1, 'online_store', ${PLACED}, ${PLACED})`,
    `INSERT INTO order_items (id, order_id, product_id, quantity, product_name, unit_price_minor, line_subtotal_minor,
      discount_amount_minor, taxable_amount_minor, tax_amount_minor, fulfillment_type, fulfilled_quantity, created_at)
    VALUES ('${id}_line', '${id}', 'prod_kurta', 2, 'Kurta', 50000, 100000, 0, 100000, 0, 'ship', 2, ${PLACED})`,
    `INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status, created_at, updated_at)
    VALUES ('${id}_paid', '${id}', 106000, 'BDT', '${paymentMethod}', 'full', 'succeeded', ${PLACED}, ${PLACED})`,
    `INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status, created_at, updated_at)
    VALUES ('${id}_refund', '${id}', ${refundMinor}, 'BDT', '${paymentMethod}', 'refund', 'refunded', ${PLACED + 3600}, ${PLACED + 3600})`,
  ];
}

/** The store: a ৳850 goodwill refund (n1), and a ৳1,030 refund, more than the order's ৳1,000 of goods (n2). */
export const NET_OF_REFUNDS_STATEMENTS: readonly string[] = [
  `INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('prod_kurta', 'Kurta', 'kurta', 50000, 1)`,
  ...order("n1", "delivered", "stripe", 85_000),
  ...order("n2", "delivered", "cod", 103_000),
];

/**
 * Every sales figure is net of the money given back: the overview read from
 * facts and from sealed buckets, a live report and Home's revenue.
 */
export async function assertNetOfRefunds(db: Database): Promise<void> {
  const expected = {
    orders: 2,
    grossSales: 200_000,
    discounts: 0,
    // n1 gave back ৳850 of ৳1,000; n2 gave back more than its ৳1,000 of goods: all of them.
    returns: 185_000,
    netSales: 15_000,
    shipping: 12_000,
    taxes: 0,
    totalSales: 27_000,
  };
  const ctx = await createAnalyticsContext(db, "Asia/Dhaka", NOW);
  const read = async () => (await getAnalyticsOverview(ctx, { range: RANGE, comparison: "none", granularity: "day" })).current;
  const fromFacts = await read();
  expect(fromFacts.totals).toMatchObject(expected);
  expect(fromFacts.totals.netSales).toBe(fromFacts.totals.grossSales - fromFacts.totals.discounts - fromFacts.totals.returns);
  expect(fromFacts.payments.refunded).toBe(188_000);

  // The live reports share the rule.
  const byChannel = await getAnalyticsReportPage(ctx, "sales_by_channel", { ...RANGE, pageSize: 10 }, { customers: true, costs: true });
  expect(byChannel.totals).toMatchObject({ gross_sales: 200_000, returns: 185_000, net_sales: 15_000, total_sales: 27_000 });

  // Home's revenue is the overview's total sales.
  const days = await getDailyActivityData(db, 20, "Asia/Dhaka", NOW);
  expect(days.find((day) => day.date === "2026-08-10")).toMatchObject({ orders: 2, revenue: 270 });

  // Sealed buckets give the same figures.
  await sealEveryFactDay(db);
  expect((await read()).totals).toMatchObject(expected);
}
