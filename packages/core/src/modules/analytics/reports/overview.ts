// The Analytics overview: sales KPIs, the sales-over-time series, customer,
// COD and cancellation rates, and breakdowns by channel, payment method,
// city, delivery zone and location, for a range and its comparison period.
//
// A small bucket read chooses each customer path, then one statement per
// period reads UTC summaries and exact facts. The two periods use two of D1's
// six connections; labels and merchant days follow the store's current settings.
import { sql, type SQL } from "drizzle-orm";
import {
  analyticsBuckets,
  analyticsComparisonRange,
  analyticsDateKeyFromEpochDay,
  analyticsInstantRange,
  analyticsBucketKey,
  type AnalyticsComparison,
  type AnalyticsGranularity,
  type AnalyticsRange,
} from "@scalius/shared/analytics-period";
import type { WeekDay } from "@scalius/shared/week-start";
import { merchantDaySql, scopeOffsets, orderMeasuresSql } from "./sales-sql";
import { overviewReadRanges } from "./overview-buckets";
import { num, runAnalyticsQuery, text, type AnalyticsContext } from "./context";

/** Sales measures in integer minor units of the report currency. */
export interface SalesMeasures {
  orders: number;
  grossSales: number;
  discounts: number;
  returns: number;
  netSales: number;
  shipping: number;
  taxes: number;
  totalSales: number;
  netItemsSold: number;
  /** (gross sales − discounts) ÷ orders, rounded to the minor unit; 0 without orders. */
  averageOrderValue: number;
}

export interface OverviewBreakdownRow extends SalesMeasures {
  key: string;
  /** A display name when the key is an id (zone, location) or a sub-label (channel source). */
  label: string;
}

export interface OverviewPeriod {
  range: AnalyticsRange;
  totals: SalesMeasures;
  customers: {
    customers: number;
    newCustomers: number;
    returningCustomers: number;
    /** Customers with two or more sales orders through the period end, % of customers. */
    repeatPurchaseRate: number | null;
  };
  payments: {
    codOrders: number;
    prepaidOrders: number;
    /** % of sales orders paid cash on delivery. */
    codShare: number | null;
    /** COD orders that came back uncollected. */
    returnedToSender: number;
    /** COD orders whose cash was collected or that were delivered. */
    codDelivered: number;
    /** returned-to-sender ÷ (delivered + returned-to-sender), %. */
    rtsRate: number | null;
    /** Money refunded on these orders (confirmed refunds). */
    refunded: number;
  };
  cancellations: {
    /** Orders placed: sales orders plus cancelled orders. */
    placed: number;
    cancelled: number;
    /** % of placed orders cancelled. */
    cancellationRate: number | null;
  };
  /** Orders in the range in a currency other than the report currency: counted here, summed nowhere. */
  otherCurrencyOrders: number;
  /** One row per merchant day of the range (zero-filled). */
  days: Array<{ date: string } & SalesMeasures>;
  breakdowns: {
    channel: OverviewBreakdownRow[];
    paymentMethod: OverviewBreakdownRow[];
    city: OverviewBreakdownRow[];
    deliveryZone: OverviewBreakdownRow[];
    location: OverviewBreakdownRow[];
  };
}

export interface OverviewSeriesPoint {
  /** First day of the bucket (YYYY-MM-DD) and its clipped span. */
  key: string;
  from: string;
  to: string;
  current: SalesMeasures;
  previous: { key: string; from: string; to: string; measures: SalesMeasures } | null;
}

export interface AnalyticsOverview {
  currency: { code: string; decimalPlaces: number };
  granularity: AnalyticsGranularity;
  comparison: AnalyticsComparison;
  current: OverviewPeriod;
  previous: OverviewPeriod | null;
  series: OverviewSeriesPoint[];
}

export interface OverviewInput {
  range: AnalyticsRange;
  comparison: AnalyticsComparison;
  granularity: AnalyticsGranularity;
}

