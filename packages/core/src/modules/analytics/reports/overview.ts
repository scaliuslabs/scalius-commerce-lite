// The Analytics overview: sales KPIs, the sales-over-time series, customer,
// COD and cancellation rates, and breakdowns by channel, payment method,
// city, delivery zone and location, for a range and its comparison period.
//
// One read finds the sealed days of both periods; one batch (one round trip)
// then sends three small statements, each covering both periods: the
// dimension groups, the daily sales and the customers. TypeScript adds the
// groups into totals and breakdowns, so no statement re-reads another's rows
// and none comes near SQLite's nesting limits (analytics-statement-size.test.ts).
// Labels and merchant days follow the store's current settings.
import { orderPaymentKind, type OrderPaymentKind } from "@scalius/shared/order-payment-methods";
import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import { sql, type SQL } from "drizzle-orm";
import {
  analyticsBuckets,
  analyticsComparisonRange,
  analyticsDateKeyFromEpochDay,
  analyticsInstantRange,
  analyticsBucketKey,
  type AnalyticsComparison,
  type AnalyticsGranularity,
  type AnalyticsInstantRange,
  type AnalyticsRange,
} from "@scalius/shared/analytics-period";
import type { ZoneOffsetSchedule } from "@scalius/shared/commerce-time";
import type { WeekDay } from "@scalius/shared/week-start";
import { analyticsFactMeasures } from "@scalius/database/analytics-rollup";
import { merchantDaySql, scopeOffsets, orderMeasuresSql } from "./sales-sql";
import { overviewReadRanges, readSealedIntervals, type SealedIntervals } from "./overview-buckets";
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
    /**
     * Sales orders by how the rest were paid (`orderPaymentKind`): an online
     * gateway; to the store directly, in person or by transfer (`manual`);
     * by invoice; entirely by gift cards. A method of no known kind counts in
     * none.
     */
    onlineOrders: number;
    paidToStoreOrders: number;
    invoiceOrders: number;
    giftCardOrders: number;
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

const ROLLUP_MEASURES = [
  "order_count", "placed", "cancelled", "gross", "disc", "returns", "shipping", "taxes",
  "net_units", "cod", "rts", "cod_delivered", "refunded",
] as const;
type RollupSums = Record<(typeof ROLLUP_MEASURES)[number], number>;
const DIMENSIONS = sql.raw(`'["total","channel","payment","city","delivery","location"]'`);
const columns = (alias: string) => sql.raw(ROLLUP_MEASURES.map((name) => `${alias}.${name}`).join(", "));
const sums = (alias: string) => sql.raw(ROLLUP_MEASURES.map((name) => `sum(${alias}.${name}) as ${name}`).join(", "));
const factMeasures = (alias: string) => sql.raw(analyticsFactMeasures(alias));

type Interval = readonly [number, number];

/** One period's instants, zone offsets and read intervals; `pn` tags its rows (0 current, 1 comparison). */
interface PeriodPlan {
  range: AnalyticsRange;
  instants: AnalyticsInstantRange;
  offsets: ZoneOffsetSchedule;
  ranges: ReturnType<typeof overviewReadRanges>;
}

function planPeriod(ctx: AnalyticsContext, range: AnalyticsRange, sealed: SealedIntervals): PeriodPlan {
  const instants = analyticsInstantRange(range, ctx.timeZone);
  const offsets = scopeOffsets(ctx.timeZone, instants);
  return { range, instants, offsets, ranges: overviewReadRanges(instants, offsets, sealed) };
}

/** Intervals of every period as one JSON parameter, each row tagged with its period's `pn`. */
function intervalCte(name: string, periods: readonly (readonly Interval[])[]): SQL {
  const rows = periods.flatMap((intervals, pn) => intervals.map(([lo, hi]) => ({ pn, lo, hi })));
  return sql`${sql.raw(name)} as (
    select cast(json_extract(value, '$.pn') as bigint) as pn,
      cast(json_extract(value, '$.lo') as bigint) as lo,
      cast(json_extract(value, '$.hi') as bigint) as hi
    from json_each(${JSON.stringify(rows)})
  )`;
}

