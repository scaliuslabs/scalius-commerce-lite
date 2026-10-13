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

const sum = (name: string) => integer(name).notNull().default(0);

// Private synchronous projection (@scalius/database/analytics-rollup): the
// order's own state plus running sums of its lines, moved by deltas. Report
// measures are derived on read; labels and the store time zone too.
export const analyticsOrderFacts = sqliteTable("analytics_order_facts", {
  orderId: text("order_id").primaryKey().references(() => orders.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull(),
  shopCurrency: text("shop_currency").notNull(),
  /** `c:<customer id>`, else `o:<order id>`: never a phone number. */
  identity: text("identity").notNull(),
  channel: text("channel").notNull(),
  channelSource: text("channel_source"),
  paymentMethod: text("payment_method").notNull(),
  cityName: text("city_name"),
  shippingMethodId: text("shipping_method_id"),
  shippingMethodKind: text("shipping_method_kind"),
  requiresShipping: integer("requires_shipping").notNull(),
  fulfillmentLocationId: text("fulfillment_location_id"),
  /** A sales order: live, not incomplete or cancelled. */
  orderCount: sum("order_count"),
  placed: sum("placed"),
  cancelled: sum("cancelled"),
  /** Returned or refunded in full. */
  reversed: sum("reversed"),
  /** Status delivered or completed. */
  delivered: sum("delivered"),
  incl: sum("incl"),
  /** The order's locked rate text and decimal-place shift to the shop currency; the shift is null when sold in it. */
  fxRate: text("fx_rate"),
  fxShift: integer("fx_shift"),
  /** Order amounts in shop-currency minor units. */
  orderShipping: sum("order_shipping"),
  orderDiscount: sum("order_discount"),
  orderTax: sum("order_tax"),
  /** Sums over the order's lines, each converted per line (gift cards only in the `_all` sums). */
  lineGross: sum("line_gross"),
  lineDisc: sum("line_disc"),
  lineReturns: sum("line_returns"),
  lineKeptTax: sum("line_kept_tax"),
  lineUnits: sum("line_units"),
  lineRevReturns: sum("line_rev_returns"),
  lineRevKeptTax: sum("line_rev_kept_tax"),
  lineDiscAll: sum("line_disc_all"),
  lineTaxAll: sum("line_tax_all"),
  /** Confirmed refunds in order-currency minor units (converted once, on read). */
  refundSum: sum("refund_sum"),
  codCollected: sum("cod_collected"),
}, (t) => [
  index("analytics_facts_range_idx").on(t.createdAt, t.shopCurrency),
  index("analytics_facts_customer_range_idx").on(t.shopCurrency, t.createdAt, t.identity).where(sql`${t.orderCount} = 1`),
  index("analytics_facts_identity_idx").on(t.identity, t.createdAt).where(sql`${t.orderCount} = 1`),
]);

/** Read only for sealed days: maintenance writes a day's rows when it seals the day. */
export const analyticsSalesBuckets = sqliteTable("analytics_sales_buckets", {
  grainSeconds: integer("grain_seconds").notNull(),
  dimensionKind: text("dimension_kind").notNull(),
  bucketStart: integer("bucket_start").notNull(),
  shopCurrency: text("shop_currency").notNull(),
  key1: text("key1").notNull(),
  key2: text("key2").notNull(),
  ...measures(),
}, (t) => [primaryKey({ columns: [t.grainSeconds, t.dimensionKind, t.bucketStart, t.shopCurrency, t.key1, t.key2] })]);

/** UTC day starts whose buckets equal their facts; a write to such a day's facts deletes its row. */
export const analyticsSealedDays = sqliteTable("analytics_sealed_days", {
  day: integer("day").primaryKey(),
});
