// The Analytics overview: sales KPIs, the sales-over-time series, customer,
// COD and cancellation rates, and breakdowns by channel, payment method,
// city, delivery zone and location, for a range and its comparison period.
//
// One statement per period: the per-order metrics (`om`, see sales-sql.ts)
// are computed once and grouped several ways with UNION ALL, so a period is
// one pass over its orders and lines, both periods run concurrently (two of
// D1's six connections), and nothing is read twice.
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
import {
  hasPriorSalesOrderSql,
  merchantDaySql,
  scopeOffsets,
  orderIdentitySql,
  orderMeasuresSql,
  orderMetricsCtes,
  salesLinesCtes,
  salesOrdersCte,
  shopMinorSql,
  type SalesScope,
} from "./sales-sql";
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

/** The single statement for one period (see the file comment). */
function overviewStatement(ctx: AnalyticsContext, range: AnalyticsRange): SQL {
  const instants = analyticsInstantRange(range, ctx.timeZone);
  const scope: SalesScope = { ...instants, currency: ctx.currency.code };
  const measures = orderMeasuresSql("ox");
  return sql`with ${salesOrdersCte(scope)},
    ${salesLinesCtes()},
    ${orderMetricsCtes()},
    -- Materialized explicitly: SQLite otherwise inlines a CTE into every
    -- compound branch and re-reads the period's orders once per grouping.
    -- Only the columns the groupings read.
    ox as materialized (
      select om.status, om.payment_method, om.channel, om.channel_source, om.city_name,
        om.gross, om.disc, om.returns, om.shipping, om.taxes, om.net_units,
        ${merchantDaySql("om.created_at", scopeOffsets(ctx.timeZone, instants))} as day,
        ${orderIdentitySql("om")} as identity,
        om.customer_id, om.customer_phone,
        case when om.payment_method = 'cod' then 1 else 0 end as cod,
        case when om.payment_method = 'cod' and om.status in ('returned', 'refunded')
          and coalesce(ct.cod_status, '') <> 'collected' then 1 else 0 end as rts,
        case when om.payment_method = 'cod' and (coalesce(ct.cod_status, '') = 'collected'
          or om.status in ('delivered', 'completed')) then 1 else 0 end as cod_delivered,
        coalesce(${sql.raw(shopMinorSql(`(
          select sum(p.amount_minor) from order_payments p
          where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded'
        )`, "om"))}, 0) as refunded,
        case
          when om.requires_shipping = 0 then '__no_delivery'
          when om.shipping_method_kind = 'pickup' then '__pickup'
          when om.shipping_method_id is null then '__unknown'
          when dz.id is null then '__everywhere_else'
          else dz.id
        end as zone_key,
        coalesce(dz.name, '') as zone_label,
        coalesce(om.fulfillment_location_id, (
          select dl.id from inventory_locations dl where dl.is_default = 1
        ), '') as location_key
      from om
      left join cod_tracking ct on ct.order_id = om.id
      left join shipping_methods sm on sm.id = om.shipping_method_id
      left join delivery_zones dz on dz.id = sm.zone_id
    ),
    cu as (
      select ox.identity, max(ox.customer_id) as customer_id, max(ox.customer_phone) as customer_phone,
        count(*) as n
      from ox group by ox.identity
    ),
    -- An earlier order is looked up once per customer, not once per order.
    cp as (
      select cu.n, ${hasPriorSalesOrderSql(instants.start, "cu")} as prior from cu
    )
    -- D1 allows at most five terms per compound SELECT: two groups of terms.
    select * from (
      select 'total' as kind, '' as k1, '' as k2, ${measures},
        coalesce(sum(ox.cod), 0) as x1, coalesce(sum(ox.rts), 0) as x2,
        coalesce(sum(ox.cod_delivered), 0) as x3, coalesce(sum(ox.refunded), 0) as x4
      from ox
      union all
      select 'day', cast(ox.day as text), '', ${measures}, ${ZEROS}
      from ox group by ox.day
      union all
      select 'channel', ox.channel, coalesce(ox.channel_source, ''), ${measures}, ${ZEROS}
      from ox group by ox.channel, coalesce(ox.channel_source, '')
      union all
      select 'payment', ox.payment_method, '', ${measures}, ${ZEROS}
      from ox group by ox.payment_method
      union all
      select 'city', coalesce(ox.city_name, ''), '', ${measures}, ${ZEROS}
      from ox group by coalesce(ox.city_name, '')
    ) as sales_groups
    union all
    select * from (
      select 'zone' as kind, ox.zone_key as k1, ox.zone_label as k2, ${measures}, ${ZEROS}
      from ox group by ox.zone_key, ox.zone_label
      union all
      select 'location', ox.location_key, coalesce(il.name, ''), ${measures}, ${ZEROS}
      from ox left join inventory_locations il on il.id = ox.location_key
      group by ox.location_key, coalesce(il.name, '')
      union all
      select 'customers', '', '', count(*), 0, 0, 0, 0, 0, 0, 0, 0,
        coalesce(sum(case when cp.prior = 0 then 1 else 0 end), 0),
        coalesce(sum(cp.prior), 0),
        coalesce(sum(case when cp.prior = 1 or cp.n >= 2 then 1 else 0 end), 0),
        0
      from cp
      union all
      select 'placed', '', '',
        coalesce(sum(case when po.shop_currency = ${scope.currency} then 1 else 0 end), 0),
        0, 0, 0, 0, 0, 0, 0, 0,
        coalesce(sum(case when po.shop_currency = ${scope.currency} and po.status = 'cancelled' then 1 else 0 end), 0),
        coalesce(sum(case when po.shop_currency <> ${scope.currency} then 1 else 0 end), 0),
        0, 0
      from orders po
      where po.deleted_at is null
        and po.created_at >= ${instants.start} and po.created_at < ${instants.endExclusive}
        and po.status <> 'incomplete'
    ) as other_groups`;
}

function overviewQuery(ctx: AnalyticsContext, range: AnalyticsRange) {
  const fields = Object.fromEntries(
    OVERVIEW_FIELDS.map((field) => [field, sql`q.${sql.raw(field)}`]),
  ) as Record<(typeof OVERVIEW_FIELDS)[number], SQL<unknown>>;
  return ctx.db.select(fields).from(sql`(${overviewStatement(ctx, range)}) as q`);
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
  const [currentRows, previousRows] = await runAnalyticsQuery("overview", () => Promise.all([
    overviewQuery(ctx, input.range),
    previousRange ? overviewQuery(ctx, previousRange) : Promise.resolve(null),
  ]));
  const current = mapOverviewPeriod(input.range, currentRows as Record<string, unknown>[]);
  const previous = previousRange && previousRows
    ? mapOverviewPeriod(previousRange, previousRows as Record<string, unknown>[])
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
