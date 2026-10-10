// The SQL every sales figure is built from. One place defines which orders
// count, how a line's gross, discount, return and tax are measured, and how
// an order's shipping and tax residuals are derived, so the overview and
// every report add up to the same numbers. README.md "Metric definitions"
// states these rules in words; keep the two in step.
//
// Portability: plain SQL that D1, TursoDB and the PostgreSQL SQLite-profile
// compiler all run identically. Integer arithmetic only on money (integer
// minor units; `/` truncates on both engines), CASE instead of SQLite's
// two-argument min/max, `= 1` on boolean columns (bigint on PostgreSQL),
// lowercase snake_case aliases (PostgreSQL folds unquoted identifiers).
import { sql, type SQL } from "drizzle-orm";
import {
  fxMultiplierText,
  salesLinesCtesText,
  orderMetricsCtesText,
  NON_SALES_STATUSES,
  REVERSED_STATUSES,
  type SalesLineOptions,
} from "@scalius/database/analytics-sales-sql";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { zoneOffsetSchedule, type ZoneOffsetSchedule } from "@scalius/shared/commerce-time";
import {
  analyticsBuckets,
  analyticsEpochDay,
  analyticsWeekOffset,
  type AnalyticsGranularity,
  type AnalyticsInstantRange,
  type AnalyticsRange,
} from "@scalius/shared/analytics-period";
import type { WeekDay } from "@scalius/shared/week-start";

export { shopMinorSql, NON_SALES_STATUSES, REVERSED_STATUSES, COUNTED_RETURN_STATUSES } from "@scalius/database/analytics-sales-sql";
export type { SalesLineOptions } from "@scalius/database/analytics-sales-sql";

/**
 * The orders a report reads: placed in the range and kept in the report
 * currency (the shop currency, `orders.shop_currency`). Every money measure
 * is in the shop currency: an order presented in a market's own currency
 * (MARKETS-DESIGN step 6) converts each amount at its locked rate, so
 * nothing ever sums mixed currencies.
 */
export interface SalesScope extends AnalyticsInstantRange {
  currency: string;
}

function fxMultiplierSql(shopDecimalPlaces: number): SQL {
  return sql.raw(fxMultiplierText(shopDecimalPlaces));
}

/**
 * `expr` (minor units of the currency of the order row `alias`) in minor
 * units of the shop currency, for reads that join `orders` directly (payment
 * and refund reports): the same conversion as `shopMinorSql`.
 */
export function orderShopMinorSql(expr: string, shopCurrency: string, alias = "o"): SQL {
  return sql.raw(`(case when ${alias}.currency_code = ${alias}.shop_currency then (${expr}) else cast(round((${expr}) * ${fxMultiplierText(getDecimalPlaces(shopCurrency), alias)}, 0) as bigint) end)`);
}

const quoted = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");
const NON_SALES = sql.raw(quoted(NON_SALES_STATUSES));
const REVERSED = sql.raw(quoted(REVERSED_STATUSES));

/**
 * The store zone's offsets over a scope's instants: what `merchantDaySql`
 * maps those instants with. A zone without daylight saving (Asia/Dhaka) has
 * one offset; a US or EU zone adds each change inside the scope.
 */
export function scopeOffsets(timeZone: string, scope: AnalyticsInstantRange): ZoneOffsetSchedule {
  return zoneOffsetSchedule(timeZone, scope.start, scope.endExclusive);
}

/**
 * The merchant calendar day (days since 1970-01-01) of an epoch-second column
 * whose values lie inside the scope the offsets were computed for: the local
 * wall time (instant + the zone's offset at that instant) divided into days.
 * Each offset change is an integer literal computed from a validated range,
 * so the statement binds nothing and runs the same on D1, TursoDB and
 * PostgreSQL; a single-offset zone reads `cast((col + offset) / 86400 as integer)`.
 */