const EMPTY_MEASURES: SalesMeasures = {
  orders: 0,
  grossSales: 0,
  discounts: 0,
  returns: 0,
  netSales: 0,
  shipping: 0,
  taxes: 0,
  totalSales: 0,
  netItemsSold: 0,
  averageOrderValue: 0,
};

export function averageOrderValueMinor(grossSales: number, discounts: number, orders: number): number {
  return orders > 0 ? Math.round((grossSales - discounts) / orders) : 0;
}

export function percentOf(part: number, whole: number): number | null {
  return whole > 0 ? (part / whole) * 100 : null;
}

function measuresOf(row: Record<string, unknown>): SalesMeasures {
  const orders = num(row.orders);
  const grossSales = num(row.gross_sales);
  const discounts = num(row.discounts);
  return {
    orders,
    grossSales,
    discounts,
    returns: num(row.returns),
    netSales: num(row.net_sales),
    shipping: num(row.shipping),
    taxes: num(row.taxes),
    totalSales: num(row.total_sales),
    netItemsSold: num(row.net_items_sold),
    averageOrderValue: averageOrderValueMinor(grossSales, discounts, orders),
  };
}

export function addMeasures(left: SalesMeasures, right: SalesMeasures): SalesMeasures {
  const orders = left.orders + right.orders;
  const grossSales = left.grossSales + right.grossSales;
  const discounts = left.discounts + right.discounts;
  return {
    orders,
    grossSales,
    discounts,
    returns: left.returns + right.returns,
    netSales: left.netSales + right.netSales,
    shipping: left.shipping + right.shipping,
    taxes: left.taxes + right.taxes,
    totalSales: left.totalSales + right.totalSales,
    netItemsSold: left.netItemsSold + right.netItemsSold,
    averageOrderValue: averageOrderValueMinor(grossSales, discounts, orders),
  };
}

const OVERVIEW_FIELDS = [
  "kind",
  "k1",
  "k2",
  "orders",
  "gross_sales",
  "discounts",
  "returns",
  "net_sales",
  "shipping",
  "taxes",
  "total_sales",
  "net_items_sold",
  "x1",
  "x2",
  "x3",
  "x4",
] as const;

const ZEROS = sql.raw("0 as x1, 0 as x2, 0 as x3, 0 as x4");

const ROLLUP_MEASURES = [
  "order_count", "placed", "cancelled", "gross", "disc", "returns", "shipping", "taxes",
  "net_units", "cod", "rts", "cod_delivered", "refunded",
] as const;
const DIMENSIONS = sql.raw(`'["total","channel","payment","city","delivery","location"]'`);
const columns = (alias: string) => sql.raw(ROLLUP_MEASURES.map((name) => `${alias}.${name}`).join(", "));
const sums = (alias: string) => sql.raw(ROLLUP_MEASURES.map((name) => `sum(${alias}.${name}) as ${name}`).join(", "));

function intervalCte(name: string, intervals: readonly (readonly [number, number])[]): SQL {
  return sql`${sql.raw(name)} as (
    select cast(json_extract(value, '$.lo') as bigint) as lo,
      cast(json_extract(value, '$.hi') as bigint) as hi
    from json_each(${JSON.stringify(intervals.map(([lo, hi]) => ({ lo, hi })))})
  )`;
}