/** The merchant day of `column` on a row of period `alias.pn`, with that period's zone offsets. */
function merchantDayOf(column: string, alias: string, plans: readonly PeriodPlan[]): SQL {
  const [current, previous] = plans;
  if (!previous) return merchantDaySql(column, current!.offsets);
  return sql`(case when ${sql.raw(alias)}.pn = 0 then ${merchantDaySql(column, current!.offsets)} else ${merchantDaySql(column, previous.offsets)} end)`;
}

function selectFrom<const F extends readonly string[]>(ctx: AnalyticsContext, fields: F, statement: SQL) {
  const selection = Object.fromEntries(fields.map((field) => [field, sql`q.${sql.raw(field)}`])) as Record<F[number], SQL<unknown>>;
  return ctx.db.select(selection).from(sql`(${statement}) as q`);
}

const GROUP_FIELDS = ["pn", "kind", "currency", "k1", "k2", ...ROLLUP_MEASURES, "zone_key", "zone_label", "location_key", "location_label"] as const;

/**
 * Every dimension group of each period, in every currency (other currencies
 * only for the total): sealed days read their day buckets, every other
 * instant its facts, each read once. Delivery groups carry their method's
 * current zone, location groups their location (the default one resolved now).
 */
function groupsQuery(ctx: AnalyticsContext, plans: readonly PeriodPlan[]) {
  const currency = ctx.currency.code;
  const defaultLocation = sql`coalesce((select dl.id from inventory_locations dl where dl.is_default = 1), '')`;
  const locationKey = sql`case when px.key1 = 'default' then ${defaultLocation} else px.key2 end`;
  return selectFrom(ctx, GROUP_FIELDS, sql`with
    ${intervalCte("full_days", plans.map((plan) => plan.ranges.fullDays))},
    ${intervalCte("period_edges", plans.map((plan) => plan.ranges.periodEdges))},
    period_rows as (
      select fd.pn, b.dimension_kind, b.shop_currency, b.key1, b.key2, ${columns("b")}
      from full_days fd cross join json_each(${DIMENSIONS}) d
      cross join analytics_sales_buckets b
      where b.grain_seconds = 86400 and b.dimension_kind = d.value
        and b.bucket_start >= fd.lo and b.bucket_start < fd.hi
        and (b.shop_currency = ${currency} or b.dimension_kind = 'total')
      union all
      select e.pn, cast(d.value as text), f.shop_currency,
        case d.value
          when 'channel' then f.channel
          when 'payment' then f.payment_method
          when 'city' then coalesce(f.city_name, '')
          when 'delivery' then case
            when f.requires_shipping = 0 then 'none'
            when f.shipping_method_kind = 'pickup' then 'pickup'
            when f.shipping_method_id is null then 'unknown'
            else 'method' end
          when 'location' then case when f.fulfillment_location_id is null then 'default' else 'id' end
          else '' end,
        case d.value
          when 'channel' then coalesce(f.channel_source, '')
          when 'delivery' then coalesce(f.shipping_method_id, '')
          when 'location' then coalesce(f.fulfillment_location_id, '')
          else '' end,
        ${factMeasures("f")}
      from period_edges e cross join analytics_order_facts f cross join json_each(${DIMENSIONS}) d
      where f.created_at >= e.lo and f.created_at < e.hi
        and (f.shop_currency = ${currency} or d.value = 'total')
        and (f.order_count <> 0 or (d.value = 'total' and f.placed <> 0))
    ),
    px as (
      select pn, dimension_kind, shop_currency, key1, key2, ${sums("r")}
      from period_rows r group by pn, dimension_kind, shop_currency, key1, key2
    )
    select px.pn, px.dimension_kind as kind, px.shop_currency as currency, px.key1 as k1, px.key2 as k2, ${columns("px")},
      case px.key1
        when 'none' then '__no_delivery'
        when 'pickup' then '__pickup'
        when 'unknown' then '__unknown'
        else coalesce(dz.id, '__everywhere_else') end as zone_key,
      coalesce(dz.name, '') as zone_label,
      ${locationKey} as location_key,
      coalesce(il.name, '') as location_label
    from px
    left join shipping_methods sm on px.dimension_kind = 'delivery' and sm.id = px.key2
    left join delivery_zones dz on dz.id = sm.zone_id
    left join inventory_locations il on px.dimension_kind = 'location' and il.id = ${locationKey}`);
}