export function merchantDaySql(column: string, offsets: ZoneOffsetSchedule): SQL {
  const offset = offsets.changes.length === 0
    ? String(offsets.initialOffset)
    : `case${[...offsets.changes].reverse().map((change) => ` when ${column} >= ${change.at} then ${change.offset}`).join("")} else ${offsets.initialOffset} end`;
  return sql.raw(`cast((${column} + ${offset}) / 86400 as integer)`);
}

/**
 * The bucket a merchant day falls in, as the epoch day the bucket starts on.
 * Weeks start on the store country's first day (Sunday: `+ 4`); months use
 * their first-day boundaries inside the range (at most 25 literals for a
 * two-year range), so no calendar functions differ between engines.
 */
export function bucketStartSql(dayExpression: SQL, granularity: AnalyticsGranularity, range: AnalyticsRange, weekStart: WeekDay = 0): SQL {
  if (granularity === "day") return dayExpression;
  if (granularity === "week") return sql`(${dayExpression} - ((${dayExpression} + ${sql.raw(String(analyticsWeekOffset(weekStart)))}) % 7))`;
  // Every literal is an integer computed from a validated range.
  const starts = analyticsBuckets(range, "month")
    .map((bucket) => analyticsEpochDay(bucket.key))
    .sort((left, right) => right - left);
  const parts: SQL[] = [sql.raw("(case")];
  for (const start of starts) {
    parts.push(sql` when ${dayExpression} >= ${sql.raw(String(start))} then ${sql.raw(String(start))}`);
  }
  parts.push(sql.raw(` else ${starts[starts.length - 1] ?? 0} end)`));
  return sql.join(parts, sql.raw(""));
}

/** Customer identity: the customer record, else the phone the order was placed with. */
export function orderIdentitySql(alias = "so"): SQL {
  return sql.raw(
    `(case when ${alias}.customer_id is not null then 'c:' || ${alias}.customer_id else 'p:' || ${alias}.customer_phone end)`,
  );
}

/**
 * `so`: the sales orders of the scope, one row each, with the order columns
 * reports group by and the money columns the residuals need.
 */
export function salesOrdersCte(scope: SalesScope, mode: "report" | "overview" = "report"): SQL {
  const fx = sql.raw("case when o.currency_code = o.shop_currency then 0 else 1 end");
  const fxm = fxMultiplierSql(getDecimalPlaces(scope.currency));
  // Order amounts in the shop currency (see `shopMinorSql`).
  const money = (column: string) => sql.raw(`case when o.currency_code = o.shop_currency then o.${column} else cast(round(o.${column} * `);
  const shop = (column: string) => sql`${money(column)}${fxm}, 0) as bigint) end as ${sql.raw(column)}`;
  // The overview reads a covering index without materializing report-only fields.
  const reportFields = mode === "report"
    ? sql`o.zone_name, o.fulfillment_status, o.customer_name, ${shop("total_amount_minor")}, ${shop("paid_amount_minor")}, ${shop("balance_due_minor")},`
    : sql.raw("");
  return sql`so as materialized (
    select o.id, o.created_at, o.status, o.payment_method, o.channel, o.channel_source,
      o.city_name, o.fulfillment_location_id,
      o.shipping_method_id, o.shipping_method_kind, o.requires_shipping,
      o.customer_id, o.customer_phone,
      o.prices_include_tax as incl,
      ${shop("shipping_amount_minor")}, ${shop("discount_amount_minor")}, ${shop("tax_amount_minor")},
      ${reportFields}
      ${fx} as fx,
      case when o.currency_code = o.shop_currency then 1.0 else ${fxm} end as fxm,
      case when o.status in (${REVERSED}) then 1 else 0 end as reversed
    from orders o
    where o.deleted_at is null
      and o.created_at >= ${scope.start} and o.created_at < ${scope.endExclusive}
      and o.status not in (${NON_SALES})
      and o.shop_currency = ${scope.currency}
    -- Visit the selected orders in key order so line/payment index pages are reused.
    ${mode === "overview" ? sql`order by o.id` : sql.raw("")}
  )`;
}