function customerCtes(currency: string, start: number, end: number, summarized: boolean): SQL {
  if (summarized) {
    // First, second and last sales can prove membership or an empty interval.
    // Probe only histories whose remaining middle sales could lie in the range.
    return sql`cp as (
      select case when cs.first_sale_at >= ${start} and cs.second_sale_at < ${end} then 2 else 1 end as n,
        case when cs.first_sale_any_currency_at < ${start} then 1 else 0 end as prior
      from analytics_customer_currency_summary cs
      where cs.shop_currency = ${currency} and cs.first_sale_at is not null
        and cs.first_sale_at < ${end} and cs.last_sale_at >= ${start}
        and case
          when cs.first_sale_at >= ${start} then 1
          when cs.last_sale_at < ${end} then 1
          when cs.second_sale_at >= ${end} then 0
          when cs.second_sale_at >= ${start} then 1
          else case when exists (
            select 1 from analytics_order_facts f
            where f.shop_currency = cs.shop_currency and f.identity = cs.identity and f.order_count = 1
              and f.created_at >= ${start} and f.created_at < ${end}
          ) then 1 else 0 end end = 1
    )`;
  }
  return sql`cu as (
      select f.identity, count(*) as n
      from analytics_order_facts f
      where f.shop_currency = ${currency} and f.order_count = 1
        and f.created_at >= ${start} and f.created_at < ${end}
      group by f.identity
    ),
    cp as (
      select cu.n, case when fs.first_sale_at < ${start} then 1 else 0 end as prior
      from cu left join analytics_customer_first_sale fs on fs.identity = cu.identity
    )`;
}

