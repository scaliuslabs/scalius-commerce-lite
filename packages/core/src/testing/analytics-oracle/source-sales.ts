// Frozen pre-rollup SQL oracle. Test-only: do not import production rollup helpers here.
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
import { getDecimalPlaces } from "@scalius/shared/currency";
import { zoneOffsetSchedule, type ZoneOffsetSchedule } from "@scalius/shared/commerce-time";
import {
  type AnalyticsInstantRange,
} from "@scalius/shared/analytics-period";

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

/**
 * `expr` (minor units of the order's currency) in minor units of the shop
 * currency: itself for a same-currency order, else at the order's locked
 * rate (`so.fxm`: the rate times the exponent shift), rounded half away from
 * zero. Binds nothing; runs on D1, TursoDB and PostgreSQL alike.
 */
export function shopMinorSql(expr: string, alias = "so"): string {
  return `(case when ${alias}.fx = 0 then (${expr}) else cast(round((${expr}) * ${alias}.fxm) as bigint) end)`;
}

/** The order's shop-currency multiplier: its rate times 10^(shop places − order places), literals only. */
function fxMultiplierText(shopDecimalPlaces: number, alias = "o"): string {
  const shifts = [0, 1, 2, 3].map((places) => {
    const shift = shopDecimalPlaces - places;
    return ` when ${places} then ${shift >= 0 ? `${10 ** shift}.0` : `${1 / 10 ** -shift}`}`;
  }).join("");
  return `cast(${alias}.fx_rate as double precision) * (case ${alias}.currency_decimal_places${shifts} else 1.0 end)`;
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
  return sql.raw(`(case when ${alias}.currency_code = ${alias}.shop_currency then (${expr}) else cast(round((${expr}) * ${fxMultiplierText(getDecimalPlaces(shopCurrency), alias)}) as bigint) end)`);
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

/** Customer identity: the customer record, else the order itself. */
export function orderIdentitySql(alias = "so"): SQL {
  return sql.raw(
    `(case when ${alias}.customer_id is not null then 'c:' || ${alias}.customer_id else 'o:' || ${alias}.id end)`,
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
  const shop = (column: string) => sql`${money(column)}${fxm}) as bigint) end as ${sql.raw(column)}`;
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
  // `so cross join` keeps the scope's orders the outer loop on SQLite (D1
  // keeps no table statistics): joined plainly, the planner walked every
  // line in the store and probed `so` (18 s a period on a million orders).
  // PostgreSQL plans a cross join with a WHERE key as the same inner join.
  return sql`rq as (
    select rl.order_item_id, sum(rl.approved_quantity) as approved
    from so
    cross join order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = so.id and rr.status in (${COUNTED_RETURNS})
    group by rl.order_item_id
  ),
  sl as (
    select oi.id as line_id, oi.order_id, oi.product_id, oi.variant_id, oi.quantity,
      oi.product_name, oi.variant_label, so.created_at, so.reversed,
      case when oi.fulfillment_type = 'gift_card' then 1 else 0 end as gc,
      ${sql.raw(shopMinorSql("oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end"))} as gross,
      ${sql.raw(shopMinorSql("oi.discount_amount_minor"))} as disc,
      ${sql.raw(shopMinorSql("oi.tax_amount_minor"))} as tax,
      ${unitCost} as unit_cost,
      case when so.reversed = 1 then oi.quantity else coalesce(rq.approved, 0) end as returned_raw
    from so
    cross join order_items oi
    left join rq on rq.order_item_id = oi.id
    where oi.order_id = so.id
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
  om0 as (
    select so.*, (
      select sum(p.amount_minor) from order_payments p
      where p.order_id = so.id and p.payment_type = 'refund' and p.status = 'refunded'
    ) as refunded_order_minor
    from so
  ),
  om as (
    select so.*,
      coalesce(lo.gross, 0) as gross,
      coalesce(lo.disc, 0) as disc,
      -- A return refunded only in part counts the money refunded.
      case
        when so.reversed = 1 or so.refunded_order_minor is null or so.refunded_order_minor <= 0 then coalesce(lo.returns, 0)
        when (case when so.fx = 0 then so.refunded_order_minor else cast(round(so.refunded_order_minor * so.fxm, 0) as bigint) end) < coalesce(lo.returns, 0)
          then (case when so.fx = 0 then so.refunded_order_minor else cast(round(so.refunded_order_minor * so.fxm, 0) as bigint) end)
        else coalesce(lo.returns, 0)
      end as returns,
      coalesce(lo.net_units, 0) as net_units,
      case when so.reversed = 1 then 0 else
        so.shipping_amount_minor
        - (so.discount_amount_minor - coalesce(lo.all_disc, 0))
        - case when so.incl = 1 then so.tax_amount_minor - coalesce(lo.all_tax, 0) else 0 end
      end as shipping,
      case when so.reversed = 1 then 0 else so.tax_amount_minor - coalesce(lo.all_tax, 0) end as shipping_tax,
      coalesce(lo.line_tax, 0)
        + case when so.reversed = 1 then 0 else so.tax_amount_minor - coalesce(lo.all_tax, 0) end as taxes
    from om0 so
    left join lo on lo.order_id = so.id
  )`;
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

/** Whether a customer record ordered before the scope started (any sales order). */
export function hasPriorSalesOrderSql(scopeStart: number, alias = "so"): SQL {
  const order = sql.raw(alias);
  return sql`(case when ${order}.customer_id is not null and exists (
      select 1 from orders p
      where p.customer_id = ${order}.customer_id and p.deleted_at is null
        and p.created_at < ${scopeStart} and p.status not in (${NON_SALES})
    ) then 1 else 0 end)`;
}
