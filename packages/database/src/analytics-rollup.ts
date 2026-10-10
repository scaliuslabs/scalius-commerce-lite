import { currencyExponent, EXCLUDED_CURRENCY_CODES, SUPPORTED_CURRENCY_CODES } from "@scalius/shared/currency-policy";
import { fxMultiplierText, orderMetricsCtesText, salesLinesCtesText, shopMinorSql } from "./analytics-sales-sql";

export const ANALYTICS_MEASURES = ["order_count", "placed", "cancelled", "gross", "disc", "returns", "shipping", "taxes", "net_units", "cod", "rts", "cod_delivered", "refunded"] as const;
export const ANALYTICS_FACT_KEYS = ["order_id", "created_at", "shop_currency", "identity", "channel", "channel_source", "payment_method", "city_name", "shipping_method_id", "shipping_method_kind", "requires_shipping", "fulfillment_location_id"] as const;
export const ANALYTICS_BUCKET_KEYS = ["grain_seconds", "dimension_kind", "bucket_start", "shop_currency", "key1", "key2"] as const;

/** All currencies use the same metadata as getDecimalPlaces, including legacy/unknown codes. */
function rowFxMultiplier(): string {
  const codes = [...SUPPORTED_CURRENCY_CODES, ...EXCLUDED_CURRENCY_CODES];
  const cases = [0, 3, 4].map((places) => {
    const matching = codes.filter((code) => currencyExponent(code) === places).map((code) => `'${code}'`).join(", ");
    return `when upper(trim(o.shop_currency)) in (${matching}) then ${fxMultiplierText(places)}`;
  });
  return `(case ${cases.join(" ")} else ${fxMultiplierText(2)} end)`;
}

/** Exact source projection, shared by initial backfill and each affected-order refresh. */
export function analyticsOrderFactsSelect(where = "1 = 1"): string {
  const fxm = rowFxMultiplier();
  const shop = (column: string) => `case when o.currency_code = o.shop_currency then o.${column} else cast(round(o.${column} * ${fxm}, 0) as bigint) end as ${column}`;
  return `with ao as materialized (select o.id, o.created_at, o.deleted_at, o.status, o.shop_currency, o.currency_code, o.currency_decimal_places, o.fx_rate, o.prices_include_tax, o.shipping_amount_minor, o.discount_amount_minor, o.tax_amount_minor, o.customer_id, o.customer_phone, o.channel, o.channel_source, o.payment_method, o.city_name, o.shipping_method_id, o.shipping_method_kind, o.requires_shipping, o.fulfillment_location_id from orders o where ${where}),
    so as materialized (
      select o.id, o.created_at, o.status, o.payment_method, o.channel, o.channel_source,
        o.city_name, o.fulfillment_location_id, o.shipping_method_id, o.shipping_method_kind,
        o.requires_shipping, o.customer_id, o.customer_phone, o.prices_include_tax as incl,
        ${shop("shipping_amount_minor")}, ${shop("discount_amount_minor")}, ${shop("tax_amount_minor")},
        case when o.currency_code = o.shop_currency then 0 else 1 end as fx,
        case when o.currency_code = o.shop_currency then 1.0 else ${fxm} end as fxm,
        case when o.status in ('returned', 'refunded') then 1 else 0 end as reversed
      from ao o where o.deleted_at is null and o.status not in ('incomplete', 'cancelled')
    ), ${salesLinesCtesText()}, ${orderMetricsCtesText()}
    select o.id as order_id, o.created_at, o.shop_currency,
      case when o.customer_id is not null then 'c:' || o.customer_id else 'p:' || o.customer_phone end as identity,
      o.channel, o.channel_source, o.payment_method, o.city_name,
      o.shipping_method_id, o.shipping_method_kind, o.requires_shipping, o.fulfillment_location_id,
      case when om.id is null then 0 else 1 end as order_count,
      case when o.deleted_at is null and o.status <> 'incomplete' then 1 else 0 end as placed,
      case when o.deleted_at is null and o.status = 'cancelled' then 1 else 0 end as cancelled,
      coalesce(om.gross, 0) as gross, coalesce(om.disc, 0) as disc, coalesce(om.returns, 0) as returns,
      coalesce(om.shipping, 0) as shipping, coalesce(om.taxes, 0) as taxes, coalesce(om.net_units, 0) as net_units,
      case when om.payment_method = 'cod' then 1 else 0 end as cod,
      case when om.payment_method = 'cod' and om.status in ('returned', 'refunded')
        and not exists (select 1 from cod_tracking ct where ct.order_id = om.id and ct.cod_status = 'collected') then 1 else 0 end as rts,
      case when om.payment_method = 'cod' and (om.status in ('delivered', 'completed')
        or exists (select 1 from cod_tracking ct where ct.order_id = om.id and ct.cod_status = 'collected')) then 1 else 0 end as cod_delivered,
      coalesce(${shopMinorSql("(select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')", "om")}, 0) as refunded
    from ao o left join om on om.id = o.id`;
}

