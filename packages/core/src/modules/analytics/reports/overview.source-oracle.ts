// Frozen pre-rollup query: parity must not share the new fact/projection formulas.
// The public mapper is deliberately shared; this oracle checks database semantics.
import { sql, type SQL } from "drizzle-orm";
import { analyticsInstantRange, type AnalyticsRange } from "@scalius/shared/analytics-period";
import {
  hasPriorSalesOrderSql, merchantDaySql, scopeOffsets, orderIdentitySql,
  orderMeasuresSql, orderMetricsCtes, salesLinesCtes, salesOrdersCte,
  shopMinorSql, type SalesScope,
} from "./overview.source-sales";
import type { AnalyticsContext } from "./context";
import { mapOverviewPeriod } from "./overview";

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
  const measures = orderMeasuresSql("ox", true);
  return sql`with ${salesOrdersCte(scope, "overview")},
    ${salesLinesCtes()},
    ${orderMetricsCtes()},
    od as (
      select om.payment_method, om.channel, om.channel_source, om.city_name,
        om.gross, om.disc, om.returns, om.shipping, om.taxes, om.net_units,
        ${merchantDaySql("om.created_at", scopeOffsets(ctx.timeZone, instants))} as day,
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
      left join cod_tracking ct on ct.order_id = om.id and ct.cod_status = 'collected'
      left join shipping_methods sm on sm.id = om.shipping_method_id
      left join delivery_zones dz on dz.id = sm.zone_id
    ),
    -- Collapse identical dimensions once, before the seven breakdown sorts.
    ox as materialized (
      select payment_method, channel, channel_source, city_name, day, zone_key, zone_label, location_key,
        count(*) as order_count,
        sum(gross) as gross, sum(disc) as disc, sum(returns) as returns,
        sum(shipping) as shipping, sum(taxes) as taxes, sum(net_units) as net_units,
        sum(cod) as cod, sum(rts) as rts, sum(cod_delivered) as cod_delivered, sum(refunded) as refunded
      from od
      group by payment_method, channel, channel_source, city_name, day, zone_key, zone_label, location_key
    ),
    cu as (
      select ${orderIdentitySql("so")} as identity, max(so.customer_id) as customer_id, max(so.customer_phone) as customer_phone,
        count(*) as n
      from so group by ${orderIdentitySql("so")}
    ),
    -- Read identities before money enrichment; probe once across all three sums.
    cp as materialized (
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

export function sourceOverviewQuery(ctx: AnalyticsContext, range: AnalyticsRange) {
  const fields = Object.fromEntries(
    OVERVIEW_FIELDS.map((field) => [field, sql`q.${sql.raw(field)}`]),
  ) as Record<(typeof OVERVIEW_FIELDS)[number], SQL<unknown>>;
  return ctx.db.select(fields).from(sql`(${overviewStatement(ctx, range)}) as q`);
}

export async function sourceOverviewPeriod(ctx: AnalyticsContext, range: AnalyticsRange) {
  return mapOverviewPeriod(range, await sourceOverviewQuery(ctx, range));
}
