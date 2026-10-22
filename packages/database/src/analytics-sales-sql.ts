// One monetary definition for live analytics and the transactionally maintained projection.
// Pure SQL text: no core imports, bindings, or database access.
export function shopMinorSql(expr: string, alias = "so"): string {
  return `(case when ${alias}.fx = 0 then (${expr}) else cast(round((${expr}) * ${alias}.fxm, 0) as bigint) end)`;
}

/** The order's shop-currency multiplier: its rate times 10^(shop places − order places), literals only. */
export function fxMultiplierText(shopDecimalPlaces: number, alias = "o"): string {
  const shifts = [0, 1, 2, 3].map((places) => {
    const shift = shopDecimalPlaces - places;
    return ` when ${places} then ${shift >= 0 ? `${10 ** shift}.0` : `${1 / 10 ** -shift}`}`;
  }).join("");
  return `cast(${alias}.fx_rate as double precision) * (case ${alias}.currency_decimal_places${shifts} else 1.0 end)`;
}

export const NON_SALES_STATUSES = ["incomplete", "cancelled"] as const;
/** The whole order was sent back or refunded: its sale is reversed in full. */
export const REVERSED_STATUSES = ["returned", "refunded"] as const;
/** A return case whose lines reverse sales (the merchant accepted it). */
export const COUNTED_RETURN_STATUSES = ["approved", "receiving", "completed"] as const;

const quoted = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");

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
export function salesLinesCtesText(options: SalesLineOptions = {}): string {
  const unitCost = options.unitCost ? "oi.unit_cost_minor" : "null";
  // Accepted return quantities of the scope's lines, read once through
  // order_return_lines(order_id, order_item_id) and joined by line, rather
  // than a correlated subquery the planner may repeat for every reference.
  // `so cross join` keeps the scope's orders the outer loop on SQLite (D1
  // keeps no table statistics): joined plainly, the planner walked every
  // line in the store and probed `so` (18 s a period on a million orders).
  // PostgreSQL plans a cross join with a WHERE key as the same inner join.
  return `rq as (
    select rl.order_item_id, cast(sum(rl.approved_quantity) as bigint) as approved
    from so
    cross join order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = so.id and rr.status in (${quoted(COUNTED_RETURN_STATUSES)})
    group by rl.order_item_id
  ),
  sl as (
    select oi.id as line_id, oi.order_id, oi.product_id, oi.variant_id, oi.quantity,
      oi.product_name, oi.variant_label, so.created_at, so.reversed,
      case when oi.fulfillment_type = 'gift_card' then 1 else 0 end as gc,
      ${shopMinorSql("oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end")} as gross,
      ${shopMinorSql("oi.discount_amount_minor")} as disc,
      ${shopMinorSql("oi.tax_amount_minor")} as tax,
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
      ${lineReturnsSql("sv.gross", "sv.disc", "sv.quantity", "sv.returned_qty")} as returns,
      ${lineKeptTaxSql("sv.tax", "sv.quantity", "sv.returned_qty")} as kept_tax
    from sv
  )`;
}

/** The returned share of a line's (gross − discount) for `returned` of `quantity` units, floored. */
export function lineReturnsSql(gross: string, disc: string, quantity: string, returned: string): string {
  return `(case when ${returned} = 0 then 0 when ${returned} = ${quantity} then ${gross} - ${disc}
    else ((${gross} - ${disc}) * ${returned}) / ${quantity} end)`;
}

/** A line's tax less its returned share. */
export function lineKeptTaxSql(tax: string, quantity: string, returned: string): string {
  return `(case when ${returned} = 0 then ${tax} when ${returned} = ${quantity} then 0
    else ${tax} - (${tax} * ${returned}) / ${quantity} end)`;
}

/**
 * `lo` → `om`: one row per sales order with its measures.
 *
 * - shipping: charged shipping less its discount (the order discount minus
 *   every line's) and, when prices include tax, less its included tax; zero
 *   for a reversed order
 * - taxes: kept line tax plus shipping tax (the order tax minus every
 *   line's), the shipping part zero for a reversed order
 * - returns: the lines' returns, or the money refunded when a return was
 *   refunded only in part (a fee kept); a reversed order returns everything
 * - net = gross − disc − returns; total = net + shipping + taxes
 */
export function orderMetricsCtesText(): string {
  // Money refunded per order (order currency): a return refunded only in part
  // counts what went back, not the item value (the projection's rule too).
  return `rf as (
    select so.id as order_id, cast(sum(p.amount_minor) as bigint) as refund
    from so
    cross join order_payments p
    where p.order_id = so.id and p.payment_type = 'refund' and p.status = 'refunded'
    group by so.id
  ),
  lo as (
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
      case when so.reversed = 0 and coalesce(rf.refund, 0) > 0 and ${shopMinorSql("rf.refund")} < coalesce(lo.returns, 0)
        then ${shopMinorSql("rf.refund")} else coalesce(lo.returns, 0) end as returns,
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
    left join rf on rf.order_id = so.id
  )`;
}