const DAY_FIELDS = ["pn", "day", "orders", "gross_sales", "discounts", "returns", "net_sales", "shipping", "taxes", "total_sales", "net_items_sold"] as const;

/** Sales of each merchant day with any: sealed quarter hours from buckets, the rest from facts. */
function daysQuery(ctx: AnalyticsContext, plans: readonly PeriodPlan[]) {
  const currency = ctx.currency.code;
  return selectFrom(ctx, DAY_FIELDS, sql`with
    ${intervalCte("quarter_hours", plans.map((plan) => plan.ranges.quarterHours))},
    ${intervalCte("day_edges", plans.map((plan) => plan.ranges.dayEdges))},
    day_rows as (
      select q.pn, ${merchantDayOf("b.bucket_start", "q", plans)} as day, ${columns("b")}
      from quarter_hours q cross join analytics_sales_buckets b
      where b.grain_seconds = 900 and b.dimension_kind = 'total'
        and b.bucket_start >= q.lo and b.bucket_start < q.hi and b.shop_currency = ${currency}
      union all
      select e.pn, ${merchantDayOf("f.created_at", "e", plans)} as day, ${factMeasures("f")}
      from day_edges e cross join analytics_order_facts f
      where f.created_at >= e.lo and f.created_at < e.hi and f.shop_currency = ${currency}
        and f.order_count = 1
    )
    select x.pn, x.day, ${orderMeasuresSql("x", true)}
    from day_rows x group by x.pn, x.day having sum(x.order_count) > 0`);
}

const CUSTOMER_MEASURES = ["customers", "new_customers", "returning_customers", "repeat_customers"] as const;
const customerFields = (periods: number) => Array.from({ length: periods }, (_, pn) => CUSTOMER_MEASURES.map((name) => `${name}_${pn}`)).flat();

/**
 * Distinct customers with a sales order in each period, from the covering
 * date index; each one's earlier sales order (any currency) is one index
 * probe, made once per customer. One row of per-period sums: a grouping by
 * period would pass over every customer once more (D1 counts each pass).
 */
function customersQuery(ctx: AnalyticsContext, plans: readonly PeriodPlan[]) {
  const sumsByPeriod = sql.raw(plans.map((_, pn) => {
    const sum = (expression: string) => `coalesce(sum(case when cp.pn = ${pn} then ${expression} else 0 end), 0)`;
    return [
      `${sum("1")} as customers_${pn}`,
      `${sum("1 - cp.prior")} as new_customers_${pn}`,
      `${sum("cp.prior")} as returning_customers_${pn}`,
      `${sum("case when cp.prior = 1 or cp.n >= 2 then 1 else 0 end")} as repeat_customers_${pn}`,
    ].join(", ");
  }).join(", "));
  return selectFrom(ctx, customerFields(plans.length), sql`with
    ${intervalCte("windows", plans.map((plan) => [[plan.instants.start, plan.instants.endExclusive] as const]))},
    cp as (
      select w.pn, count(*) as n, case when exists (
        select 1 from analytics_order_facts p
        where p.identity = f.identity and p.order_count = 1 and p.created_at < w.lo
      ) then 1 else 0 end as prior
      from windows w cross join analytics_order_facts f
      where f.shop_currency = ${ctx.currency.code} and f.order_count = 1
        and f.created_at >= w.lo and f.created_at < w.hi
      group by w.pn, w.lo, f.identity
    )
    select ${sumsByPeriod} from cp`);
}

type Row = Record<string, unknown>;