/** UTC totals use daily buckets; only merchant-day boundaries need finer reads. */
function overviewStatement(ctx: AnalyticsContext, range: AnalyticsRange, summarizedCustomers: boolean): SQL {
  const instants = analyticsInstantRange(range, ctx.timeZone);
  const offsets = scopeOffsets(ctx.timeZone, instants);
  const ranges = overviewReadRanges(instants, offsets);
  const currency = ctx.currency.code;
  const measures = orderMeasuresSql("x", true);
  return sql`with
    ${intervalCte("period_edges", ranges.periodEdges)},
    ${intervalCte("quarter_hours", ranges.quarterHours)},
    ${intervalCte("day_edges", ranges.dayEdges)},
    edge_facts as materialized (
      select f.* from period_edges e
      cross join analytics_order_facts f
      where f.created_at >= e.lo and f.created_at < e.hi
    ),
    period_rows as (
      select b.dimension_kind, b.shop_currency, b.key1, b.key2, ${columns("b")}
      from json_each(${DIMENSIONS}) d
      cross join analytics_sales_buckets b
      where b.grain_seconds = 86400 and b.dimension_kind = d.value
        and b.bucket_start >= ${ranges.fullDays[0]} and b.bucket_start < ${ranges.fullDays[1]}
        and (b.shop_currency = ${currency} or b.dimension_kind = 'total')
      union all
      select cast(d.value as text), edge.shop_currency,
        case d.value
          when 'channel' then edge.channel
          when 'payment' then edge.payment_method
          when 'city' then coalesce(edge.city_name, '')
          when 'delivery' then case
            when edge.requires_shipping = 0 then 'none'
            when edge.shipping_method_kind = 'pickup' then 'pickup'
            when edge.shipping_method_id is null then 'unknown'
            else 'method' end
          when 'location' then case when edge.fulfillment_location_id is null then 'default' else 'id' end
          else '' end,
        case d.value
          when 'channel' then coalesce(edge.channel_source, '')
          when 'delivery' then coalesce(edge.shipping_method_id, '')
          when 'location' then coalesce(edge.fulfillment_location_id, '')
          else '' end,
        ${columns("edge")}
      from edge_facts edge cross join json_each(${DIMENSIONS}) d
      where edge.shop_currency = ${currency} or d.value = 'total'
    ),
    px as materialized (
      select dimension_kind, shop_currency, key1, key2, ${sums("r")}
      from period_rows r group by dimension_kind, shop_currency, key1, key2
    ),
    sales as materialized (
      select * from px where shop_currency = ${currency} and order_count > 0
    ),
    day_rows as (
      select ${merchantDaySql("b.bucket_start", offsets)} as day, ${columns("b")}
      from quarter_hours q cross join analytics_sales_buckets b
      where b.grain_seconds = 900 and b.dimension_kind = 'total'
        and b.bucket_start >= q.lo and b.bucket_start < q.hi and b.shop_currency = ${currency}
      union all
      select ${merchantDaySql("f.created_at", offsets)} as day, ${columns("f")}
      from day_edges e cross join analytics_order_facts f
      where f.created_at >= e.lo and f.created_at < e.hi and f.shop_currency = ${currency}
        and f.order_count = 1
    ),
    zones as (
      select s.*,
        case s.key1
          when 'none' then '__no_delivery'
          when 'pickup' then '__pickup'
          when 'unknown' then '__unknown'
          else coalesce(dz.id, '__everywhere_else') end as zone_key,
        coalesce(dz.name, '') as zone_label
      from sales s left join shipping_methods sm on sm.id = s.key2
      left join delivery_zones dz on dz.id = sm.zone_id
      where s.dimension_kind = 'delivery'
    ),
    locations as (
      select s.*, case when s.key1 = 'default' then coalesce((
        select dl.id from inventory_locations dl where dl.is_default = 1
      ), '') else s.key2 end as location_key
      from sales s where s.dimension_kind = 'location'
    ),
    ${customerCtes(currency, instants.start, instants.endExclusive, summarizedCustomers)}
    -- Keep each compound SELECT within D1's five-term limit.
    select * from (
      select 'total' as kind, '' as k1, '' as k2, ${measures},
        coalesce(sum(x.cod), 0) as x1, coalesce(sum(x.rts), 0) as x2,
        coalesce(sum(x.cod_delivered), 0) as x3, coalesce(sum(x.refunded), 0) as x4
      from sales x where x.dimension_kind = 'total'
      union all
      select 'day', cast(x.day as text), '', ${measures}, ${ZEROS}
      from day_rows x group by x.day having sum(x.order_count) > 0
      union all
      select 'channel', x.key1, x.key2, ${measures}, ${ZEROS}
      from sales x where x.dimension_kind = 'channel' group by x.key1, x.key2
      union all
      select 'payment', x.key1, '', ${measures}, ${ZEROS}
      from sales x where x.dimension_kind = 'payment' group by x.key1
      union all
      select 'city', x.key1, '', ${measures}, ${ZEROS}
      from sales x where x.dimension_kind = 'city' group by x.key1
    ) as sales_groups
    union all
    select * from (
      select 'zone' as kind, x.zone_key as k1, x.zone_label as k2, ${measures}, ${ZEROS}
      from zones x group by x.zone_key, x.zone_label
      union all
      select 'location', x.location_key, coalesce(il.name, ''), ${measures}, ${ZEROS}
      from locations x left join inventory_locations il on il.id = x.location_key
      group by x.location_key, coalesce(il.name, '')
      union all
      select 'customers', '', '', count(*), 0, 0, 0, 0, 0, 0, 0, 0,
        coalesce(sum(case when cp.prior = 0 then 1 else 0 end), 0),
        coalesce(sum(cp.prior), 0),
        coalesce(sum(case when cp.prior = 1 or cp.n >= 2 then 1 else 0 end), 0), 0
      from cp
      union all
      select 'placed', '', '',
        coalesce(sum(case when x.shop_currency = ${currency} then x.placed else 0 end), 0),
        0, 0, 0, 0, 0, 0, 0, 0,
        coalesce(sum(case when x.shop_currency = ${currency} then x.cancelled else 0 end), 0),
        coalesce(sum(case when x.shop_currency <> ${currency} then x.placed else 0 end), 0), 0, 0
      from px x where x.dimension_kind = 'total'
    ) as other_groups`;
}

function overviewQuery(ctx: AnalyticsContext, range: AnalyticsRange, summarizedCustomers: boolean) {
  const fields = Object.fromEntries(
    OVERVIEW_FIELDS.map((field) => [field, sql`q.${sql.raw(field)}`]),
  ) as Record<(typeof OVERVIEW_FIELDS)[number], SQL<unknown>>;
  return ctx.db.select(fields).from(sql`(${overviewStatement(ctx, range, summarizedCustomers)}) as q`);
}

