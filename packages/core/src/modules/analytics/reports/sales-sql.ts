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
import { COMMERCE_UTC_OFFSET_SECONDS } from "@scalius/shared/commerce-time";
import {
  analyticsBuckets,
  analyticsEpochDay,
  type AnalyticsGranularity,
  type AnalyticsInstantRange,
  type AnalyticsRange,
} from "@scalius/shared/analytics-period";

/**
 * The orders a report reads: placed in the range, presented and reported in
 * the report currency (the store's). Line measures are presentment amounts,
 * so an order presented in another currency is counted only once reports
 * read line-level shop amounts (Markets, before a second currency).
 */
export interface SalesScope extends AnalyticsInstantRange {
  currency: string;
}

/**
 * Order statuses that never count as sales. `incomplete` is a hosted payment
 * the buyer never finished (not an order yet); `cancelled` orders are counted
 * only by the cancellation rate.
 */
export const NON_SALES_STATUSES = ["incomplete", "cancelled"] as const;
/** The whole order was sent back or refunded: its sale is reversed in full. */
export const REVERSED_STATUSES = ["returned", "refunded"] as const;
/** A return case whose lines reverse sales (the merchant accepted it). */
export const COUNTED_RETURN_STATUSES = ["approved", "receiving", "completed"] as const;

const quoted = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");
const NON_SALES = sql.raw(quoted(NON_SALES_STATUSES));
const REVERSED = sql.raw(quoted(REVERSED_STATUSES));
const COUNTED_RETURNS = sql.raw(quoted(COUNTED_RETURN_STATUSES));

/** The merchant calendar day (days since 1970-01-01) of an epoch-second column. */
export function merchantDaySql(column: string): SQL {
  return sql.raw(`cast((${column} + ${COMMERCE_UTC_OFFSET_SECONDS}) / 86400 as integer)`);
}

/**
 * The bucket a merchant day falls in, as the epoch day the bucket starts on.
 * Weeks start on Sunday (epoch day 3); months use their first-day boundaries
 * inside the range (at most 25 literals for a two-year range), so no
 * calendar functions differ between engines.
 */