/** Floor to a UTC bucket, including fractional seconds before the Unix epoch. */
function bucketStart(column: string, grain: number): string {
  const truncated = `cast(${column} / ${grain} as bigint)`;
  return `((${truncated} - case when ${column} < 0 and ${column} <> ${truncated} * ${grain} then 1 else 0 end) * ${grain})`;
}

/** Raw dimensions are typed by separate columns, so actual IDs cannot collide with fallback keys. */
export function analyticsBucketContributions(source: string): string {
  const salesMeasures = new Set<string>(["order_count", "gross", "disc", "returns", "shipping", "taxes", "net_units"]);
  const measures = (total: boolean) => ANALYTICS_MEASURES
    .map((c) => total || salesMeasures.has(c) ? `f.${c}` : `0 as ${c}`).join(", ");
  const dimensions = [
    ["total", "''", "''"], ["channel", "f.channel", "coalesce(f.channel_source, '')"],
    ["payment", "f.payment_method", "''"], ["city", "coalesce(f.city_name, '')", "''"],
    ["delivery", "case when f.requires_shipping = 0 then 'none' when f.shipping_method_kind = 'pickup' then 'pickup' when f.shipping_method_id is null then 'unknown' else 'method' end", "coalesce(f.shipping_method_id, '')"],
    ["location", "case when f.fulfillment_location_id is null then 'default' else 'id' end", "coalesce(f.fulfillment_location_id, '')"],
  ];
  const parts = dimensions.map(([kind, k1, k2]) => `select 86400 as grain_seconds, '${kind}' as dimension_kind,
    ${bucketStart("f.created_at", 86400)} as bucket_start,
    f.shop_currency, ${k1} as key1, ${k2} as key2, ${measures(kind === "total")}
    from ${source} f where ${kind === "total" ? "f.placed <> 0" : "f.order_count <> 0"}`);
  parts.push(`select 900 as grain_seconds, 'total' as dimension_kind,
    ${bucketStart("f.created_at", 900)} as bucket_start,
    f.shop_currency, '' as key1, '' as key2, ${measures(true)} from ${source} f where f.placed <> 0`);
  // The D1 compound-select budget is five terms, including inside trigger statements.
  return `select * from (${parts.slice(0, 4).join(" union all ")}) as first_dimensions
    union all select * from (${parts.slice(4).join(" union all ")}) as last_dimensions`;
}

export function analyticsBucketsInsert(source: string, delta = false): string {
  const keys = ANALYTICS_BUCKET_KEYS.join(", ");
  const cols = [...ANALYTICS_BUCKET_KEYS, ...ANALYTICS_MEASURES].join(", ");
  return `insert into analytics_sales_buckets (${cols})
    select ${keys}, ${ANALYTICS_MEASURES.map((c) => `sum(contributions.${c}) as ${c}`).join(", ")}
    from (${analyticsBucketContributions(source)}) as contributions
    group by ${keys}${delta ? ` having ${ANALYTICS_MEASURES.map((c) => `sum(contributions.${c}) <> 0`).join(" or ")}
    on conflict (${keys}) do update set ${ANALYTICS_MEASURES.map((c) => `${c} = analytics_sales_buckets.${c} + excluded.${c}`).join(", ")}` : ""}`;
}

/** Customer extrema backfill after facts and global-first rows, with maintenance triggers absent. */
export function analyticsCustomerCurrencyBackfillStatement(): string {
  return `insert into analytics_customer_currency_summary
    (identity, shop_currency, first_sale_at, second_sale_at, last_sale_at, first_sale_any_currency_at)
    select c.identity, c.shop_currency, c.first_sale_at,
      (select f.created_at from analytics_order_facts f
        where f.shop_currency = c.shop_currency and f.identity = c.identity and f.order_count = 1
        order by f.created_at limit 1 offset 1),
      c.last_sale_at, fs.first_sale_at
    from (select identity, shop_currency, min(created_at) as first_sale_at, max(created_at) as last_sale_at
      from analytics_order_facts where order_count = 1 group by shop_currency, identity) c
    left join analytics_customer_first_sale fs on fs.identity = c.identity`;
}

/** Only for empty projections with maintenance triggers absent (migration and the scale fixture). */
export function analyticsRollupBackfillStatements(): string[] {
  return [
    `insert into analytics_order_facts (${[...ANALYTICS_FACT_KEYS, ...ANALYTICS_MEASURES].join(", ")}) ${analyticsOrderFactsSelect()}`,
    analyticsBucketsInsert("analytics_order_facts"),
    "insert into analytics_customer_first_sale (identity, first_sale_at) select identity, min(created_at) from analytics_order_facts where order_count = 1 group by identity",
    analyticsCustomerCurrencyBackfillStatement(),
  ];
}