function zeroSums(): RollupSums {
  return Object.fromEntries(ROLLUP_MEASURES.map((name) => [name, 0])) as RollupSums;
}

function addSums(target: RollupSums, row: Row): RollupSums {
  for (const name of ROLLUP_MEASURES) target[name] += num(row[name]);
  return target;
}

/** A group's sums as a period row (`mapOverviewPeriod`'s shape), the measures `orderMeasuresSql` defines. */
function measureRow(kind: string, k1: string, k2: string, s: RollupSums, extra: readonly number[] = [0, 0, 0, 0]): Row {
  const netSales = s.gross - s.disc - s.returns;
  return {
    kind, k1, k2,
    orders: s.order_count,
    gross_sales: s.gross,
    discounts: s.disc,
    returns: s.returns,
    net_sales: netSales,
    shipping: s.shipping,
    taxes: s.taxes,
    total_sales: netSales + s.shipping + s.taxes,
    net_items_sold: s.net_units,
    x1: extra[0], x2: extra[1], x3: extra[2], x4: extra[3],
  };
}

/** Sums of rows grouped by a key pair, in key order. */
function groupBy(kind: string, rows: readonly Row[], key: (row: Row) => readonly [string, string]): Row[] {
  const groups = new Map<string, { k1: string; k2: string; sums: RollupSums }>();
  for (const row of rows) {
    const [k1, k2] = key(row);
    const id = `${k1}\u0000${k2}`;
    const group = groups.get(id) ?? { k1, k2, sums: zeroSums() };
    groups.set(id, group);
    addSums(group.sums, row);
  }
  return [...groups.values()].map((group) => measureRow(kind, group.k1, group.k2, group.sums));
}

/** One period's rows from the three statements' results. */
function periodRows(currency: string, pn: number, groups: readonly Row[], days: readonly Row[], customers: readonly Row[]): Row[] {
  const mine = groups.filter((row) => num(row.pn) === pn);
  // Sales groups: the report currency, with a sales order.
  const sales = mine.filter((row) => row.currency === currency && num(row.order_count) > 0);
  const of = (kind: string) => sales.filter((row) => row.kind === kind);
  const totals = of("total").reduce(addSums, zeroSums());
  const placed = { placed: 0, cancelled: 0, other: 0 };
  for (const row of mine.filter((group) => group.kind === "total")) {
    if (row.currency === currency) {
      placed.placed += num(row.placed);
      placed.cancelled += num(row.cancelled);
    } else if (row.currency !== null && row.currency !== undefined) {
      placed.other += num(row.placed);
    }
  }
  const customer = (name: (typeof CUSTOMER_MEASURES)[number]) => num(customers[0]?.[`${name}_${pn}`]);
  return [
    measureRow("total", "", "", totals, [totals.cod, totals.rts, totals.cod_delivered, totals.refunded]),
    ...days.filter((row) => num(row.pn) === pn).map((row) => ({ ...row, kind: "day", k1: num(row.day), k2: "" })),
    ...groupBy("channel", of("channel"), (row) => [text(row.k1), text(row.k2)]),
    ...groupBy("payment", of("payment"), (row) => [text(row.k1), ""]),
    ...groupBy("city", of("city"), (row) => [text(row.k1), ""]),
    ...groupBy("zone", of("delivery"), (row) => [text(row.zone_key), text(row.zone_label)]),
    ...groupBy("location", of("location"), (row) => [text(row.location_key), text(row.location_label)]),
    {
      kind: "customers", k1: "", k2: "", orders: customer("customers"),
      x1: customer("new_customers"), x2: customer("returning_customers"), x3: customer("repeat_customers"), x4: 0,
    },
    { kind: "placed", k1: "", k2: "", orders: placed.placed, x1: placed.cancelled, x2: placed.other, x3: 0, x4: 0 },
  ];
}

