import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { orders } from "./orders";

const measures = () => ({
  orderCount: integer("order_count").notNull().default(0),
  placed: integer("placed").notNull().default(0),
  cancelled: integer("cancelled").notNull().default(0),
  gross: integer("gross").notNull().default(0),
  disc: integer("disc").notNull().default(0),
  returns: integer("returns").notNull().default(0),
  shipping: integer("shipping").notNull().default(0),
  taxes: integer("taxes").notNull().default(0),
  netUnits: integer("net_units").notNull().default(0),
  cod: integer("cod").notNull().default(0),
  rts: integer("rts").notNull().default(0),
  codDelivered: integer("cod_delivered").notNull().default(0),
  refunded: integer("refunded").notNull().default(0),
});

// Private synchronous projections. Mutable labels and store time zone are resolved on reads.
export const analyticsOrderFacts = sqliteTable("analytics_order_facts", {
  orderId: text("order_id").primaryKey().references(() => orders.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull(),
  shopCurrency: text("shop_currency").notNull(),
  identity: text("identity").notNull(),
  channel: text("channel").notNull(),
  channelSource: text("channel_source"),
  paymentMethod: text("payment_method").notNull(),
  cityName: text("city_name"),
  shippingMethodId: text("shipping_method_id"),
  shippingMethodKind: text("shipping_method_kind"),
  requiresShipping: integer("requires_shipping").notNull(),
  fulfillmentLocationId: text("fulfillment_location_id"),
  ...measures(),
}, (t) => [
  index("analytics_facts_range_idx").on(t.createdAt, t.shopCurrency),
  index("analytics_facts_customer_range_idx").on(t.shopCurrency, t.createdAt, t.identity).where(sql`${t.orderCount} = 1`),
  index("analytics_facts_customer_identity_idx").on(t.shopCurrency, t.identity, t.createdAt).where(sql`${t.orderCount} = 1`),
  index("analytics_facts_first_sale_idx").on(t.identity, t.createdAt, t.orderId).where(sql`${t.orderCount} = 1`),
]);

export const analyticsSalesBuckets = sqliteTable("analytics_sales_buckets", {
  grainSeconds: integer("grain_seconds").notNull(),
  dimensionKind: text("dimension_kind").notNull(),
  bucketStart: integer("bucket_start").notNull(),
  shopCurrency: text("shop_currency").notNull(),
  key1: text("key1").notNull(),
  key2: text("key2").notNull(),
  ...measures(),
}, (t) => [primaryKey({ columns: [t.grainSeconds, t.dimensionKind, t.bucketStart, t.shopCurrency, t.key1, t.key2] })]);

export const analyticsCustomerFirstSale = sqliteTable("analytics_customer_first_sale", {
  identity: text("identity").primaryKey(),
  firstSaleAt: integer("first_sale_at"),
});

// Exact broad-period customer membership/repeats, with facts consulted only across both edges.
export const analyticsCustomerCurrencySummary = sqliteTable("analytics_customer_currency_summary", {
  identity: text("identity").notNull(),
  shopCurrency: text("shop_currency").notNull(),
  firstSaleAt: integer("first_sale_at"),
  secondSaleAt: integer("second_sale_at"),
  lastSaleAt: integer("last_sale_at"),
  firstSaleAnyCurrencyAt: integer("first_sale_any_currency_at"),
}, (t) => [
  primaryKey({ columns: [t.identity, t.shopCurrency] }),
  index("analytics_customer_currency_range_idx").on(t.shopCurrency, t.firstSaleAt, t.lastSaleAt, t.secondSaleAt, t.firstSaleAnyCurrencyAt, t.identity)
    .where(sql`${t.firstSaleAt} IS NOT NULL`),
]);