/** Summaries bound broad reads and historical prefixes; narrow interior ranges use dated facts. */
async function overviewCustomerStrategies(ctx: AnalyticsContext, current: AnalyticsRange, previous: AnalyticsRange | null): Promise<[boolean, boolean]> {
  const completeDaySales = (range: AnalyticsRange | null): SQL => {
    if (!range) return sql.raw("0");
    const { start, endExclusive } = analyticsInstantRange(range, ctx.timeZone);
    return sql`coalesce(sum(case when b.bucket_start >= ${Math.ceil(start / 86400) * 86400}
      and b.bucket_start < ${Math.floor(endExclusive / 86400) * 86400} then b.order_count else 0 end), 0)`;
  };
  // Complete days are a lower bound, so partial-day facts need no extra read.
  const [row] = await ctx.db.select({
    total: sql`coalesce(sum(b.order_count), 0)`,
    firstSaleDay: sql`min(case when b.order_count > 0 then b.bucket_start end)`,
    current: completeDaySales(current),
    previous: completeDaySales(previous),
  }).from(sql`analytics_sales_buckets b`).where(sql`b.grain_seconds = 86400
    and b.dimension_kind = 'total' and b.shop_currency = ${ctx.currency.code}`);
  const total = num(row?.total);
  const summarize = (range: AnalyticsRange | null, orders: unknown) => {
    if (!range || total === 0) return false;
    // Before the first sales day, every summary reached by first_sale_at < end belongs to the range.
    const prefix = row?.firstSaleDay != null
      && analyticsInstantRange(range, ctx.timeZone).start <= num(row.firstSaleDay);
    // Above a quarter of the store's sales, grouping facts and joining each
    // customer costs more than scanning the covering customer summaries.
    return prefix || num(orders) * 4 >= total;
  };
  return [summarize(current, row?.current), summarize(previous, row?.previous)];
}

function emptyPeriod(range: AnalyticsRange): OverviewPeriod {
  return {
    range,
    totals: { ...EMPTY_MEASURES },
    customers: { customers: 0, newCustomers: 0, returningCustomers: 0, repeatPurchaseRate: null },
    payments: {
      codOrders: 0,
      prepaidOrders: 0,
      codShare: null,
      returnedToSender: 0,
      codDelivered: 0,
      rtsRate: null,
      refunded: 0,
    },
    cancellations: { placed: 0, cancelled: 0, cancellationRate: null },
    otherCurrencyOrders: 0,
    days: [],
    breakdowns: { channel: [], paymentMethod: [], city: [], deliveryZone: [], location: [] },
  };
}

/** Breakdown rows by total sales, largest first; ties by key. */
function sortBreakdown(rows: OverviewBreakdownRow[]): OverviewBreakdownRow[] {
  return rows.sort((left, right) => right.totalSales - left.totalSales || left.key.localeCompare(right.key));
}