export function bucketStartSql(dayExpression: SQL, granularity: AnalyticsGranularity, range: AnalyticsRange): SQL {
  if (granularity === "day") return dayExpression;
  if (granularity === "week") return sql`(${dayExpression} - ((${dayExpression} + 4) % 7))`;
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
export function salesOrdersCte(scope: SalesScope): SQL {
  return sql`so as materialized (
    select o.id, o.created_at, o.status, o.payment_method, o.channel, o.channel_source,
      o.city_name, o.zone_name, o.fulfillment_location_id, o.fulfillment_status,
      o.shipping_method_id, o.shipping_method_kind, o.requires_shipping,
      o.customer_id, o.customer_phone, o.customer_name,
      o.prices_include_tax as incl,
      o.shipping_amount_minor, o.discount_amount_minor, o.tax_amount_minor,
      o.total_amount_minor, o.paid_amount_minor, o.balance_due_minor,
      case when o.status in (${REVERSED}) then 1 else 0 end as reversed
    from orders o
    where o.deleted_at is null
      and o.created_at >= ${scope.start} and o.created_at < ${scope.endExclusive}
      and o.status not in (${NON_SALES})
      and o.currency_code = ${scope.currency}
      and o.shop_currency = ${scope.currency}
  )`;
}

export interface SalesLineOptions {
  /** Read `order_items.unit_cost_minor`, the sale-time unit cost (profit reports only). */
  unitCost?: boolean;
}

/**
 * `sl` → `lv`: every line of the sales orders with its measures. Gift-card
 * lines (`gc = 1`) are a liability sold, not merchandise: they stay in the
 * rows only so the order's shipping/tax residuals subtract every line.
 *
 * - gross: line subtotal, less its included tax when prices include tax
 * - disc: the line's discount allocation
 * - returned_qty: every unit of a reversed order, else units in accepted
 *   return cases (capped at the line quantity)
 * - returns: the returned share of (gross − disc), floored to the minor unit
 * - kept_tax: the line tax less the returned share
 */
export function salesLinesCtes(options: SalesLineOptions = {}): SQL {
  const unitCost = options.unitCost ? sql.raw("oi.unit_cost_minor") : sql.raw("null");
  // Accepted return quantities of the scope's lines, read once through
  // order_return_lines(order_id, order_item_id) and joined by line, rather
  // than a correlated subquery the planner may repeat for every reference.
  return sql`rq as (
    select rl.order_item_id, sum(rl.approved_quantity) as approved
    from so
    join order_return_lines rl on rl.order_id = so.id
    join order_returns rr on rr.id = rl.return_id
    where rr.status in (${COUNTED_RETURNS})
    group by rl.order_item_id
  ),
  sl as (
    select oi.id as line_id, oi.order_id, oi.product_id, oi.variant_id, oi.quantity,
      oi.product_name, oi.variant_label, so.created_at, so.reversed,
      case when oi.fulfillment_type = 'gift_card' then 1 else 0 end as gc,
      oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end as gross,
      oi.discount_amount_minor as disc,
      oi.tax_amount_minor as tax,
      ${unitCost} as unit_cost,
      case when so.reversed = 1 then oi.quantity else coalesce(rq.approved, 0) end as returned_raw
    from so
    join order_items oi on oi.order_id = so.id
    left join rq on rq.order_item_id = oi.id
  ),
  sv as (
    select sl.*,
      case when sl.returned_raw > sl.quantity then sl.quantity else sl.returned_raw end as returned_qty
    from sl
  ),
  lv as (
    select sv.*,
      case
        when sv.returned_qty = 0 then 0
        when sv.returned_qty = sv.quantity then sv.gross - sv.disc
        else ((sv.gross - sv.disc) * sv.returned_qty) / sv.quantity
      end as returns,
      case
        when sv.returned_qty = 0 then sv.tax
        when sv.returned_qty = sv.quantity then 0
        else sv.tax - (sv.tax * sv.returned_qty) / sv.quantity
      end as kept_tax
    from sv
  )`;
}

/**
 * `lo` → `om`: one row per sales order with its measures.
 *
 * - shipping: charged shipping less its discount (the order discount minus
 *   every line's) and, when prices include tax, less its included tax; zero
 *   for a reversed order
 * - taxes: kept line tax plus shipping tax (the order tax minus every
 *   line's), the shipping part zero for a reversed order
 * - net = gross − disc − returns; total = net + shipping + taxes
 */
export function orderMetricsCtes(): SQL {
  return sql`lo as (
    select lv.order_id,
      sum(case when lv.gc = 0 then lv.gross else 0 end) as gross,
      sum(case when lv.gc = 0 then lv.disc else 0 end) as disc,
      sum(case when lv.gc = 0 then lv.returns else 0 end) as returns,
      sum(case when lv.gc = 0 then lv.kept_tax else 0 end) as line_tax,
      sum(case when lv.gc = 0 then lv.quantity - lv.returned_qty else 0 end) as net_units,
      sum(lv.disc) as all_disc,
      sum(lv.tax) as all_tax
    from lv
    group by lv.order_id
  ),
  om as (
    select so.*,
      coalesce(lo.gross, 0) as gross,
      coalesce(lo.disc, 0) as disc,
      coalesce(lo.returns, 0) as returns,
      coalesce(lo.net_units, 0) as net_units,
      case when so.reversed = 1 then 0 else
        so.shipping_amount_minor
        - (so.discount_amount_minor - coalesce(lo.all_disc, 0))
        - case when so.incl = 1 then so.tax_amount_minor - coalesce(lo.all_tax, 0) else 0 end
      end as shipping,
      case when so.reversed = 1 then 0 else so.tax_amount_minor - coalesce(lo.all_tax, 0) end as shipping_tax,
      coalesce(lo.line_tax, 0)
        + case when so.reversed = 1 then 0 else so.tax_amount_minor - coalesce(lo.all_tax, 0) end as taxes
    from so
    left join lo on lo.order_id = so.id
  )`;
}

/** Order-level measures over `om` (or any CTE with its columns). */
export function orderMeasuresSql(alias = "om"): SQL {
  return sql.raw(`count(*) as orders,
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