function emptyPeriod(range: AnalyticsRange): OverviewPeriod {
  return {
    range,
    totals: { ...EMPTY_MEASURES },
    customers: { customers: 0, newCustomers: 0, returningCustomers: 0, repeatPurchaseRate: null },
    payments: {
      codOrders: 0,
      onlineOrders: 0,
      paidToStoreOrders: 0,
      invoiceOrders: 0,
      giftCardOrders: 0,
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

/** Breakdown rows by total sales, largest first; ties by key, then label (code-unit order, as SQLite sorts). */
function sortBreakdown(rows: OverviewBreakdownRow[]): OverviewBreakdownRow[] {
  return rows.sort((left, right) => right.totalSales - left.totalSales || left.key.localeCompare(right.key)
    || (left.label < right.label ? -1 : left.label > right.label ? 1 : 0));
}

export function mapOverviewPeriod(
  range: AnalyticsRange,
  rows: readonly Record<string, unknown>[],
  /** An app method's kind as its orders recorded it (`readRecordedPaymentKinds`). */
  recordedKinds: ReadonlyMap<string, string> = new Map(),
): OverviewPeriod {
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
          ...period.payments,
          codOrders,
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
  // How the orders that are not cash on delivery were paid, by the kind of their method.
  const byKind = new Map<OrderPaymentKind | null, number>();
  for (const row of period.breakdowns.paymentMethod) {
    const kind = orderPaymentKind(row.key, recordedKinds.get(row.key));
    byKind.set(kind, (byKind.get(kind) ?? 0) + row.orders);
  }
  period.payments.onlineOrders = byKind.get("online") ?? 0;
  period.payments.paidToStoreOrders = byKind.get("paid_to_store") ?? 0;
  period.payments.invoiceOrders = byKind.get("invoice") ?? 0;
  period.payments.giftCardOrders = byKind.get("gift_card") ?? 0;
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

/**
 * How the apps' methods in a breakdown are paid, as their orders recorded it
 * (`orders.payment_kind`, the provider's `paymentKind` at placement): one
 * statement, one index seek per app method, none when the period has none.
 */
async function readRecordedPaymentKinds(ctx: AnalyticsContext, rows: readonly Record<string, unknown>[]): Promise<Map<string, string>> {
  const methods = [...new Set(rows.filter((row) => text(row.kind) === "payment").map((row) => text(row.k1)).filter(isQualifiedProviderId))];
  if (methods.length === 0) return new Map();
  const found = await ctx.db.all<{ method: unknown; kind: unknown }>(sql`select m.value as method, (
      select o.payment_kind from orders o
      where o.deleted_at is null and o.payment_method = m.value and o.payment_kind is not null
      limit 1
    ) as kind
    from json_each(${JSON.stringify(methods)}) m`);
  return new Map(found.flatMap((row) => typeof row.kind === "string" ? [[text(row.method), row.kind] as const] : []));
}

export async function getAnalyticsOverview(ctx: AnalyticsContext, input: OverviewInput): Promise<AnalyticsOverview> {
  const previousRange = analyticsComparisonRange(input.range, input.comparison);
  const ranges = previousRange ? [input.range, previousRange] : [input.range];
  // The sealed days of both periods, then three small statements in one batch (one round trip).
  const [groups, days, customers] = await runAnalyticsQuery("overview", async () => {
    const instants = ranges.map((range) => analyticsInstantRange(range, ctx.timeZone));
    const sealed = await readSealedIntervals(ctx.db, Math.min(...instants.map((i) => i.start)), Math.max(...instants.map((i) => i.endExclusive)));
    const plans = ranges.map((range) => planPeriod(ctx, range, sealed));
    return ctx.db.batch([groupsQuery(ctx, plans), daysQuery(ctx, plans), customersQuery(ctx, plans)]);
  });
  const [currentRows, previousRows] = ranges.map((_, pn) => periodRows(ctx.currency.code, pn, groups, days, customers));
  const recordedKinds = await readRecordedPaymentKinds(ctx, [...currentRows!, ...(previousRows ?? [])]);
  const current = mapOverviewPeriod(input.range, currentRows!, recordedKinds);
  const previous = previousRange && previousRows
    ? mapOverviewPeriod(previousRange, previousRows, recordedKinds)
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