export function mapOverviewPeriod(range: AnalyticsRange, rows: readonly Record<string, unknown>[]): OverviewPeriod {
  const period = emptyPeriod(range);
  const dayRows = new Map<string, SalesMeasures>();
  for (const row of rows) {
    const kind = text(row.kind);
    const key = text(row.k1);
    const label = text(row.k2);
    switch (kind) {
      case "total": {
        period.totals = measuresOf(row);
        const codOrders = num(row.x1);
        const rts = num(row.x2);
        const delivered = num(row.x3);
        period.payments = {
          codOrders,
          prepaidOrders: period.totals.orders - codOrders,
          codShare: percentOf(codOrders, period.totals.orders),
          returnedToSender: rts,
          codDelivered: delivered,
          rtsRate: percentOf(rts, rts + delivered),
          refunded: num(row.x4),
        };
        break;
      }
      case "day":
        dayRows.set(analyticsDateKeyFromEpochDay(num(row.k1)), measuresOf(row));
        break;
      case "channel":
        period.breakdowns.channel.push({ key, label, ...measuresOf(row) });
        break;
      case "payment":
        period.breakdowns.paymentMethod.push({ key, label, ...measuresOf(row) });
        break;
      case "city":
        period.breakdowns.city.push({ key, label: key, ...measuresOf(row) });
        break;
      case "zone":
        period.breakdowns.deliveryZone.push({ key, label, ...measuresOf(row) });
        break;
      case "location":
        period.breakdowns.location.push({ key, label, ...measuresOf(row) });
        break;
      case "customers": {
        const customers = num(row.orders);
        period.customers = {
          customers,
          newCustomers: num(row.x1),
          returningCustomers: num(row.x2),
          repeatPurchaseRate: percentOf(num(row.x3), customers),
        };
        break;
      }
      case "placed": {
        const cancelled = num(row.x1);
        const placed = num(row.orders);
        period.cancellations = { placed, cancelled, cancellationRate: percentOf(cancelled, placed) };
        period.otherCurrencyOrders = num(row.x2);
        break;
      }
    }
  }
  period.days = analyticsBuckets(range, "day").map((bucket) => ({
    date: bucket.key,
    ...(dayRows.get(bucket.key) ?? EMPTY_MEASURES),
  }));
  for (const list of Object.values(period.breakdowns)) sortBreakdown(list);
  return period;
}

/** Day rows rolled up into the buckets of a granularity. */
export function rollUpDays(
  range: AnalyticsRange,
  days: OverviewPeriod["days"],
  granularity: AnalyticsGranularity,
  weekStart: WeekDay = 0,
): Array<{ key: string; from: string; to: string; measures: SalesMeasures }> {
  const buckets = analyticsBuckets(range, granularity, weekStart).map((bucket) => ({ ...bucket, measures: { ...EMPTY_MEASURES } }));
  const byKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));
  for (const day of days) {
    const bucket = byKey.get(analyticsBucketKey(day.date, granularity, weekStart));
    if (!bucket) continue;
    const { date: _date, ...measures } = day;
    bucket.measures = addMeasures(bucket.measures, measures);
  }
  return buckets;
}

export async function getAnalyticsOverview(ctx: AnalyticsContext, input: OverviewInput): Promise<AnalyticsOverview> {
  const previousRange = analyticsComparisonRange(input.range, input.comparison);
  const [currentRows, previousRows] = await runAnalyticsQuery("overview", async () => {
    const [currentStrategy, previousStrategy] = await overviewCustomerStrategies(ctx, input.range, previousRange);
    return Promise.all([
      overviewQuery(ctx, input.range, currentStrategy),
      previousRange ? overviewQuery(ctx, previousRange, previousStrategy) : Promise.resolve(null),
    ]);
  });
  const current = mapOverviewPeriod(input.range, currentRows);
  const previous = previousRange && previousRows
    ? mapOverviewPeriod(previousRange, previousRows)
    : null;

  const currentBuckets = rollUpDays(input.range, current.days, input.granularity, ctx.weekStart);
  const previousBuckets = previous && previousRange
    ? rollUpDays(previousRange, previous.days, input.granularity, ctx.weekStart)
    : [];
  return {
    currency: { code: ctx.currency.code, decimalPlaces: ctx.currency.decimalPlaces },
    granularity: input.granularity,
    comparison: previousRange ? input.comparison : "none",
    current,
    previous,
    series: currentBuckets.map((bucket, index) => {
      const counterpart = previousBuckets[index];
      return {
        key: bucket.key,
        from: bucket.from,
        to: bucket.to,
        current: bucket.measures,
        previous: counterpart
          ? { key: counterpart.key, from: counterpart.from, to: counterpart.to, measures: counterpart.measures }
          : null,
      };
    }),
  };
}