/** Shared integer-money expressions used by both live reports and order-fact triggers. */
export function salesLinesCtes(options: SalesLineOptions = {}): SQL {
  return sql.raw(salesLinesCtesText(options));
}

export function orderMetricsCtes(): SQL {
  return sql.raw(orderMetricsCtesText());
}

/** Measures over per-order rows, or dimension groups carrying `order_count`. */
export function orderMeasuresSql(alias = "om", grouped = false): SQL {
  return sql.raw(`${grouped ? `coalesce(sum(${alias}.order_count), 0)` : "count(*)"} as orders,
      coalesce(sum(${alias}.gross), 0) as gross_sales,
      coalesce(sum(${alias}.disc), 0) as discounts,
      coalesce(sum(${alias}.returns), 0) as returns,
      coalesce(sum(${alias}.gross - ${alias}.disc - ${alias}.returns), 0) as net_sales,
      coalesce(sum(${alias}.shipping), 0) as shipping,
      coalesce(sum(${alias}.taxes), 0) as taxes,
      coalesce(sum(${alias}.gross - ${alias}.disc - ${alias}.returns + ${alias}.shipping + ${alias}.taxes), 0) as total_sales,
      coalesce(sum(${alias}.net_units), 0) as net_items_sold`);
}

/** Line-level measures over merchandise lines of `lv`. */
export function lineMeasuresSql(alias = "lv"): SQL {
  return sql.raw(`count(distinct ${alias}.order_id) as orders,
      coalesce(sum(${alias}.quantity - ${alias}.returned_qty), 0) as net_items_sold,
      coalesce(sum(${alias}.gross), 0) as gross_sales,
      coalesce(sum(${alias}.disc), 0) as discounts,
      coalesce(sum(${alias}.returns), 0) as returns,
      coalesce(sum(${alias}.gross - ${alias}.disc - ${alias}.returns), 0) as net_sales,
      coalesce(sum(${alias}.kept_tax), 0) as taxes,
      coalesce(sum(${alias}.gross - ${alias}.disc - ${alias}.returns + ${alias}.kept_tax), 0) as total_sales`);
}

/**
 * Whether a customer identity ordered before the scope started (any sales
 * order). Index-backed: `orders_customer_activity_idx` for customer records,
 * `orders_customer_phone_idx` for phone identities.
 */
export function hasPriorSalesOrderSql(scopeStart: number, alias = "so"): SQL {
  const order = sql.raw(alias);
  return sql`(case
    when ${order}.customer_id is not null and exists (
      select 1 from orders p
      where p.customer_id = ${order}.customer_id and p.deleted_at is null
        and p.created_at < ${scopeStart} and p.status not in (${NON_SALES})
    ) then 1
    when ${order}.customer_id is null and exists (
      select 1 from orders p
      where p.customer_phone = ${order}.customer_phone and p.customer_id is null and p.deleted_at is null
        and p.created_at < ${scopeStart} and p.status not in (${NON_SALES})
    ) then 1
    else 0 end)`;
}

/** Whether an order is its customer identity's first sales order ever (ties broken by id). */
export function isFirstSalesOrderSql(alias = "so"): SQL {
  const order = sql.raw(alias);
  return sql`(case
    when ${order}.customer_id is not null and exists (
      select 1 from orders p
      where p.customer_id = ${order}.customer_id and p.deleted_at is null
        and p.status not in (${NON_SALES})
        and (p.created_at < ${order}.created_at or (p.created_at = ${order}.created_at and p.id < ${order}.id))
    ) then 0
    when ${order}.customer_id is null and exists (
      select 1 from orders p
      where p.customer_phone = ${order}.customer_phone and p.customer_id is null and p.deleted_at is null
        and p.status not in (${NON_SALES})
        and (p.created_at < ${order}.created_at or (p.created_at = ${order}.created_at and p.id < ${order}.id))
    ) then 0
    else 1 end)`;
}
