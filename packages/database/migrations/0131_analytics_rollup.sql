CREATE TABLE `analytics_customer_currency_summary` (
	`identity` text NOT NULL,
	`shop_currency` text NOT NULL,
	`first_sale_at` integer,
	`second_sale_at` integer,
	`last_sale_at` integer,
	`first_sale_any_currency_at` integer,
	PRIMARY KEY(`identity`, `shop_currency`)
);
--> statement-breakpoint
CREATE INDEX `analytics_customer_currency_range_idx` ON `analytics_customer_currency_summary` (`shop_currency`,`first_sale_at`,`last_sale_at`,`second_sale_at`,`first_sale_any_currency_at`,`identity`) WHERE "analytics_customer_currency_summary"."first_sale_at" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `analytics_customer_first_sale` (
	`identity` text PRIMARY KEY NOT NULL,
	`first_sale_at` integer
);
--> statement-breakpoint
CREATE TABLE `analytics_order_facts` (
	`order_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`shop_currency` text NOT NULL,
	`identity` text NOT NULL,
	`channel` text NOT NULL,
	`channel_source` text,
	`payment_method` text NOT NULL,
	`city_name` text,
	`shipping_method_id` text,
	`shipping_method_kind` text,
	`requires_shipping` integer NOT NULL,
	`fulfillment_location_id` text,
	`order_count` integer DEFAULT 0 NOT NULL,
	`placed` integer DEFAULT 0 NOT NULL,
	`cancelled` integer DEFAULT 0 NOT NULL,
	`gross` integer DEFAULT 0 NOT NULL,
	`disc` integer DEFAULT 0 NOT NULL,
	`returns` integer DEFAULT 0 NOT NULL,
	`shipping` integer DEFAULT 0 NOT NULL,
	`taxes` integer DEFAULT 0 NOT NULL,
	`net_units` integer DEFAULT 0 NOT NULL,
	`cod` integer DEFAULT 0 NOT NULL,
	`rts` integer DEFAULT 0 NOT NULL,
	`cod_delivered` integer DEFAULT 0 NOT NULL,
	`refunded` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `analytics_facts_range_idx` ON `analytics_order_facts` (`created_at`,`shop_currency`);
--> statement-breakpoint
CREATE INDEX `analytics_facts_customer_range_idx` ON `analytics_order_facts` (`shop_currency`,`created_at`,`identity`) WHERE "analytics_order_facts"."order_count" = 1;
--> statement-breakpoint
CREATE INDEX `analytics_facts_customer_identity_idx` ON `analytics_order_facts` (`shop_currency`,`identity`,`created_at`) WHERE "analytics_order_facts"."order_count" = 1;
--> statement-breakpoint
CREATE INDEX `analytics_facts_first_sale_idx` ON `analytics_order_facts` (`identity`,`created_at`,`order_id`) WHERE "analytics_order_facts"."order_count" = 1;
--> statement-breakpoint
CREATE TABLE `analytics_sales_buckets` (
	`grain_seconds` integer NOT NULL,
	`dimension_kind` text NOT NULL,
	`bucket_start` integer NOT NULL,
	`shop_currency` text NOT NULL,
	`key1` text NOT NULL,
	`key2` text NOT NULL,
	`order_count` integer DEFAULT 0 NOT NULL,
	`placed` integer DEFAULT 0 NOT NULL,
	`cancelled` integer DEFAULT 0 NOT NULL,
	`gross` integer DEFAULT 0 NOT NULL,
	`disc` integer DEFAULT 0 NOT NULL,
	`returns` integer DEFAULT 0 NOT NULL,
	`shipping` integer DEFAULT 0 NOT NULL,
	`taxes` integer DEFAULT 0 NOT NULL,
	`net_units` integer DEFAULT 0 NOT NULL,
	`cod` integer DEFAULT 0 NOT NULL,
	`rts` integer DEFAULT 0 NOT NULL,
	`cod_delivered` integer DEFAULT 0 NOT NULL,
	`refunded` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`grain_seconds`, `dimension_kind`, `bucket_start`, `shop_currency`, `key1`, `key2`)
);
--> statement-breakpoint
insert into analytics_order_facts (order_id, created_at, shop_currency, identity, channel, channel_source, payment_method, city_name, shipping_method_id, shipping_method_kind, requires_shipping, fulfillment_location_id, order_count, placed, cancelled, gross, disc, returns, shipping, taxes, net_units, cod, rts, cod_delivered, refunded) with ao as materialized (select o.id, o.created_at, o.deleted_at, o.status, o.shop_currency, o.currency_code, o.currency_decimal_places, o.fx_rate, o.prices_include_tax, o.shipping_amount_minor, o.discount_amount_minor, o.tax_amount_minor, o.customer_id, o.customer_phone, o.channel, o.channel_source, o.payment_method, o.city_name, o.shipping_method_id, o.shipping_method_kind, o.requires_shipping, o.fulfillment_location_id from orders o where 1 = 1),
    so as materialized (
      select o.id, o.created_at, o.status, o.payment_method, o.channel, o.channel_source,
        o.city_name, o.fulfillment_location_id, o.shipping_method_id, o.shipping_method_kind,
        o.requires_shipping, o.customer_id, o.customer_phone, o.prices_include_tax as incl,
        case when o.currency_code = o.shop_currency then o.shipping_amount_minor else cast(round(o.shipping_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as shipping_amount_minor, case when o.currency_code = o.shop_currency then o.discount_amount_minor else cast(round(o.discount_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as discount_amount_minor, case when o.currency_code = o.shop_currency then o.tax_amount_minor else cast(round(o.tax_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as tax_amount_minor,
        case when o.currency_code = o.shop_currency then 0 else 1 end as fx,
        case when o.currency_code = o.shop_currency then 1.0 else (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end) end as fxm,
        case when o.status in ('returned', 'refunded') then 1 else 0 end as reversed
      from ao o where o.deleted_at is null and o.status not in ('incomplete', 'cancelled')
    ), rq as (
    select rl.order_item_id, cast(sum(rl.approved_quantity) as bigint) as approved
    from so
    cross join order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = so.id and rr.status in ('approved', 'receiving', 'completed')
    group by rl.order_item_id
  ),
  sl as (
    select oi.id as line_id, oi.order_id, oi.product_id, oi.variant_id, oi.quantity,
      oi.product_name, oi.variant_label, so.created_at, so.reversed,
      case when oi.fulfillment_type = 'gift_card' then 1 else 0 end as gc,
      (case when so.fx = 0 then (oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) else cast(round((oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) * so.fxm, 0) as bigint) end) as gross,
      (case when so.fx = 0 then (oi.discount_amount_minor) else cast(round((oi.discount_amount_minor) * so.fxm, 0) as bigint) end) as disc,
      (case when so.fx = 0 then (oi.tax_amount_minor) else cast(round((oi.tax_amount_minor) * so.fxm, 0) as bigint) end) as tax,
      null as unit_cost,
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
  ), lo as (
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
  )
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
      coalesce((case when om.fx = 0 then ((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) else cast(round(((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) * om.fxm, 0) as bigint) end), 0) as refunded
    from ao o left join om on om.id = o.id;
--> statement-breakpoint
insert into analytics_sales_buckets (grain_seconds, dimension_kind, bucket_start, shop_currency, key1, key2, order_count, placed, cancelled, gross, disc, returns, shipping, taxes, net_units, cod, rts, cod_delivered, refunded)
    select grain_seconds, dimension_kind, bucket_start, shop_currency, key1, key2, sum(contributions.order_count) as order_count, sum(contributions.placed) as placed, sum(contributions.cancelled) as cancelled, sum(contributions.gross) as gross, sum(contributions.disc) as disc, sum(contributions.returns) as returns, sum(contributions.shipping) as shipping, sum(contributions.taxes) as taxes, sum(contributions.net_units) as net_units, sum(contributions.cod) as cod, sum(contributions.rts) as rts, sum(contributions.cod_delivered) as cod_delivered, sum(contributions.refunded) as refunded
    from (select * from (select 86400 as grain_seconds, 'total' as dimension_kind,
    ((cast(f.created_at / 86400 as bigint) - case when f.created_at < 0 and f.created_at <> cast(f.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400) as bucket_start,
    f.shop_currency, '' as key1, '' as key2, f.order_count, f.placed, f.cancelled, f.gross, f.disc, f.returns, f.shipping, f.taxes, f.net_units, f.cod, f.rts, f.cod_delivered, f.refunded
    from analytics_order_facts f where f.placed <> 0 union all select 86400 as grain_seconds, 'channel' as dimension_kind,
    ((cast(f.created_at / 86400 as bigint) - case when f.created_at < 0 and f.created_at <> cast(f.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400) as bucket_start,
    f.shop_currency, f.channel as key1, coalesce(f.channel_source, '') as key2, f.order_count, 0 as placed, 0 as cancelled, f.gross, f.disc, f.returns, f.shipping, f.taxes, f.net_units, 0 as cod, 0 as rts, 0 as cod_delivered, 0 as refunded
    from analytics_order_facts f where f.order_count <> 0 union all select 86400 as grain_seconds, 'payment' as dimension_kind,
    ((cast(f.created_at / 86400 as bigint) - case when f.created_at < 0 and f.created_at <> cast(f.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400) as bucket_start,
    f.shop_currency, f.payment_method as key1, '' as key2, f.order_count, 0 as placed, 0 as cancelled, f.gross, f.disc, f.returns, f.shipping, f.taxes, f.net_units, 0 as cod, 0 as rts, 0 as cod_delivered, 0 as refunded
    from analytics_order_facts f where f.order_count <> 0 union all select 86400 as grain_seconds, 'city' as dimension_kind,
    ((cast(f.created_at / 86400 as bigint) - case when f.created_at < 0 and f.created_at <> cast(f.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400) as bucket_start,
    f.shop_currency, coalesce(f.city_name, '') as key1, '' as key2, f.order_count, 0 as placed, 0 as cancelled, f.gross, f.disc, f.returns, f.shipping, f.taxes, f.net_units, 0 as cod, 0 as rts, 0 as cod_delivered, 0 as refunded
    from analytics_order_facts f where f.order_count <> 0) as first_dimensions
    union all select * from (select 86400 as grain_seconds, 'delivery' as dimension_kind,
    ((cast(f.created_at / 86400 as bigint) - case when f.created_at < 0 and f.created_at <> cast(f.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400) as bucket_start,
    f.shop_currency, case when f.requires_shipping = 0 then 'none' when f.shipping_method_kind = 'pickup' then 'pickup' when f.shipping_method_id is null then 'unknown' else 'method' end as key1, coalesce(f.shipping_method_id, '') as key2, f.order_count, 0 as placed, 0 as cancelled, f.gross, f.disc, f.returns, f.shipping, f.taxes, f.net_units, 0 as cod, 0 as rts, 0 as cod_delivered, 0 as refunded
    from analytics_order_facts f where f.order_count <> 0 union all select 86400 as grain_seconds, 'location' as dimension_kind,
    ((cast(f.created_at / 86400 as bigint) - case when f.created_at < 0 and f.created_at <> cast(f.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400) as bucket_start,
    f.shop_currency, case when f.fulfillment_location_id is null then 'default' else 'id' end as key1, coalesce(f.fulfillment_location_id, '') as key2, f.order_count, 0 as placed, 0 as cancelled, f.gross, f.disc, f.returns, f.shipping, f.taxes, f.net_units, 0 as cod, 0 as rts, 0 as cod_delivered, 0 as refunded
    from analytics_order_facts f where f.order_count <> 0 union all select 900 as grain_seconds, 'total' as dimension_kind,
    ((cast(f.created_at / 900 as bigint) - case when f.created_at < 0 and f.created_at <> cast(f.created_at / 900 as bigint) * 900 then 1 else 0 end) * 900) as bucket_start,
    f.shop_currency, '' as key1, '' as key2, f.order_count, f.placed, f.cancelled, f.gross, f.disc, f.returns, f.shipping, f.taxes, f.net_units, f.cod, f.rts, f.cod_delivered, f.refunded from analytics_order_facts f where f.placed <> 0) as last_dimensions) as contributions
    group by grain_seconds, dimension_kind, bucket_start, shop_currency, key1, key2;
--> statement-breakpoint
insert into analytics_customer_first_sale (identity, first_sale_at) select identity, min(created_at) from analytics_order_facts where order_count = 1 group by identity;
--> statement-breakpoint
insert into analytics_customer_currency_summary
    (identity, shop_currency, first_sale_at, second_sale_at, last_sale_at, first_sale_any_currency_at)
    select c.identity, c.shop_currency, c.first_sale_at,
      (select f.created_at from analytics_order_facts f
        where f.shop_currency = c.shop_currency and f.identity = c.identity and f.order_count = 1
        order by f.created_at limit 1 offset 1),
      c.last_sale_at, fs.first_sale_at
    from (select identity, shop_currency, min(created_at) as first_sale_at, max(created_at) as last_sale_at
      from analytics_order_facts where order_count = 1 group by shop_currency, identity) c
    left join analytics_customer_first_sale fs on fs.identity = c.identity;
--> statement-breakpoint
CREATE TRIGGER analytics_orders_insert
AFTER INSERT ON orders
BEGIN
  insert into analytics_order_facts (order_id, created_at, shop_currency, identity, channel, channel_source, payment_method, city_name, shipping_method_id, shipping_method_kind, requires_shipping, fulfillment_location_id, order_count, placed, cancelled, gross, disc, returns, shipping, taxes, net_units, cod, rts, cod_delivered, refunded)
    select * from (with ao as materialized (select o.id, o.created_at, o.deleted_at, o.status, o.shop_currency, o.currency_code, o.currency_decimal_places, o.fx_rate, o.prices_include_tax, o.shipping_amount_minor, o.discount_amount_minor, o.tax_amount_minor, o.customer_id, o.customer_phone, o.channel, o.channel_source, o.payment_method, o.city_name, o.shipping_method_id, o.shipping_method_kind, o.requires_shipping, o.fulfillment_location_id from orders o where o.id in (NEW.id)),
    so as materialized (
      select o.id, o.created_at, o.status, o.payment_method, o.channel, o.channel_source,
        o.city_name, o.fulfillment_location_id, o.shipping_method_id, o.shipping_method_kind,
        o.requires_shipping, o.customer_id, o.customer_phone, o.prices_include_tax as incl,
        case when o.currency_code = o.shop_currency then o.shipping_amount_minor else cast(round(o.shipping_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as shipping_amount_minor, case when o.currency_code = o.shop_currency then o.discount_amount_minor else cast(round(o.discount_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as discount_amount_minor, case when o.currency_code = o.shop_currency then o.tax_amount_minor else cast(round(o.tax_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as tax_amount_minor,
        case when o.currency_code = o.shop_currency then 0 else 1 end as fx,
        case when o.currency_code = o.shop_currency then 1.0 else (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end) end as fxm,
        case when o.status in ('returned', 'refunded') then 1 else 0 end as reversed
      from ao o where o.deleted_at is null and o.status not in ('incomplete', 'cancelled')
    ), rq as (
    select rl.order_item_id, cast(sum(rl.approved_quantity) as bigint) as approved
    from so
    cross join order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = so.id and rr.status in ('approved', 'receiving', 'completed')
    group by rl.order_item_id
  ),
  sl as (
    select oi.id as line_id, oi.order_id, oi.product_id, oi.variant_id, oi.quantity,
      oi.product_name, oi.variant_label, so.created_at, so.reversed,
      case when oi.fulfillment_type = 'gift_card' then 1 else 0 end as gc,
      (case when so.fx = 0 then (oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) else cast(round((oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) * so.fxm, 0) as bigint) end) as gross,
      (case when so.fx = 0 then (oi.discount_amount_minor) else cast(round((oi.discount_amount_minor) * so.fxm, 0) as bigint) end) as disc,
      (case when so.fx = 0 then (oi.tax_amount_minor) else cast(round((oi.tax_amount_minor) * so.fxm, 0) as bigint) end) as tax,
      null as unit_cost,
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
  ), lo as (
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
  )
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
      coalesce((case when om.fx = 0 then ((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) else cast(round(((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) * om.fxm, 0) as bigint) end), 0) as refunded
    from ao o left join om on om.id = o.id) as refreshed where 1 = 1
    on conflict (order_id) do update set created_at = excluded.created_at, shop_currency = excluded.shop_currency, identity = excluded.identity, channel = excluded.channel, channel_source = excluded.channel_source, payment_method = excluded.payment_method, city_name = excluded.city_name, shipping_method_id = excluded.shipping_method_id, shipping_method_kind = excluded.shipping_method_kind, requires_shipping = excluded.requires_shipping, fulfillment_location_id = excluded.fulfillment_location_id, order_count = excluded.order_count, placed = excluded.placed, cancelled = excluded.cancelled, gross = excluded.gross, disc = excluded.disc, returns = excluded.returns, shipping = excluded.shipping, taxes = excluded.taxes, net_units = excluded.net_units, cod = excluded.cod, rts = excluded.rts, cod_delivered = excluded.cod_delivered, refunded = excluded.refunded
    where analytics_order_facts.created_at IS NOT excluded.created_at OR analytics_order_facts.shop_currency IS NOT excluded.shop_currency OR analytics_order_facts.identity IS NOT excluded.identity OR analytics_order_facts.channel IS NOT excluded.channel OR analytics_order_facts.channel_source IS NOT excluded.channel_source OR analytics_order_facts.payment_method IS NOT excluded.payment_method OR analytics_order_facts.city_name IS NOT excluded.city_name OR analytics_order_facts.shipping_method_id IS NOT excluded.shipping_method_id OR analytics_order_facts.shipping_method_kind IS NOT excluded.shipping_method_kind OR analytics_order_facts.requires_shipping IS NOT excluded.requires_shipping OR analytics_order_facts.fulfillment_location_id IS NOT excluded.fulfillment_location_id OR analytics_order_facts.order_count IS NOT excluded.order_count OR analytics_order_facts.placed IS NOT excluded.placed OR analytics_order_facts.cancelled IS NOT excluded.cancelled OR analytics_order_facts.gross IS NOT excluded.gross OR analytics_order_facts.disc IS NOT excluded.disc OR analytics_order_facts.returns IS NOT excluded.returns OR analytics_order_facts.shipping IS NOT excluded.shipping OR analytics_order_facts.taxes IS NOT excluded.taxes OR analytics_order_facts.net_units IS NOT excluded.net_units OR analytics_order_facts.cod IS NOT excluded.cod OR analytics_order_facts.rts IS NOT excluded.rts OR analytics_order_facts.cod_delivered IS NOT excluded.cod_delivered OR analytics_order_facts.refunded IS NOT excluded.refunded;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_orders_update
AFTER UPDATE OF id, created_at, deleted_at, status, shop_currency, currency_code, currency_decimal_places, fx_rate, prices_include_tax, shipping_amount_minor, discount_amount_minor, tax_amount_minor, customer_id, customer_phone, channel, channel_source, payment_method, city_name, shipping_method_id, shipping_method_kind, requires_shipping, fulfillment_location_id ON orders
WHEN OLD.id IS NOT NEW.id OR OLD.created_at IS NOT NEW.created_at OR OLD.deleted_at IS NOT NEW.deleted_at OR OLD.status IS NOT NEW.status OR OLD.shop_currency IS NOT NEW.shop_currency OR OLD.currency_code IS NOT NEW.currency_code OR OLD.currency_decimal_places IS NOT NEW.currency_decimal_places OR OLD.fx_rate IS NOT NEW.fx_rate OR OLD.prices_include_tax IS NOT NEW.prices_include_tax OR OLD.shipping_amount_minor IS NOT NEW.shipping_amount_minor OR OLD.discount_amount_minor IS NOT NEW.discount_amount_minor OR OLD.tax_amount_minor IS NOT NEW.tax_amount_minor OR OLD.customer_id IS NOT NEW.customer_id OR OLD.customer_phone IS NOT NEW.customer_phone OR OLD.channel IS NOT NEW.channel OR OLD.channel_source IS NOT NEW.channel_source OR OLD.payment_method IS NOT NEW.payment_method OR OLD.city_name IS NOT NEW.city_name OR OLD.shipping_method_id IS NOT NEW.shipping_method_id OR OLD.shipping_method_kind IS NOT NEW.shipping_method_kind OR OLD.requires_shipping IS NOT NEW.requires_shipping OR OLD.fulfillment_location_id IS NOT NEW.fulfillment_location_id
BEGIN
  insert into analytics_order_facts (order_id, created_at, shop_currency, identity, channel, channel_source, payment_method, city_name, shipping_method_id, shipping_method_kind, requires_shipping, fulfillment_location_id, order_count, placed, cancelled, gross, disc, returns, shipping, taxes, net_units, cod, rts, cod_delivered, refunded)
    select * from (with ao as materialized (select o.id, o.created_at, o.deleted_at, o.status, o.shop_currency, o.currency_code, o.currency_decimal_places, o.fx_rate, o.prices_include_tax, o.shipping_amount_minor, o.discount_amount_minor, o.tax_amount_minor, o.customer_id, o.customer_phone, o.channel, o.channel_source, o.payment_method, o.city_name, o.shipping_method_id, o.shipping_method_kind, o.requires_shipping, o.fulfillment_location_id from orders o where o.id in (OLD.id, NEW.id)),
    so as materialized (
      select o.id, o.created_at, o.status, o.payment_method, o.channel, o.channel_source,
        o.city_name, o.fulfillment_location_id, o.shipping_method_id, o.shipping_method_kind,
        o.requires_shipping, o.customer_id, o.customer_phone, o.prices_include_tax as incl,
        case when o.currency_code = o.shop_currency then o.shipping_amount_minor else cast(round(o.shipping_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as shipping_amount_minor, case when o.currency_code = o.shop_currency then o.discount_amount_minor else cast(round(o.discount_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as discount_amount_minor, case when o.currency_code = o.shop_currency then o.tax_amount_minor else cast(round(o.tax_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as tax_amount_minor,
        case when o.currency_code = o.shop_currency then 0 else 1 end as fx,
        case when o.currency_code = o.shop_currency then 1.0 else (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end) end as fxm,
        case when o.status in ('returned', 'refunded') then 1 else 0 end as reversed
      from ao o where o.deleted_at is null and o.status not in ('incomplete', 'cancelled')
    ), rq as (
    select rl.order_item_id, cast(sum(rl.approved_quantity) as bigint) as approved
    from so
    cross join order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = so.id and rr.status in ('approved', 'receiving', 'completed')
    group by rl.order_item_id
  ),
  sl as (
    select oi.id as line_id, oi.order_id, oi.product_id, oi.variant_id, oi.quantity,
      oi.product_name, oi.variant_label, so.created_at, so.reversed,
      case when oi.fulfillment_type = 'gift_card' then 1 else 0 end as gc,
      (case when so.fx = 0 then (oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) else cast(round((oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) * so.fxm, 0) as bigint) end) as gross,
      (case when so.fx = 0 then (oi.discount_amount_minor) else cast(round((oi.discount_amount_minor) * so.fxm, 0) as bigint) end) as disc,
      (case when so.fx = 0 then (oi.tax_amount_minor) else cast(round((oi.tax_amount_minor) * so.fxm, 0) as bigint) end) as tax,
      null as unit_cost,
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
  ), lo as (
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
  )
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
      coalesce((case when om.fx = 0 then ((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) else cast(round(((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) * om.fxm, 0) as bigint) end), 0) as refunded
    from ao o left join om on om.id = o.id) as refreshed where 1 = 1
    on conflict (order_id) do update set created_at = excluded.created_at, shop_currency = excluded.shop_currency, identity = excluded.identity, channel = excluded.channel, channel_source = excluded.channel_source, payment_method = excluded.payment_method, city_name = excluded.city_name, shipping_method_id = excluded.shipping_method_id, shipping_method_kind = excluded.shipping_method_kind, requires_shipping = excluded.requires_shipping, fulfillment_location_id = excluded.fulfillment_location_id, order_count = excluded.order_count, placed = excluded.placed, cancelled = excluded.cancelled, gross = excluded.gross, disc = excluded.disc, returns = excluded.returns, shipping = excluded.shipping, taxes = excluded.taxes, net_units = excluded.net_units, cod = excluded.cod, rts = excluded.rts, cod_delivered = excluded.cod_delivered, refunded = excluded.refunded
    where analytics_order_facts.created_at IS NOT excluded.created_at OR analytics_order_facts.shop_currency IS NOT excluded.shop_currency OR analytics_order_facts.identity IS NOT excluded.identity OR analytics_order_facts.channel IS NOT excluded.channel OR analytics_order_facts.channel_source IS NOT excluded.channel_source OR analytics_order_facts.payment_method IS NOT excluded.payment_method OR analytics_order_facts.city_name IS NOT excluded.city_name OR analytics_order_facts.shipping_method_id IS NOT excluded.shipping_method_id OR analytics_order_facts.shipping_method_kind IS NOT excluded.shipping_method_kind OR analytics_order_facts.requires_shipping IS NOT excluded.requires_shipping OR analytics_order_facts.fulfillment_location_id IS NOT excluded.fulfillment_location_id OR analytics_order_facts.order_count IS NOT excluded.order_count OR analytics_order_facts.placed IS NOT excluded.placed OR analytics_order_facts.cancelled IS NOT excluded.cancelled OR analytics_order_facts.gross IS NOT excluded.gross OR analytics_order_facts.disc IS NOT excluded.disc OR analytics_order_facts.returns IS NOT excluded.returns OR analytics_order_facts.shipping IS NOT excluded.shipping OR analytics_order_facts.taxes IS NOT excluded.taxes OR analytics_order_facts.net_units IS NOT excluded.net_units OR analytics_order_facts.cod IS NOT excluded.cod OR analytics_order_facts.rts IS NOT excluded.rts OR analytics_order_facts.cod_delivered IS NOT excluded.cod_delivered OR analytics_order_facts.refunded IS NOT excluded.refunded;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_order_items_insert
AFTER INSERT ON order_items
BEGIN
  insert into analytics_order_facts (order_id, created_at, shop_currency, identity, channel, channel_source, payment_method, city_name, shipping_method_id, shipping_method_kind, requires_shipping, fulfillment_location_id, order_count, placed, cancelled, gross, disc, returns, shipping, taxes, net_units, cod, rts, cod_delivered, refunded)
    select * from (with ao as materialized (select o.id, o.created_at, o.deleted_at, o.status, o.shop_currency, o.currency_code, o.currency_decimal_places, o.fx_rate, o.prices_include_tax, o.shipping_amount_minor, o.discount_amount_minor, o.tax_amount_minor, o.customer_id, o.customer_phone, o.channel, o.channel_source, o.payment_method, o.city_name, o.shipping_method_id, o.shipping_method_kind, o.requires_shipping, o.fulfillment_location_id from orders o where o.id in (NEW.order_id)),
    so as materialized (
      select o.id, o.created_at, o.status, o.payment_method, o.channel, o.channel_source,
        o.city_name, o.fulfillment_location_id, o.shipping_method_id, o.shipping_method_kind,
        o.requires_shipping, o.customer_id, o.customer_phone, o.prices_include_tax as incl,
        case when o.currency_code = o.shop_currency then o.shipping_amount_minor else cast(round(o.shipping_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as shipping_amount_minor, case when o.currency_code = o.shop_currency then o.discount_amount_minor else cast(round(o.discount_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as discount_amount_minor, case when o.currency_code = o.shop_currency then o.tax_amount_minor else cast(round(o.tax_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as tax_amount_minor,
        case when o.currency_code = o.shop_currency then 0 else 1 end as fx,
        case when o.currency_code = o.shop_currency then 1.0 else (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end) end as fxm,
        case when o.status in ('returned', 'refunded') then 1 else 0 end as reversed
      from ao o where o.deleted_at is null and o.status not in ('incomplete', 'cancelled')
    ), rq as (
    select rl.order_item_id, cast(sum(rl.approved_quantity) as bigint) as approved
    from so
    cross join order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = so.id and rr.status in ('approved', 'receiving', 'completed')
    group by rl.order_item_id
  ),
  sl as (
    select oi.id as line_id, oi.order_id, oi.product_id, oi.variant_id, oi.quantity,
      oi.product_name, oi.variant_label, so.created_at, so.reversed,
      case when oi.fulfillment_type = 'gift_card' then 1 else 0 end as gc,
      (case when so.fx = 0 then (oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) else cast(round((oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) * so.fxm, 0) as bigint) end) as gross,
      (case when so.fx = 0 then (oi.discount_amount_minor) else cast(round((oi.discount_amount_minor) * so.fxm, 0) as bigint) end) as disc,
      (case when so.fx = 0 then (oi.tax_amount_minor) else cast(round((oi.tax_amount_minor) * so.fxm, 0) as bigint) end) as tax,
      null as unit_cost,
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
  ), lo as (
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
  )
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
      coalesce((case when om.fx = 0 then ((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) else cast(round(((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) * om.fxm, 0) as bigint) end), 0) as refunded
    from ao o left join om on om.id = o.id) as refreshed where 1 = 1
    on conflict (order_id) do update set created_at = excluded.created_at, shop_currency = excluded.shop_currency, identity = excluded.identity, channel = excluded.channel, channel_source = excluded.channel_source, payment_method = excluded.payment_method, city_name = excluded.city_name, shipping_method_id = excluded.shipping_method_id, shipping_method_kind = excluded.shipping_method_kind, requires_shipping = excluded.requires_shipping, fulfillment_location_id = excluded.fulfillment_location_id, order_count = excluded.order_count, placed = excluded.placed, cancelled = excluded.cancelled, gross = excluded.gross, disc = excluded.disc, returns = excluded.returns, shipping = excluded.shipping, taxes = excluded.taxes, net_units = excluded.net_units, cod = excluded.cod, rts = excluded.rts, cod_delivered = excluded.cod_delivered, refunded = excluded.refunded
    where analytics_order_facts.created_at IS NOT excluded.created_at OR analytics_order_facts.shop_currency IS NOT excluded.shop_currency OR analytics_order_facts.identity IS NOT excluded.identity OR analytics_order_facts.channel IS NOT excluded.channel OR analytics_order_facts.channel_source IS NOT excluded.channel_source OR analytics_order_facts.payment_method IS NOT excluded.payment_method OR analytics_order_facts.city_name IS NOT excluded.city_name OR analytics_order_facts.shipping_method_id IS NOT excluded.shipping_method_id OR analytics_order_facts.shipping_method_kind IS NOT excluded.shipping_method_kind OR analytics_order_facts.requires_shipping IS NOT excluded.requires_shipping OR analytics_order_facts.fulfillment_location_id IS NOT excluded.fulfillment_location_id OR analytics_order_facts.order_count IS NOT excluded.order_count OR analytics_order_facts.placed IS NOT excluded.placed OR analytics_order_facts.cancelled IS NOT excluded.cancelled OR analytics_order_facts.gross IS NOT excluded.gross OR analytics_order_facts.disc IS NOT excluded.disc OR analytics_order_facts.returns IS NOT excluded.returns OR analytics_order_facts.shipping IS NOT excluded.shipping OR analytics_order_facts.taxes IS NOT excluded.taxes OR analytics_order_facts.net_units IS NOT excluded.net_units OR analytics_order_facts.cod IS NOT excluded.cod OR analytics_order_facts.rts IS NOT excluded.rts OR analytics_order_facts.cod_delivered IS NOT excluded.cod_delivered OR analytics_order_facts.refunded IS NOT excluded.refunded;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_order_items_update
AFTER UPDATE OF order_id, quantity, fulfillment_type, line_subtotal_minor, discount_amount_minor, tax_amount_minor ON order_items
WHEN OLD.order_id IS NOT NEW.order_id OR OLD.quantity IS NOT NEW.quantity OR OLD.fulfillment_type IS NOT NEW.fulfillment_type OR OLD.line_subtotal_minor IS NOT NEW.line_subtotal_minor OR OLD.discount_amount_minor IS NOT NEW.discount_amount_minor OR OLD.tax_amount_minor IS NOT NEW.tax_amount_minor
BEGIN
  insert into analytics_order_facts (order_id, created_at, shop_currency, identity, channel, channel_source, payment_method, city_name, shipping_method_id, shipping_method_kind, requires_shipping, fulfillment_location_id, order_count, placed, cancelled, gross, disc, returns, shipping, taxes, net_units, cod, rts, cod_delivered, refunded)
    select * from (with ao as materialized (select o.id, o.created_at, o.deleted_at, o.status, o.shop_currency, o.currency_code, o.currency_decimal_places, o.fx_rate, o.prices_include_tax, o.shipping_amount_minor, o.discount_amount_minor, o.tax_amount_minor, o.customer_id, o.customer_phone, o.channel, o.channel_source, o.payment_method, o.city_name, o.shipping_method_id, o.shipping_method_kind, o.requires_shipping, o.fulfillment_location_id from orders o where o.id in (OLD.order_id, NEW.order_id)),
    so as materialized (
      select o.id, o.created_at, o.status, o.payment_method, o.channel, o.channel_source,
        o.city_name, o.fulfillment_location_id, o.shipping_method_id, o.shipping_method_kind,
        o.requires_shipping, o.customer_id, o.customer_phone, o.prices_include_tax as incl,
        case when o.currency_code = o.shop_currency then o.shipping_amount_minor else cast(round(o.shipping_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as shipping_amount_minor, case when o.currency_code = o.shop_currency then o.discount_amount_minor else cast(round(o.discount_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as discount_amount_minor, case when o.currency_code = o.shop_currency then o.tax_amount_minor else cast(round(o.tax_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as tax_amount_minor,
        case when o.currency_code = o.shop_currency then 0 else 1 end as fx,
        case when o.currency_code = o.shop_currency then 1.0 else (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end) end as fxm,
        case when o.status in ('returned', 'refunded') then 1 else 0 end as reversed
      from ao o where o.deleted_at is null and o.status not in ('incomplete', 'cancelled')
    ), rq as (
    select rl.order_item_id, cast(sum(rl.approved_quantity) as bigint) as approved
    from so
    cross join order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = so.id and rr.status in ('approved', 'receiving', 'completed')
    group by rl.order_item_id
  ),
  sl as (
    select oi.id as line_id, oi.order_id, oi.product_id, oi.variant_id, oi.quantity,
      oi.product_name, oi.variant_label, so.created_at, so.reversed,
      case when oi.fulfillment_type = 'gift_card' then 1 else 0 end as gc,
      (case when so.fx = 0 then (oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) else cast(round((oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) * so.fxm, 0) as bigint) end) as gross,
      (case when so.fx = 0 then (oi.discount_amount_minor) else cast(round((oi.discount_amount_minor) * so.fxm, 0) as bigint) end) as disc,
      (case when so.fx = 0 then (oi.tax_amount_minor) else cast(round((oi.tax_amount_minor) * so.fxm, 0) as bigint) end) as tax,
      null as unit_cost,
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
  ), lo as (
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
  )
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
      coalesce((case when om.fx = 0 then ((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) else cast(round(((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) * om.fxm, 0) as bigint) end), 0) as refunded
    from ao o left join om on om.id = o.id) as refreshed where 1 = 1
    on conflict (order_id) do update set created_at = excluded.created_at, shop_currency = excluded.shop_currency, identity = excluded.identity, channel = excluded.channel, channel_source = excluded.channel_source, payment_method = excluded.payment_method, city_name = excluded.city_name, shipping_method_id = excluded.shipping_method_id, shipping_method_kind = excluded.shipping_method_kind, requires_shipping = excluded.requires_shipping, fulfillment_location_id = excluded.fulfillment_location_id, order_count = excluded.order_count, placed = excluded.placed, cancelled = excluded.cancelled, gross = excluded.gross, disc = excluded.disc, returns = excluded.returns, shipping = excluded.shipping, taxes = excluded.taxes, net_units = excluded.net_units, cod = excluded.cod, rts = excluded.rts, cod_delivered = excluded.cod_delivered, refunded = excluded.refunded
    where analytics_order_facts.created_at IS NOT excluded.created_at OR analytics_order_facts.shop_currency IS NOT excluded.shop_currency OR analytics_order_facts.identity IS NOT excluded.identity OR analytics_order_facts.channel IS NOT excluded.channel OR analytics_order_facts.channel_source IS NOT excluded.channel_source OR analytics_order_facts.payment_method IS NOT excluded.payment_method OR analytics_order_facts.city_name IS NOT excluded.city_name OR analytics_order_facts.shipping_method_id IS NOT excluded.shipping_method_id OR analytics_order_facts.shipping_method_kind IS NOT excluded.shipping_method_kind OR analytics_order_facts.requires_shipping IS NOT excluded.requires_shipping OR analytics_order_facts.fulfillment_location_id IS NOT excluded.fulfillment_location_id OR analytics_order_facts.order_count IS NOT excluded.order_count OR analytics_order_facts.placed IS NOT excluded.placed OR analytics_order_facts.cancelled IS NOT excluded.cancelled OR analytics_order_facts.gross IS NOT excluded.gross OR analytics_order_facts.disc IS NOT excluded.disc OR analytics_order_facts.returns IS NOT excluded.returns OR analytics_order_facts.shipping IS NOT excluded.shipping OR analytics_order_facts.taxes IS NOT excluded.taxes OR analytics_order_facts.net_units IS NOT excluded.net_units OR analytics_order_facts.cod IS NOT excluded.cod OR analytics_order_facts.rts IS NOT excluded.rts OR analytics_order_facts.cod_delivered IS NOT excluded.cod_delivered OR analytics_order_facts.refunded IS NOT excluded.refunded;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_order_items_delete
AFTER DELETE ON order_items
BEGIN
  insert into analytics_order_facts (order_id, created_at, shop_currency, identity, channel, channel_source, payment_method, city_name, shipping_method_id, shipping_method_kind, requires_shipping, fulfillment_location_id, order_count, placed, cancelled, gross, disc, returns, shipping, taxes, net_units, cod, rts, cod_delivered, refunded)
    select * from (with ao as materialized (select o.id, o.created_at, o.deleted_at, o.status, o.shop_currency, o.currency_code, o.currency_decimal_places, o.fx_rate, o.prices_include_tax, o.shipping_amount_minor, o.discount_amount_minor, o.tax_amount_minor, o.customer_id, o.customer_phone, o.channel, o.channel_source, o.payment_method, o.city_name, o.shipping_method_id, o.shipping_method_kind, o.requires_shipping, o.fulfillment_location_id from orders o where o.id in (OLD.order_id)),
    so as materialized (
      select o.id, o.created_at, o.status, o.payment_method, o.channel, o.channel_source,
        o.city_name, o.fulfillment_location_id, o.shipping_method_id, o.shipping_method_kind,
        o.requires_shipping, o.customer_id, o.customer_phone, o.prices_include_tax as incl,
        case when o.currency_code = o.shop_currency then o.shipping_amount_minor else cast(round(o.shipping_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as shipping_amount_minor, case when o.currency_code = o.shop_currency then o.discount_amount_minor else cast(round(o.discount_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as discount_amount_minor, case when o.currency_code = o.shop_currency then o.tax_amount_minor else cast(round(o.tax_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as tax_amount_minor,
        case when o.currency_code = o.shop_currency then 0 else 1 end as fx,
        case when o.currency_code = o.shop_currency then 1.0 else (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end) end as fxm,
        case when o.status in ('returned', 'refunded') then 1 else 0 end as reversed
      from ao o where o.deleted_at is null and o.status not in ('incomplete', 'cancelled')
    ), rq as (
    select rl.order_item_id, cast(sum(rl.approved_quantity) as bigint) as approved
    from so
    cross join order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = so.id and rr.status in ('approved', 'receiving', 'completed')
    group by rl.order_item_id
  ),
  sl as (
    select oi.id as line_id, oi.order_id, oi.product_id, oi.variant_id, oi.quantity,
      oi.product_name, oi.variant_label, so.created_at, so.reversed,
      case when oi.fulfillment_type = 'gift_card' then 1 else 0 end as gc,
      (case when so.fx = 0 then (oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) else cast(round((oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) * so.fxm, 0) as bigint) end) as gross,
      (case when so.fx = 0 then (oi.discount_amount_minor) else cast(round((oi.discount_amount_minor) * so.fxm, 0) as bigint) end) as disc,
      (case when so.fx = 0 then (oi.tax_amount_minor) else cast(round((oi.tax_amount_minor) * so.fxm, 0) as bigint) end) as tax,
      null as unit_cost,
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
  ), lo as (
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
  )
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
      coalesce((case when om.fx = 0 then ((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) else cast(round(((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) * om.fxm, 0) as bigint) end), 0) as refunded
    from ao o left join om on om.id = o.id) as refreshed where 1 = 1
    on conflict (order_id) do update set created_at = excluded.created_at, shop_currency = excluded.shop_currency, identity = excluded.identity, channel = excluded.channel, channel_source = excluded.channel_source, payment_method = excluded.payment_method, city_name = excluded.city_name, shipping_method_id = excluded.shipping_method_id, shipping_method_kind = excluded.shipping_method_kind, requires_shipping = excluded.requires_shipping, fulfillment_location_id = excluded.fulfillment_location_id, order_count = excluded.order_count, placed = excluded.placed, cancelled = excluded.cancelled, gross = excluded.gross, disc = excluded.disc, returns = excluded.returns, shipping = excluded.shipping, taxes = excluded.taxes, net_units = excluded.net_units, cod = excluded.cod, rts = excluded.rts, cod_delivered = excluded.cod_delivered, refunded = excluded.refunded
    where analytics_order_facts.created_at IS NOT excluded.created_at OR analytics_order_facts.shop_currency IS NOT excluded.shop_currency OR analytics_order_facts.identity IS NOT excluded.identity OR analytics_order_facts.channel IS NOT excluded.channel OR analytics_order_facts.channel_source IS NOT excluded.channel_source OR analytics_order_facts.payment_method IS NOT excluded.payment_method OR analytics_order_facts.city_name IS NOT excluded.city_name OR analytics_order_facts.shipping_method_id IS NOT excluded.shipping_method_id OR analytics_order_facts.shipping_method_kind IS NOT excluded.shipping_method_kind OR analytics_order_facts.requires_shipping IS NOT excluded.requires_shipping OR analytics_order_facts.fulfillment_location_id IS NOT excluded.fulfillment_location_id OR analytics_order_facts.order_count IS NOT excluded.order_count OR analytics_order_facts.placed IS NOT excluded.placed OR analytics_order_facts.cancelled IS NOT excluded.cancelled OR analytics_order_facts.gross IS NOT excluded.gross OR analytics_order_facts.disc IS NOT excluded.disc OR analytics_order_facts.returns IS NOT excluded.returns OR analytics_order_facts.shipping IS NOT excluded.shipping OR analytics_order_facts.taxes IS NOT excluded.taxes OR analytics_order_facts.net_units IS NOT excluded.net_units OR analytics_order_facts.cod IS NOT excluded.cod OR analytics_order_facts.rts IS NOT excluded.rts OR analytics_order_facts.cod_delivered IS NOT excluded.cod_delivered OR analytics_order_facts.refunded IS NOT excluded.refunded;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_order_returns_insert
AFTER INSERT ON order_returns
BEGIN
  insert into analytics_order_facts (order_id, created_at, shop_currency, identity, channel, channel_source, payment_method, city_name, shipping_method_id, shipping_method_kind, requires_shipping, fulfillment_location_id, order_count, placed, cancelled, gross, disc, returns, shipping, taxes, net_units, cod, rts, cod_delivered, refunded)
    select * from (with ao as materialized (select o.id, o.created_at, o.deleted_at, o.status, o.shop_currency, o.currency_code, o.currency_decimal_places, o.fx_rate, o.prices_include_tax, o.shipping_amount_minor, o.discount_amount_minor, o.tax_amount_minor, o.customer_id, o.customer_phone, o.channel, o.channel_source, o.payment_method, o.city_name, o.shipping_method_id, o.shipping_method_kind, o.requires_shipping, o.fulfillment_location_id from orders o where o.id in (NEW.order_id)),
    so as materialized (
      select o.id, o.created_at, o.status, o.payment_method, o.channel, o.channel_source,
        o.city_name, o.fulfillment_location_id, o.shipping_method_id, o.shipping_method_kind,
        o.requires_shipping, o.customer_id, o.customer_phone, o.prices_include_tax as incl,
        case when o.currency_code = o.shop_currency then o.shipping_amount_minor else cast(round(o.shipping_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as shipping_amount_minor, case when o.currency_code = o.shop_currency then o.discount_amount_minor else cast(round(o.discount_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as discount_amount_minor, case when o.currency_code = o.shop_currency then o.tax_amount_minor else cast(round(o.tax_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as tax_amount_minor,
        case when o.currency_code = o.shop_currency then 0 else 1 end as fx,
        case when o.currency_code = o.shop_currency then 1.0 else (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end) end as fxm,
        case when o.status in ('returned', 'refunded') then 1 else 0 end as reversed
      from ao o where o.deleted_at is null and o.status not in ('incomplete', 'cancelled')
    ), rq as (
    select rl.order_item_id, cast(sum(rl.approved_quantity) as bigint) as approved
    from so
    cross join order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = so.id and rr.status in ('approved', 'receiving', 'completed')
    group by rl.order_item_id
  ),
  sl as (
    select oi.id as line_id, oi.order_id, oi.product_id, oi.variant_id, oi.quantity,
      oi.product_name, oi.variant_label, so.created_at, so.reversed,
      case when oi.fulfillment_type = 'gift_card' then 1 else 0 end as gc,
      (case when so.fx = 0 then (oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) else cast(round((oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) * so.fxm, 0) as bigint) end) as gross,
      (case when so.fx = 0 then (oi.discount_amount_minor) else cast(round((oi.discount_amount_minor) * so.fxm, 0) as bigint) end) as disc,
      (case when so.fx = 0 then (oi.tax_amount_minor) else cast(round((oi.tax_amount_minor) * so.fxm, 0) as bigint) end) as tax,
      null as unit_cost,
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
  ), lo as (
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
  )
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
      coalesce((case when om.fx = 0 then ((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) else cast(round(((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) * om.fxm, 0) as bigint) end), 0) as refunded
    from ao o left join om on om.id = o.id) as refreshed where 1 = 1
    on conflict (order_id) do update set created_at = excluded.created_at, shop_currency = excluded.shop_currency, identity = excluded.identity, channel = excluded.channel, channel_source = excluded.channel_source, payment_method = excluded.payment_method, city_name = excluded.city_name, shipping_method_id = excluded.shipping_method_id, shipping_method_kind = excluded.shipping_method_kind, requires_shipping = excluded.requires_shipping, fulfillment_location_id = excluded.fulfillment_location_id, order_count = excluded.order_count, placed = excluded.placed, cancelled = excluded.cancelled, gross = excluded.gross, disc = excluded.disc, returns = excluded.returns, shipping = excluded.shipping, taxes = excluded.taxes, net_units = excluded.net_units, cod = excluded.cod, rts = excluded.rts, cod_delivered = excluded.cod_delivered, refunded = excluded.refunded
    where analytics_order_facts.created_at IS NOT excluded.created_at OR analytics_order_facts.shop_currency IS NOT excluded.shop_currency OR analytics_order_facts.identity IS NOT excluded.identity OR analytics_order_facts.channel IS NOT excluded.channel OR analytics_order_facts.channel_source IS NOT excluded.channel_source OR analytics_order_facts.payment_method IS NOT excluded.payment_method OR analytics_order_facts.city_name IS NOT excluded.city_name OR analytics_order_facts.shipping_method_id IS NOT excluded.shipping_method_id OR analytics_order_facts.shipping_method_kind IS NOT excluded.shipping_method_kind OR analytics_order_facts.requires_shipping IS NOT excluded.requires_shipping OR analytics_order_facts.fulfillment_location_id IS NOT excluded.fulfillment_location_id OR analytics_order_facts.order_count IS NOT excluded.order_count OR analytics_order_facts.placed IS NOT excluded.placed OR analytics_order_facts.cancelled IS NOT excluded.cancelled OR analytics_order_facts.gross IS NOT excluded.gross OR analytics_order_facts.disc IS NOT excluded.disc OR analytics_order_facts.returns IS NOT excluded.returns OR analytics_order_facts.shipping IS NOT excluded.shipping OR analytics_order_facts.taxes IS NOT excluded.taxes OR analytics_order_facts.net_units IS NOT excluded.net_units OR analytics_order_facts.cod IS NOT excluded.cod OR analytics_order_facts.rts IS NOT excluded.rts OR analytics_order_facts.cod_delivered IS NOT excluded.cod_delivered OR analytics_order_facts.refunded IS NOT excluded.refunded;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_order_returns_update
AFTER UPDATE OF order_id, status ON order_returns
WHEN OLD.order_id IS NOT NEW.order_id OR OLD.status IS NOT NEW.status
BEGIN
  insert into analytics_order_facts (order_id, created_at, shop_currency, identity, channel, channel_source, payment_method, city_name, shipping_method_id, shipping_method_kind, requires_shipping, fulfillment_location_id, order_count, placed, cancelled, gross, disc, returns, shipping, taxes, net_units, cod, rts, cod_delivered, refunded)
    select * from (with ao as materialized (select o.id, o.created_at, o.deleted_at, o.status, o.shop_currency, o.currency_code, o.currency_decimal_places, o.fx_rate, o.prices_include_tax, o.shipping_amount_minor, o.discount_amount_minor, o.tax_amount_minor, o.customer_id, o.customer_phone, o.channel, o.channel_source, o.payment_method, o.city_name, o.shipping_method_id, o.shipping_method_kind, o.requires_shipping, o.fulfillment_location_id from orders o where o.id in (OLD.order_id, NEW.order_id)),
    so as materialized (
      select o.id, o.created_at, o.status, o.payment_method, o.channel, o.channel_source,
        o.city_name, o.fulfillment_location_id, o.shipping_method_id, o.shipping_method_kind,
        o.requires_shipping, o.customer_id, o.customer_phone, o.prices_include_tax as incl,
        case when o.currency_code = o.shop_currency then o.shipping_amount_minor else cast(round(o.shipping_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as shipping_amount_minor, case when o.currency_code = o.shop_currency then o.discount_amount_minor else cast(round(o.discount_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as discount_amount_minor, case when o.currency_code = o.shop_currency then o.tax_amount_minor else cast(round(o.tax_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as tax_amount_minor,
        case when o.currency_code = o.shop_currency then 0 else 1 end as fx,
        case when o.currency_code = o.shop_currency then 1.0 else (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end) end as fxm,
        case when o.status in ('returned', 'refunded') then 1 else 0 end as reversed
      from ao o where o.deleted_at is null and o.status not in ('incomplete', 'cancelled')
    ), rq as (
    select rl.order_item_id, cast(sum(rl.approved_quantity) as bigint) as approved
    from so
    cross join order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = so.id and rr.status in ('approved', 'receiving', 'completed')
    group by rl.order_item_id
  ),
  sl as (
    select oi.id as line_id, oi.order_id, oi.product_id, oi.variant_id, oi.quantity,
      oi.product_name, oi.variant_label, so.created_at, so.reversed,
      case when oi.fulfillment_type = 'gift_card' then 1 else 0 end as gc,
      (case when so.fx = 0 then (oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) else cast(round((oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) * so.fxm, 0) as bigint) end) as gross,
      (case when so.fx = 0 then (oi.discount_amount_minor) else cast(round((oi.discount_amount_minor) * so.fxm, 0) as bigint) end) as disc,
      (case when so.fx = 0 then (oi.tax_amount_minor) else cast(round((oi.tax_amount_minor) * so.fxm, 0) as bigint) end) as tax,
      null as unit_cost,
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
  ), lo as (
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
  )
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
      coalesce((case when om.fx = 0 then ((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) else cast(round(((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) * om.fxm, 0) as bigint) end), 0) as refunded
    from ao o left join om on om.id = o.id) as refreshed where 1 = 1
    on conflict (order_id) do update set created_at = excluded.created_at, shop_currency = excluded.shop_currency, identity = excluded.identity, channel = excluded.channel, channel_source = excluded.channel_source, payment_method = excluded.payment_method, city_name = excluded.city_name, shipping_method_id = excluded.shipping_method_id, shipping_method_kind = excluded.shipping_method_kind, requires_shipping = excluded.requires_shipping, fulfillment_location_id = excluded.fulfillment_location_id, order_count = excluded.order_count, placed = excluded.placed, cancelled = excluded.cancelled, gross = excluded.gross, disc = excluded.disc, returns = excluded.returns, shipping = excluded.shipping, taxes = excluded.taxes, net_units = excluded.net_units, cod = excluded.cod, rts = excluded.rts, cod_delivered = excluded.cod_delivered, refunded = excluded.refunded
    where analytics_order_facts.created_at IS NOT excluded.created_at OR analytics_order_facts.shop_currency IS NOT excluded.shop_currency OR analytics_order_facts.identity IS NOT excluded.identity OR analytics_order_facts.channel IS NOT excluded.channel OR analytics_order_facts.channel_source IS NOT excluded.channel_source OR analytics_order_facts.payment_method IS NOT excluded.payment_method OR analytics_order_facts.city_name IS NOT excluded.city_name OR analytics_order_facts.shipping_method_id IS NOT excluded.shipping_method_id OR analytics_order_facts.shipping_method_kind IS NOT excluded.shipping_method_kind OR analytics_order_facts.requires_shipping IS NOT excluded.requires_shipping OR analytics_order_facts.fulfillment_location_id IS NOT excluded.fulfillment_location_id OR analytics_order_facts.order_count IS NOT excluded.order_count OR analytics_order_facts.placed IS NOT excluded.placed OR analytics_order_facts.cancelled IS NOT excluded.cancelled OR analytics_order_facts.gross IS NOT excluded.gross OR analytics_order_facts.disc IS NOT excluded.disc OR analytics_order_facts.returns IS NOT excluded.returns OR analytics_order_facts.shipping IS NOT excluded.shipping OR analytics_order_facts.taxes IS NOT excluded.taxes OR analytics_order_facts.net_units IS NOT excluded.net_units OR analytics_order_facts.cod IS NOT excluded.cod OR analytics_order_facts.rts IS NOT excluded.rts OR analytics_order_facts.cod_delivered IS NOT excluded.cod_delivered OR analytics_order_facts.refunded IS NOT excluded.refunded;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_order_returns_delete
AFTER DELETE ON order_returns
BEGIN
  insert into analytics_order_facts (order_id, created_at, shop_currency, identity, channel, channel_source, payment_method, city_name, shipping_method_id, shipping_method_kind, requires_shipping, fulfillment_location_id, order_count, placed, cancelled, gross, disc, returns, shipping, taxes, net_units, cod, rts, cod_delivered, refunded)
    select * from (with ao as materialized (select o.id, o.created_at, o.deleted_at, o.status, o.shop_currency, o.currency_code, o.currency_decimal_places, o.fx_rate, o.prices_include_tax, o.shipping_amount_minor, o.discount_amount_minor, o.tax_amount_minor, o.customer_id, o.customer_phone, o.channel, o.channel_source, o.payment_method, o.city_name, o.shipping_method_id, o.shipping_method_kind, o.requires_shipping, o.fulfillment_location_id from orders o where o.id in (OLD.order_id)),
    so as materialized (
      select o.id, o.created_at, o.status, o.payment_method, o.channel, o.channel_source,
        o.city_name, o.fulfillment_location_id, o.shipping_method_id, o.shipping_method_kind,
        o.requires_shipping, o.customer_id, o.customer_phone, o.prices_include_tax as incl,
        case when o.currency_code = o.shop_currency then o.shipping_amount_minor else cast(round(o.shipping_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as shipping_amount_minor, case when o.currency_code = o.shop_currency then o.discount_amount_minor else cast(round(o.discount_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as discount_amount_minor, case when o.currency_code = o.shop_currency then o.tax_amount_minor else cast(round(o.tax_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as tax_amount_minor,
        case when o.currency_code = o.shop_currency then 0 else 1 end as fx,
        case when o.currency_code = o.shop_currency then 1.0 else (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end) end as fxm,
        case when o.status in ('returned', 'refunded') then 1 else 0 end as reversed
      from ao o where o.deleted_at is null and o.status not in ('incomplete', 'cancelled')
    ), rq as (
    select rl.order_item_id, cast(sum(rl.approved_quantity) as bigint) as approved
    from so
    cross join order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = so.id and rr.status in ('approved', 'receiving', 'completed')
    group by rl.order_item_id
  ),
  sl as (
    select oi.id as line_id, oi.order_id, oi.product_id, oi.variant_id, oi.quantity,
      oi.product_name, oi.variant_label, so.created_at, so.reversed,
      case when oi.fulfillment_type = 'gift_card' then 1 else 0 end as gc,
      (case when so.fx = 0 then (oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) else cast(round((oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) * so.fxm, 0) as bigint) end) as gross,
      (case when so.fx = 0 then (oi.discount_amount_minor) else cast(round((oi.discount_amount_minor) * so.fxm, 0) as bigint) end) as disc,
      (case when so.fx = 0 then (oi.tax_amount_minor) else cast(round((oi.tax_amount_minor) * so.fxm, 0) as bigint) end) as tax,
      null as unit_cost,
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
  ), lo as (
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
  )
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
      coalesce((case when om.fx = 0 then ((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) else cast(round(((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) * om.fxm, 0) as bigint) end), 0) as refunded
    from ao o left join om on om.id = o.id) as refreshed where 1 = 1
    on conflict (order_id) do update set created_at = excluded.created_at, shop_currency = excluded.shop_currency, identity = excluded.identity, channel = excluded.channel, channel_source = excluded.channel_source, payment_method = excluded.payment_method, city_name = excluded.city_name, shipping_method_id = excluded.shipping_method_id, shipping_method_kind = excluded.shipping_method_kind, requires_shipping = excluded.requires_shipping, fulfillment_location_id = excluded.fulfillment_location_id, order_count = excluded.order_count, placed = excluded.placed, cancelled = excluded.cancelled, gross = excluded.gross, disc = excluded.disc, returns = excluded.returns, shipping = excluded.shipping, taxes = excluded.taxes, net_units = excluded.net_units, cod = excluded.cod, rts = excluded.rts, cod_delivered = excluded.cod_delivered, refunded = excluded.refunded
    where analytics_order_facts.created_at IS NOT excluded.created_at OR analytics_order_facts.shop_currency IS NOT excluded.shop_currency OR analytics_order_facts.identity IS NOT excluded.identity OR analytics_order_facts.channel IS NOT excluded.channel OR analytics_order_facts.channel_source IS NOT excluded.channel_source OR analytics_order_facts.payment_method IS NOT excluded.payment_method OR analytics_order_facts.city_name IS NOT excluded.city_name OR analytics_order_facts.shipping_method_id IS NOT excluded.shipping_method_id OR analytics_order_facts.shipping_method_kind IS NOT excluded.shipping_method_kind OR analytics_order_facts.requires_shipping IS NOT excluded.requires_shipping OR analytics_order_facts.fulfillment_location_id IS NOT excluded.fulfillment_location_id OR analytics_order_facts.order_count IS NOT excluded.order_count OR analytics_order_facts.placed IS NOT excluded.placed OR analytics_order_facts.cancelled IS NOT excluded.cancelled OR analytics_order_facts.gross IS NOT excluded.gross OR analytics_order_facts.disc IS NOT excluded.disc OR analytics_order_facts.returns IS NOT excluded.returns OR analytics_order_facts.shipping IS NOT excluded.shipping OR analytics_order_facts.taxes IS NOT excluded.taxes OR analytics_order_facts.net_units IS NOT excluded.net_units OR analytics_order_facts.cod IS NOT excluded.cod OR analytics_order_facts.rts IS NOT excluded.rts OR analytics_order_facts.cod_delivered IS NOT excluded.cod_delivered OR analytics_order_facts.refunded IS NOT excluded.refunded;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_order_return_lines_insert
AFTER INSERT ON order_return_lines
BEGIN
  insert into analytics_order_facts (order_id, created_at, shop_currency, identity, channel, channel_source, payment_method, city_name, shipping_method_id, shipping_method_kind, requires_shipping, fulfillment_location_id, order_count, placed, cancelled, gross, disc, returns, shipping, taxes, net_units, cod, rts, cod_delivered, refunded)
    select * from (with ao as materialized (select o.id, o.created_at, o.deleted_at, o.status, o.shop_currency, o.currency_code, o.currency_decimal_places, o.fx_rate, o.prices_include_tax, o.shipping_amount_minor, o.discount_amount_minor, o.tax_amount_minor, o.customer_id, o.customer_phone, o.channel, o.channel_source, o.payment_method, o.city_name, o.shipping_method_id, o.shipping_method_kind, o.requires_shipping, o.fulfillment_location_id from orders o where o.id in (NEW.order_id)),
    so as materialized (
      select o.id, o.created_at, o.status, o.payment_method, o.channel, o.channel_source,
        o.city_name, o.fulfillment_location_id, o.shipping_method_id, o.shipping_method_kind,
        o.requires_shipping, o.customer_id, o.customer_phone, o.prices_include_tax as incl,
        case when o.currency_code = o.shop_currency then o.shipping_amount_minor else cast(round(o.shipping_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as shipping_amount_minor, case when o.currency_code = o.shop_currency then o.discount_amount_minor else cast(round(o.discount_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as discount_amount_minor, case when o.currency_code = o.shop_currency then o.tax_amount_minor else cast(round(o.tax_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as tax_amount_minor,
        case when o.currency_code = o.shop_currency then 0 else 1 end as fx,
        case when o.currency_code = o.shop_currency then 1.0 else (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end) end as fxm,
        case when o.status in ('returned', 'refunded') then 1 else 0 end as reversed
      from ao o where o.deleted_at is null and o.status not in ('incomplete', 'cancelled')
    ), rq as (
    select rl.order_item_id, cast(sum(rl.approved_quantity) as bigint) as approved
    from so
    cross join order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = so.id and rr.status in ('approved', 'receiving', 'completed')
    group by rl.order_item_id
  ),
  sl as (
    select oi.id as line_id, oi.order_id, oi.product_id, oi.variant_id, oi.quantity,
      oi.product_name, oi.variant_label, so.created_at, so.reversed,
      case when oi.fulfillment_type = 'gift_card' then 1 else 0 end as gc,
      (case when so.fx = 0 then (oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) else cast(round((oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) * so.fxm, 0) as bigint) end) as gross,
      (case when so.fx = 0 then (oi.discount_amount_minor) else cast(round((oi.discount_amount_minor) * so.fxm, 0) as bigint) end) as disc,
      (case when so.fx = 0 then (oi.tax_amount_minor) else cast(round((oi.tax_amount_minor) * so.fxm, 0) as bigint) end) as tax,
      null as unit_cost,
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
  ), lo as (
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
  )
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
      coalesce((case when om.fx = 0 then ((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) else cast(round(((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) * om.fxm, 0) as bigint) end), 0) as refunded
    from ao o left join om on om.id = o.id) as refreshed where 1 = 1
    on conflict (order_id) do update set created_at = excluded.created_at, shop_currency = excluded.shop_currency, identity = excluded.identity, channel = excluded.channel, channel_source = excluded.channel_source, payment_method = excluded.payment_method, city_name = excluded.city_name, shipping_method_id = excluded.shipping_method_id, shipping_method_kind = excluded.shipping_method_kind, requires_shipping = excluded.requires_shipping, fulfillment_location_id = excluded.fulfillment_location_id, order_count = excluded.order_count, placed = excluded.placed, cancelled = excluded.cancelled, gross = excluded.gross, disc = excluded.disc, returns = excluded.returns, shipping = excluded.shipping, taxes = excluded.taxes, net_units = excluded.net_units, cod = excluded.cod, rts = excluded.rts, cod_delivered = excluded.cod_delivered, refunded = excluded.refunded
    where analytics_order_facts.created_at IS NOT excluded.created_at OR analytics_order_facts.shop_currency IS NOT excluded.shop_currency OR analytics_order_facts.identity IS NOT excluded.identity OR analytics_order_facts.channel IS NOT excluded.channel OR analytics_order_facts.channel_source IS NOT excluded.channel_source OR analytics_order_facts.payment_method IS NOT excluded.payment_method OR analytics_order_facts.city_name IS NOT excluded.city_name OR analytics_order_facts.shipping_method_id IS NOT excluded.shipping_method_id OR analytics_order_facts.shipping_method_kind IS NOT excluded.shipping_method_kind OR analytics_order_facts.requires_shipping IS NOT excluded.requires_shipping OR analytics_order_facts.fulfillment_location_id IS NOT excluded.fulfillment_location_id OR analytics_order_facts.order_count IS NOT excluded.order_count OR analytics_order_facts.placed IS NOT excluded.placed OR analytics_order_facts.cancelled IS NOT excluded.cancelled OR analytics_order_facts.gross IS NOT excluded.gross OR analytics_order_facts.disc IS NOT excluded.disc OR analytics_order_facts.returns IS NOT excluded.returns OR analytics_order_facts.shipping IS NOT excluded.shipping OR analytics_order_facts.taxes IS NOT excluded.taxes OR analytics_order_facts.net_units IS NOT excluded.net_units OR analytics_order_facts.cod IS NOT excluded.cod OR analytics_order_facts.rts IS NOT excluded.rts OR analytics_order_facts.cod_delivered IS NOT excluded.cod_delivered OR analytics_order_facts.refunded IS NOT excluded.refunded;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_order_return_lines_update
AFTER UPDATE OF order_id, return_id, order_item_id, approved_quantity ON order_return_lines
WHEN OLD.order_id IS NOT NEW.order_id OR OLD.return_id IS NOT NEW.return_id OR OLD.order_item_id IS NOT NEW.order_item_id OR OLD.approved_quantity IS NOT NEW.approved_quantity
BEGIN
  insert into analytics_order_facts (order_id, created_at, shop_currency, identity, channel, channel_source, payment_method, city_name, shipping_method_id, shipping_method_kind, requires_shipping, fulfillment_location_id, order_count, placed, cancelled, gross, disc, returns, shipping, taxes, net_units, cod, rts, cod_delivered, refunded)
    select * from (with ao as materialized (select o.id, o.created_at, o.deleted_at, o.status, o.shop_currency, o.currency_code, o.currency_decimal_places, o.fx_rate, o.prices_include_tax, o.shipping_amount_minor, o.discount_amount_minor, o.tax_amount_minor, o.customer_id, o.customer_phone, o.channel, o.channel_source, o.payment_method, o.city_name, o.shipping_method_id, o.shipping_method_kind, o.requires_shipping, o.fulfillment_location_id from orders o where o.id in (OLD.order_id, NEW.order_id)),
    so as materialized (
      select o.id, o.created_at, o.status, o.payment_method, o.channel, o.channel_source,
        o.city_name, o.fulfillment_location_id, o.shipping_method_id, o.shipping_method_kind,
        o.requires_shipping, o.customer_id, o.customer_phone, o.prices_include_tax as incl,
        case when o.currency_code = o.shop_currency then o.shipping_amount_minor else cast(round(o.shipping_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as shipping_amount_minor, case when o.currency_code = o.shop_currency then o.discount_amount_minor else cast(round(o.discount_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as discount_amount_minor, case when o.currency_code = o.shop_currency then o.tax_amount_minor else cast(round(o.tax_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as tax_amount_minor,
        case when o.currency_code = o.shop_currency then 0 else 1 end as fx,
        case when o.currency_code = o.shop_currency then 1.0 else (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end) end as fxm,
        case when o.status in ('returned', 'refunded') then 1 else 0 end as reversed
      from ao o where o.deleted_at is null and o.status not in ('incomplete', 'cancelled')
    ), rq as (
    select rl.order_item_id, cast(sum(rl.approved_quantity) as bigint) as approved
    from so
    cross join order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = so.id and rr.status in ('approved', 'receiving', 'completed')
    group by rl.order_item_id
  ),
  sl as (
    select oi.id as line_id, oi.order_id, oi.product_id, oi.variant_id, oi.quantity,
      oi.product_name, oi.variant_label, so.created_at, so.reversed,
      case when oi.fulfillment_type = 'gift_card' then 1 else 0 end as gc,
      (case when so.fx = 0 then (oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) else cast(round((oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) * so.fxm, 0) as bigint) end) as gross,
      (case when so.fx = 0 then (oi.discount_amount_minor) else cast(round((oi.discount_amount_minor) * so.fxm, 0) as bigint) end) as disc,
      (case when so.fx = 0 then (oi.tax_amount_minor) else cast(round((oi.tax_amount_minor) * so.fxm, 0) as bigint) end) as tax,
      null as unit_cost,
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
  ), lo as (
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
  )
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
      coalesce((case when om.fx = 0 then ((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) else cast(round(((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) * om.fxm, 0) as bigint) end), 0) as refunded
    from ao o left join om on om.id = o.id) as refreshed where 1 = 1
    on conflict (order_id) do update set created_at = excluded.created_at, shop_currency = excluded.shop_currency, identity = excluded.identity, channel = excluded.channel, channel_source = excluded.channel_source, payment_method = excluded.payment_method, city_name = excluded.city_name, shipping_method_id = excluded.shipping_method_id, shipping_method_kind = excluded.shipping_method_kind, requires_shipping = excluded.requires_shipping, fulfillment_location_id = excluded.fulfillment_location_id, order_count = excluded.order_count, placed = excluded.placed, cancelled = excluded.cancelled, gross = excluded.gross, disc = excluded.disc, returns = excluded.returns, shipping = excluded.shipping, taxes = excluded.taxes, net_units = excluded.net_units, cod = excluded.cod, rts = excluded.rts, cod_delivered = excluded.cod_delivered, refunded = excluded.refunded
    where analytics_order_facts.created_at IS NOT excluded.created_at OR analytics_order_facts.shop_currency IS NOT excluded.shop_currency OR analytics_order_facts.identity IS NOT excluded.identity OR analytics_order_facts.channel IS NOT excluded.channel OR analytics_order_facts.channel_source IS NOT excluded.channel_source OR analytics_order_facts.payment_method IS NOT excluded.payment_method OR analytics_order_facts.city_name IS NOT excluded.city_name OR analytics_order_facts.shipping_method_id IS NOT excluded.shipping_method_id OR analytics_order_facts.shipping_method_kind IS NOT excluded.shipping_method_kind OR analytics_order_facts.requires_shipping IS NOT excluded.requires_shipping OR analytics_order_facts.fulfillment_location_id IS NOT excluded.fulfillment_location_id OR analytics_order_facts.order_count IS NOT excluded.order_count OR analytics_order_facts.placed IS NOT excluded.placed OR analytics_order_facts.cancelled IS NOT excluded.cancelled OR analytics_order_facts.gross IS NOT excluded.gross OR analytics_order_facts.disc IS NOT excluded.disc OR analytics_order_facts.returns IS NOT excluded.returns OR analytics_order_facts.shipping IS NOT excluded.shipping OR analytics_order_facts.taxes IS NOT excluded.taxes OR analytics_order_facts.net_units IS NOT excluded.net_units OR analytics_order_facts.cod IS NOT excluded.cod OR analytics_order_facts.rts IS NOT excluded.rts OR analytics_order_facts.cod_delivered IS NOT excluded.cod_delivered OR analytics_order_facts.refunded IS NOT excluded.refunded;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_order_return_lines_delete
AFTER DELETE ON order_return_lines
BEGIN
  insert into analytics_order_facts (order_id, created_at, shop_currency, identity, channel, channel_source, payment_method, city_name, shipping_method_id, shipping_method_kind, requires_shipping, fulfillment_location_id, order_count, placed, cancelled, gross, disc, returns, shipping, taxes, net_units, cod, rts, cod_delivered, refunded)
    select * from (with ao as materialized (select o.id, o.created_at, o.deleted_at, o.status, o.shop_currency, o.currency_code, o.currency_decimal_places, o.fx_rate, o.prices_include_tax, o.shipping_amount_minor, o.discount_amount_minor, o.tax_amount_minor, o.customer_id, o.customer_phone, o.channel, o.channel_source, o.payment_method, o.city_name, o.shipping_method_id, o.shipping_method_kind, o.requires_shipping, o.fulfillment_location_id from orders o where o.id in (OLD.order_id)),
    so as materialized (
      select o.id, o.created_at, o.status, o.payment_method, o.channel, o.channel_source,
        o.city_name, o.fulfillment_location_id, o.shipping_method_id, o.shipping_method_kind,
        o.requires_shipping, o.customer_id, o.customer_phone, o.prices_include_tax as incl,
        case when o.currency_code = o.shop_currency then o.shipping_amount_minor else cast(round(o.shipping_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as shipping_amount_minor, case when o.currency_code = o.shop_currency then o.discount_amount_minor else cast(round(o.discount_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as discount_amount_minor, case when o.currency_code = o.shop_currency then o.tax_amount_minor else cast(round(o.tax_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as tax_amount_minor,
        case when o.currency_code = o.shop_currency then 0 else 1 end as fx,
        case when o.currency_code = o.shop_currency then 1.0 else (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end) end as fxm,
        case when o.status in ('returned', 'refunded') then 1 else 0 end as reversed
      from ao o where o.deleted_at is null and o.status not in ('incomplete', 'cancelled')
    ), rq as (
    select rl.order_item_id, cast(sum(rl.approved_quantity) as bigint) as approved
    from so
    cross join order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = so.id and rr.status in ('approved', 'receiving', 'completed')
    group by rl.order_item_id
  ),
  sl as (
    select oi.id as line_id, oi.order_id, oi.product_id, oi.variant_id, oi.quantity,
      oi.product_name, oi.variant_label, so.created_at, so.reversed,
      case when oi.fulfillment_type = 'gift_card' then 1 else 0 end as gc,
      (case when so.fx = 0 then (oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) else cast(round((oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) * so.fxm, 0) as bigint) end) as gross,
      (case when so.fx = 0 then (oi.discount_amount_minor) else cast(round((oi.discount_amount_minor) * so.fxm, 0) as bigint) end) as disc,
      (case when so.fx = 0 then (oi.tax_amount_minor) else cast(round((oi.tax_amount_minor) * so.fxm, 0) as bigint) end) as tax,
      null as unit_cost,
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
  ), lo as (
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
  )
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
      coalesce((case when om.fx = 0 then ((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) else cast(round(((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) * om.fxm, 0) as bigint) end), 0) as refunded
    from ao o left join om on om.id = o.id) as refreshed where 1 = 1
    on conflict (order_id) do update set created_at = excluded.created_at, shop_currency = excluded.shop_currency, identity = excluded.identity, channel = excluded.channel, channel_source = excluded.channel_source, payment_method = excluded.payment_method, city_name = excluded.city_name, shipping_method_id = excluded.shipping_method_id, shipping_method_kind = excluded.shipping_method_kind, requires_shipping = excluded.requires_shipping, fulfillment_location_id = excluded.fulfillment_location_id, order_count = excluded.order_count, placed = excluded.placed, cancelled = excluded.cancelled, gross = excluded.gross, disc = excluded.disc, returns = excluded.returns, shipping = excluded.shipping, taxes = excluded.taxes, net_units = excluded.net_units, cod = excluded.cod, rts = excluded.rts, cod_delivered = excluded.cod_delivered, refunded = excluded.refunded
    where analytics_order_facts.created_at IS NOT excluded.created_at OR analytics_order_facts.shop_currency IS NOT excluded.shop_currency OR analytics_order_facts.identity IS NOT excluded.identity OR analytics_order_facts.channel IS NOT excluded.channel OR analytics_order_facts.channel_source IS NOT excluded.channel_source OR analytics_order_facts.payment_method IS NOT excluded.payment_method OR analytics_order_facts.city_name IS NOT excluded.city_name OR analytics_order_facts.shipping_method_id IS NOT excluded.shipping_method_id OR analytics_order_facts.shipping_method_kind IS NOT excluded.shipping_method_kind OR analytics_order_facts.requires_shipping IS NOT excluded.requires_shipping OR analytics_order_facts.fulfillment_location_id IS NOT excluded.fulfillment_location_id OR analytics_order_facts.order_count IS NOT excluded.order_count OR analytics_order_facts.placed IS NOT excluded.placed OR analytics_order_facts.cancelled IS NOT excluded.cancelled OR analytics_order_facts.gross IS NOT excluded.gross OR analytics_order_facts.disc IS NOT excluded.disc OR analytics_order_facts.returns IS NOT excluded.returns OR analytics_order_facts.shipping IS NOT excluded.shipping OR analytics_order_facts.taxes IS NOT excluded.taxes OR analytics_order_facts.net_units IS NOT excluded.net_units OR analytics_order_facts.cod IS NOT excluded.cod OR analytics_order_facts.rts IS NOT excluded.rts OR analytics_order_facts.cod_delivered IS NOT excluded.cod_delivered OR analytics_order_facts.refunded IS NOT excluded.refunded;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_order_payments_insert
AFTER INSERT ON order_payments
BEGIN
  insert into analytics_order_facts (order_id, created_at, shop_currency, identity, channel, channel_source, payment_method, city_name, shipping_method_id, shipping_method_kind, requires_shipping, fulfillment_location_id, order_count, placed, cancelled, gross, disc, returns, shipping, taxes, net_units, cod, rts, cod_delivered, refunded)
    select * from (with ao as materialized (select o.id, o.created_at, o.deleted_at, o.status, o.shop_currency, o.currency_code, o.currency_decimal_places, o.fx_rate, o.prices_include_tax, o.shipping_amount_minor, o.discount_amount_minor, o.tax_amount_minor, o.customer_id, o.customer_phone, o.channel, o.channel_source, o.payment_method, o.city_name, o.shipping_method_id, o.shipping_method_kind, o.requires_shipping, o.fulfillment_location_id from orders o where o.id in (NEW.order_id)),
    so as materialized (
      select o.id, o.created_at, o.status, o.payment_method, o.channel, o.channel_source,
        o.city_name, o.fulfillment_location_id, o.shipping_method_id, o.shipping_method_kind,
        o.requires_shipping, o.customer_id, o.customer_phone, o.prices_include_tax as incl,
        case when o.currency_code = o.shop_currency then o.shipping_amount_minor else cast(round(o.shipping_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as shipping_amount_minor, case when o.currency_code = o.shop_currency then o.discount_amount_minor else cast(round(o.discount_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as discount_amount_minor, case when o.currency_code = o.shop_currency then o.tax_amount_minor else cast(round(o.tax_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as tax_amount_minor,
        case when o.currency_code = o.shop_currency then 0 else 1 end as fx,
        case when o.currency_code = o.shop_currency then 1.0 else (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end) end as fxm,
        case when o.status in ('returned', 'refunded') then 1 else 0 end as reversed
      from ao o where o.deleted_at is null and o.status not in ('incomplete', 'cancelled')
    ), rq as (
    select rl.order_item_id, cast(sum(rl.approved_quantity) as bigint) as approved
    from so
    cross join order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = so.id and rr.status in ('approved', 'receiving', 'completed')
    group by rl.order_item_id
  ),
  sl as (
    select oi.id as line_id, oi.order_id, oi.product_id, oi.variant_id, oi.quantity,
      oi.product_name, oi.variant_label, so.created_at, so.reversed,
      case when oi.fulfillment_type = 'gift_card' then 1 else 0 end as gc,
      (case when so.fx = 0 then (oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) else cast(round((oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) * so.fxm, 0) as bigint) end) as gross,
      (case when so.fx = 0 then (oi.discount_amount_minor) else cast(round((oi.discount_amount_minor) * so.fxm, 0) as bigint) end) as disc,
      (case when so.fx = 0 then (oi.tax_amount_minor) else cast(round((oi.tax_amount_minor) * so.fxm, 0) as bigint) end) as tax,
      null as unit_cost,
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
  ), lo as (
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
  )
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
      coalesce((case when om.fx = 0 then ((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) else cast(round(((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) * om.fxm, 0) as bigint) end), 0) as refunded
    from ao o left join om on om.id = o.id) as refreshed where 1 = 1
    on conflict (order_id) do update set created_at = excluded.created_at, shop_currency = excluded.shop_currency, identity = excluded.identity, channel = excluded.channel, channel_source = excluded.channel_source, payment_method = excluded.payment_method, city_name = excluded.city_name, shipping_method_id = excluded.shipping_method_id, shipping_method_kind = excluded.shipping_method_kind, requires_shipping = excluded.requires_shipping, fulfillment_location_id = excluded.fulfillment_location_id, order_count = excluded.order_count, placed = excluded.placed, cancelled = excluded.cancelled, gross = excluded.gross, disc = excluded.disc, returns = excluded.returns, shipping = excluded.shipping, taxes = excluded.taxes, net_units = excluded.net_units, cod = excluded.cod, rts = excluded.rts, cod_delivered = excluded.cod_delivered, refunded = excluded.refunded
    where analytics_order_facts.created_at IS NOT excluded.created_at OR analytics_order_facts.shop_currency IS NOT excluded.shop_currency OR analytics_order_facts.identity IS NOT excluded.identity OR analytics_order_facts.channel IS NOT excluded.channel OR analytics_order_facts.channel_source IS NOT excluded.channel_source OR analytics_order_facts.payment_method IS NOT excluded.payment_method OR analytics_order_facts.city_name IS NOT excluded.city_name OR analytics_order_facts.shipping_method_id IS NOT excluded.shipping_method_id OR analytics_order_facts.shipping_method_kind IS NOT excluded.shipping_method_kind OR analytics_order_facts.requires_shipping IS NOT excluded.requires_shipping OR analytics_order_facts.fulfillment_location_id IS NOT excluded.fulfillment_location_id OR analytics_order_facts.order_count IS NOT excluded.order_count OR analytics_order_facts.placed IS NOT excluded.placed OR analytics_order_facts.cancelled IS NOT excluded.cancelled OR analytics_order_facts.gross IS NOT excluded.gross OR analytics_order_facts.disc IS NOT excluded.disc OR analytics_order_facts.returns IS NOT excluded.returns OR analytics_order_facts.shipping IS NOT excluded.shipping OR analytics_order_facts.taxes IS NOT excluded.taxes OR analytics_order_facts.net_units IS NOT excluded.net_units OR analytics_order_facts.cod IS NOT excluded.cod OR analytics_order_facts.rts IS NOT excluded.rts OR analytics_order_facts.cod_delivered IS NOT excluded.cod_delivered OR analytics_order_facts.refunded IS NOT excluded.refunded;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_order_payments_update
AFTER UPDATE OF order_id, payment_type, status, amount_minor ON order_payments
WHEN OLD.order_id IS NOT NEW.order_id OR OLD.payment_type IS NOT NEW.payment_type OR OLD.status IS NOT NEW.status OR OLD.amount_minor IS NOT NEW.amount_minor
BEGIN
  insert into analytics_order_facts (order_id, created_at, shop_currency, identity, channel, channel_source, payment_method, city_name, shipping_method_id, shipping_method_kind, requires_shipping, fulfillment_location_id, order_count, placed, cancelled, gross, disc, returns, shipping, taxes, net_units, cod, rts, cod_delivered, refunded)
    select * from (with ao as materialized (select o.id, o.created_at, o.deleted_at, o.status, o.shop_currency, o.currency_code, o.currency_decimal_places, o.fx_rate, o.prices_include_tax, o.shipping_amount_minor, o.discount_amount_minor, o.tax_amount_minor, o.customer_id, o.customer_phone, o.channel, o.channel_source, o.payment_method, o.city_name, o.shipping_method_id, o.shipping_method_kind, o.requires_shipping, o.fulfillment_location_id from orders o where o.id in (OLD.order_id, NEW.order_id)),
    so as materialized (
      select o.id, o.created_at, o.status, o.payment_method, o.channel, o.channel_source,
        o.city_name, o.fulfillment_location_id, o.shipping_method_id, o.shipping_method_kind,
        o.requires_shipping, o.customer_id, o.customer_phone, o.prices_include_tax as incl,
        case when o.currency_code = o.shop_currency then o.shipping_amount_minor else cast(round(o.shipping_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as shipping_amount_minor, case when o.currency_code = o.shop_currency then o.discount_amount_minor else cast(round(o.discount_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as discount_amount_minor, case when o.currency_code = o.shop_currency then o.tax_amount_minor else cast(round(o.tax_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as tax_amount_minor,
        case when o.currency_code = o.shop_currency then 0 else 1 end as fx,
        case when o.currency_code = o.shop_currency then 1.0 else (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end) end as fxm,
        case when o.status in ('returned', 'refunded') then 1 else 0 end as reversed
      from ao o where o.deleted_at is null and o.status not in ('incomplete', 'cancelled')
    ), rq as (
    select rl.order_item_id, cast(sum(rl.approved_quantity) as bigint) as approved
    from so
    cross join order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = so.id and rr.status in ('approved', 'receiving', 'completed')
    group by rl.order_item_id
  ),
  sl as (
    select oi.id as line_id, oi.order_id, oi.product_id, oi.variant_id, oi.quantity,
      oi.product_name, oi.variant_label, so.created_at, so.reversed,
      case when oi.fulfillment_type = 'gift_card' then 1 else 0 end as gc,
      (case when so.fx = 0 then (oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) else cast(round((oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) * so.fxm, 0) as bigint) end) as gross,
      (case when so.fx = 0 then (oi.discount_amount_minor) else cast(round((oi.discount_amount_minor) * so.fxm, 0) as bigint) end) as disc,
      (case when so.fx = 0 then (oi.tax_amount_minor) else cast(round((oi.tax_amount_minor) * so.fxm, 0) as bigint) end) as tax,
      null as unit_cost,
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
  ), lo as (
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
  )
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
      coalesce((case when om.fx = 0 then ((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) else cast(round(((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) * om.fxm, 0) as bigint) end), 0) as refunded
    from ao o left join om on om.id = o.id) as refreshed where 1 = 1
    on conflict (order_id) do update set created_at = excluded.created_at, shop_currency = excluded.shop_currency, identity = excluded.identity, channel = excluded.channel, channel_source = excluded.channel_source, payment_method = excluded.payment_method, city_name = excluded.city_name, shipping_method_id = excluded.shipping_method_id, shipping_method_kind = excluded.shipping_method_kind, requires_shipping = excluded.requires_shipping, fulfillment_location_id = excluded.fulfillment_location_id, order_count = excluded.order_count, placed = excluded.placed, cancelled = excluded.cancelled, gross = excluded.gross, disc = excluded.disc, returns = excluded.returns, shipping = excluded.shipping, taxes = excluded.taxes, net_units = excluded.net_units, cod = excluded.cod, rts = excluded.rts, cod_delivered = excluded.cod_delivered, refunded = excluded.refunded
    where analytics_order_facts.created_at IS NOT excluded.created_at OR analytics_order_facts.shop_currency IS NOT excluded.shop_currency OR analytics_order_facts.identity IS NOT excluded.identity OR analytics_order_facts.channel IS NOT excluded.channel OR analytics_order_facts.channel_source IS NOT excluded.channel_source OR analytics_order_facts.payment_method IS NOT excluded.payment_method OR analytics_order_facts.city_name IS NOT excluded.city_name OR analytics_order_facts.shipping_method_id IS NOT excluded.shipping_method_id OR analytics_order_facts.shipping_method_kind IS NOT excluded.shipping_method_kind OR analytics_order_facts.requires_shipping IS NOT excluded.requires_shipping OR analytics_order_facts.fulfillment_location_id IS NOT excluded.fulfillment_location_id OR analytics_order_facts.order_count IS NOT excluded.order_count OR analytics_order_facts.placed IS NOT excluded.placed OR analytics_order_facts.cancelled IS NOT excluded.cancelled OR analytics_order_facts.gross IS NOT excluded.gross OR analytics_order_facts.disc IS NOT excluded.disc OR analytics_order_facts.returns IS NOT excluded.returns OR analytics_order_facts.shipping IS NOT excluded.shipping OR analytics_order_facts.taxes IS NOT excluded.taxes OR analytics_order_facts.net_units IS NOT excluded.net_units OR analytics_order_facts.cod IS NOT excluded.cod OR analytics_order_facts.rts IS NOT excluded.rts OR analytics_order_facts.cod_delivered IS NOT excluded.cod_delivered OR analytics_order_facts.refunded IS NOT excluded.refunded;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_order_payments_delete
AFTER DELETE ON order_payments
BEGIN
  insert into analytics_order_facts (order_id, created_at, shop_currency, identity, channel, channel_source, payment_method, city_name, shipping_method_id, shipping_method_kind, requires_shipping, fulfillment_location_id, order_count, placed, cancelled, gross, disc, returns, shipping, taxes, net_units, cod, rts, cod_delivered, refunded)
    select * from (with ao as materialized (select o.id, o.created_at, o.deleted_at, o.status, o.shop_currency, o.currency_code, o.currency_decimal_places, o.fx_rate, o.prices_include_tax, o.shipping_amount_minor, o.discount_amount_minor, o.tax_amount_minor, o.customer_id, o.customer_phone, o.channel, o.channel_source, o.payment_method, o.city_name, o.shipping_method_id, o.shipping_method_kind, o.requires_shipping, o.fulfillment_location_id from orders o where o.id in (OLD.order_id)),
    so as materialized (
      select o.id, o.created_at, o.status, o.payment_method, o.channel, o.channel_source,
        o.city_name, o.fulfillment_location_id, o.shipping_method_id, o.shipping_method_kind,
        o.requires_shipping, o.customer_id, o.customer_phone, o.prices_include_tax as incl,
        case when o.currency_code = o.shop_currency then o.shipping_amount_minor else cast(round(o.shipping_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as shipping_amount_minor, case when o.currency_code = o.shop_currency then o.discount_amount_minor else cast(round(o.discount_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as discount_amount_minor, case when o.currency_code = o.shop_currency then o.tax_amount_minor else cast(round(o.tax_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as tax_amount_minor,
        case when o.currency_code = o.shop_currency then 0 else 1 end as fx,
        case when o.currency_code = o.shop_currency then 1.0 else (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end) end as fxm,
        case when o.status in ('returned', 'refunded') then 1 else 0 end as reversed
      from ao o where o.deleted_at is null and o.status not in ('incomplete', 'cancelled')
    ), rq as (
    select rl.order_item_id, cast(sum(rl.approved_quantity) as bigint) as approved
    from so
    cross join order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = so.id and rr.status in ('approved', 'receiving', 'completed')
    group by rl.order_item_id
  ),
  sl as (
    select oi.id as line_id, oi.order_id, oi.product_id, oi.variant_id, oi.quantity,
      oi.product_name, oi.variant_label, so.created_at, so.reversed,
      case when oi.fulfillment_type = 'gift_card' then 1 else 0 end as gc,
      (case when so.fx = 0 then (oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) else cast(round((oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) * so.fxm, 0) as bigint) end) as gross,
      (case when so.fx = 0 then (oi.discount_amount_minor) else cast(round((oi.discount_amount_minor) * so.fxm, 0) as bigint) end) as disc,
      (case when so.fx = 0 then (oi.tax_amount_minor) else cast(round((oi.tax_amount_minor) * so.fxm, 0) as bigint) end) as tax,
      null as unit_cost,
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
  ), lo as (
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
  )
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
      coalesce((case when om.fx = 0 then ((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) else cast(round(((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) * om.fxm, 0) as bigint) end), 0) as refunded
    from ao o left join om on om.id = o.id) as refreshed where 1 = 1
    on conflict (order_id) do update set created_at = excluded.created_at, shop_currency = excluded.shop_currency, identity = excluded.identity, channel = excluded.channel, channel_source = excluded.channel_source, payment_method = excluded.payment_method, city_name = excluded.city_name, shipping_method_id = excluded.shipping_method_id, shipping_method_kind = excluded.shipping_method_kind, requires_shipping = excluded.requires_shipping, fulfillment_location_id = excluded.fulfillment_location_id, order_count = excluded.order_count, placed = excluded.placed, cancelled = excluded.cancelled, gross = excluded.gross, disc = excluded.disc, returns = excluded.returns, shipping = excluded.shipping, taxes = excluded.taxes, net_units = excluded.net_units, cod = excluded.cod, rts = excluded.rts, cod_delivered = excluded.cod_delivered, refunded = excluded.refunded
    where analytics_order_facts.created_at IS NOT excluded.created_at OR analytics_order_facts.shop_currency IS NOT excluded.shop_currency OR analytics_order_facts.identity IS NOT excluded.identity OR analytics_order_facts.channel IS NOT excluded.channel OR analytics_order_facts.channel_source IS NOT excluded.channel_source OR analytics_order_facts.payment_method IS NOT excluded.payment_method OR analytics_order_facts.city_name IS NOT excluded.city_name OR analytics_order_facts.shipping_method_id IS NOT excluded.shipping_method_id OR analytics_order_facts.shipping_method_kind IS NOT excluded.shipping_method_kind OR analytics_order_facts.requires_shipping IS NOT excluded.requires_shipping OR analytics_order_facts.fulfillment_location_id IS NOT excluded.fulfillment_location_id OR analytics_order_facts.order_count IS NOT excluded.order_count OR analytics_order_facts.placed IS NOT excluded.placed OR analytics_order_facts.cancelled IS NOT excluded.cancelled OR analytics_order_facts.gross IS NOT excluded.gross OR analytics_order_facts.disc IS NOT excluded.disc OR analytics_order_facts.returns IS NOT excluded.returns OR analytics_order_facts.shipping IS NOT excluded.shipping OR analytics_order_facts.taxes IS NOT excluded.taxes OR analytics_order_facts.net_units IS NOT excluded.net_units OR analytics_order_facts.cod IS NOT excluded.cod OR analytics_order_facts.rts IS NOT excluded.rts OR analytics_order_facts.cod_delivered IS NOT excluded.cod_delivered OR analytics_order_facts.refunded IS NOT excluded.refunded;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_cod_tracking_insert
AFTER INSERT ON cod_tracking
BEGIN
  insert into analytics_order_facts (order_id, created_at, shop_currency, identity, channel, channel_source, payment_method, city_name, shipping_method_id, shipping_method_kind, requires_shipping, fulfillment_location_id, order_count, placed, cancelled, gross, disc, returns, shipping, taxes, net_units, cod, rts, cod_delivered, refunded)
    select * from (with ao as materialized (select o.id, o.created_at, o.deleted_at, o.status, o.shop_currency, o.currency_code, o.currency_decimal_places, o.fx_rate, o.prices_include_tax, o.shipping_amount_minor, o.discount_amount_minor, o.tax_amount_minor, o.customer_id, o.customer_phone, o.channel, o.channel_source, o.payment_method, o.city_name, o.shipping_method_id, o.shipping_method_kind, o.requires_shipping, o.fulfillment_location_id from orders o where o.id in (NEW.order_id)),
    so as materialized (
      select o.id, o.created_at, o.status, o.payment_method, o.channel, o.channel_source,
        o.city_name, o.fulfillment_location_id, o.shipping_method_id, o.shipping_method_kind,
        o.requires_shipping, o.customer_id, o.customer_phone, o.prices_include_tax as incl,
        case when o.currency_code = o.shop_currency then o.shipping_amount_minor else cast(round(o.shipping_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as shipping_amount_minor, case when o.currency_code = o.shop_currency then o.discount_amount_minor else cast(round(o.discount_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as discount_amount_minor, case when o.currency_code = o.shop_currency then o.tax_amount_minor else cast(round(o.tax_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as tax_amount_minor,
        case when o.currency_code = o.shop_currency then 0 else 1 end as fx,
        case when o.currency_code = o.shop_currency then 1.0 else (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end) end as fxm,
        case when o.status in ('returned', 'refunded') then 1 else 0 end as reversed
      from ao o where o.deleted_at is null and o.status not in ('incomplete', 'cancelled')
    ), rq as (
    select rl.order_item_id, cast(sum(rl.approved_quantity) as bigint) as approved
    from so
    cross join order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = so.id and rr.status in ('approved', 'receiving', 'completed')
    group by rl.order_item_id
  ),
  sl as (
    select oi.id as line_id, oi.order_id, oi.product_id, oi.variant_id, oi.quantity,
      oi.product_name, oi.variant_label, so.created_at, so.reversed,
      case when oi.fulfillment_type = 'gift_card' then 1 else 0 end as gc,
      (case when so.fx = 0 then (oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) else cast(round((oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) * so.fxm, 0) as bigint) end) as gross,
      (case when so.fx = 0 then (oi.discount_amount_minor) else cast(round((oi.discount_amount_minor) * so.fxm, 0) as bigint) end) as disc,
      (case when so.fx = 0 then (oi.tax_amount_minor) else cast(round((oi.tax_amount_minor) * so.fxm, 0) as bigint) end) as tax,
      null as unit_cost,
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
  ), lo as (
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
  )
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
      coalesce((case when om.fx = 0 then ((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) else cast(round(((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) * om.fxm, 0) as bigint) end), 0) as refunded
    from ao o left join om on om.id = o.id) as refreshed where 1 = 1
    on conflict (order_id) do update set created_at = excluded.created_at, shop_currency = excluded.shop_currency, identity = excluded.identity, channel = excluded.channel, channel_source = excluded.channel_source, payment_method = excluded.payment_method, city_name = excluded.city_name, shipping_method_id = excluded.shipping_method_id, shipping_method_kind = excluded.shipping_method_kind, requires_shipping = excluded.requires_shipping, fulfillment_location_id = excluded.fulfillment_location_id, order_count = excluded.order_count, placed = excluded.placed, cancelled = excluded.cancelled, gross = excluded.gross, disc = excluded.disc, returns = excluded.returns, shipping = excluded.shipping, taxes = excluded.taxes, net_units = excluded.net_units, cod = excluded.cod, rts = excluded.rts, cod_delivered = excluded.cod_delivered, refunded = excluded.refunded
    where analytics_order_facts.created_at IS NOT excluded.created_at OR analytics_order_facts.shop_currency IS NOT excluded.shop_currency OR analytics_order_facts.identity IS NOT excluded.identity OR analytics_order_facts.channel IS NOT excluded.channel OR analytics_order_facts.channel_source IS NOT excluded.channel_source OR analytics_order_facts.payment_method IS NOT excluded.payment_method OR analytics_order_facts.city_name IS NOT excluded.city_name OR analytics_order_facts.shipping_method_id IS NOT excluded.shipping_method_id OR analytics_order_facts.shipping_method_kind IS NOT excluded.shipping_method_kind OR analytics_order_facts.requires_shipping IS NOT excluded.requires_shipping OR analytics_order_facts.fulfillment_location_id IS NOT excluded.fulfillment_location_id OR analytics_order_facts.order_count IS NOT excluded.order_count OR analytics_order_facts.placed IS NOT excluded.placed OR analytics_order_facts.cancelled IS NOT excluded.cancelled OR analytics_order_facts.gross IS NOT excluded.gross OR analytics_order_facts.disc IS NOT excluded.disc OR analytics_order_facts.returns IS NOT excluded.returns OR analytics_order_facts.shipping IS NOT excluded.shipping OR analytics_order_facts.taxes IS NOT excluded.taxes OR analytics_order_facts.net_units IS NOT excluded.net_units OR analytics_order_facts.cod IS NOT excluded.cod OR analytics_order_facts.rts IS NOT excluded.rts OR analytics_order_facts.cod_delivered IS NOT excluded.cod_delivered OR analytics_order_facts.refunded IS NOT excluded.refunded;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_cod_tracking_update
AFTER UPDATE OF order_id, cod_status ON cod_tracking
WHEN OLD.order_id IS NOT NEW.order_id OR OLD.cod_status IS NOT NEW.cod_status
BEGIN
  insert into analytics_order_facts (order_id, created_at, shop_currency, identity, channel, channel_source, payment_method, city_name, shipping_method_id, shipping_method_kind, requires_shipping, fulfillment_location_id, order_count, placed, cancelled, gross, disc, returns, shipping, taxes, net_units, cod, rts, cod_delivered, refunded)
    select * from (with ao as materialized (select o.id, o.created_at, o.deleted_at, o.status, o.shop_currency, o.currency_code, o.currency_decimal_places, o.fx_rate, o.prices_include_tax, o.shipping_amount_minor, o.discount_amount_minor, o.tax_amount_minor, o.customer_id, o.customer_phone, o.channel, o.channel_source, o.payment_method, o.city_name, o.shipping_method_id, o.shipping_method_kind, o.requires_shipping, o.fulfillment_location_id from orders o where o.id in (OLD.order_id, NEW.order_id)),
    so as materialized (
      select o.id, o.created_at, o.status, o.payment_method, o.channel, o.channel_source,
        o.city_name, o.fulfillment_location_id, o.shipping_method_id, o.shipping_method_kind,
        o.requires_shipping, o.customer_id, o.customer_phone, o.prices_include_tax as incl,
        case when o.currency_code = o.shop_currency then o.shipping_amount_minor else cast(round(o.shipping_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as shipping_amount_minor, case when o.currency_code = o.shop_currency then o.discount_amount_minor else cast(round(o.discount_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as discount_amount_minor, case when o.currency_code = o.shop_currency then o.tax_amount_minor else cast(round(o.tax_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as tax_amount_minor,
        case when o.currency_code = o.shop_currency then 0 else 1 end as fx,
        case when o.currency_code = o.shop_currency then 1.0 else (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end) end as fxm,
        case when o.status in ('returned', 'refunded') then 1 else 0 end as reversed
      from ao o where o.deleted_at is null and o.status not in ('incomplete', 'cancelled')
    ), rq as (
    select rl.order_item_id, cast(sum(rl.approved_quantity) as bigint) as approved
    from so
    cross join order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = so.id and rr.status in ('approved', 'receiving', 'completed')
    group by rl.order_item_id
  ),
  sl as (
    select oi.id as line_id, oi.order_id, oi.product_id, oi.variant_id, oi.quantity,
      oi.product_name, oi.variant_label, so.created_at, so.reversed,
      case when oi.fulfillment_type = 'gift_card' then 1 else 0 end as gc,
      (case when so.fx = 0 then (oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) else cast(round((oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) * so.fxm, 0) as bigint) end) as gross,
      (case when so.fx = 0 then (oi.discount_amount_minor) else cast(round((oi.discount_amount_minor) * so.fxm, 0) as bigint) end) as disc,
      (case when so.fx = 0 then (oi.tax_amount_minor) else cast(round((oi.tax_amount_minor) * so.fxm, 0) as bigint) end) as tax,
      null as unit_cost,
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
  ), lo as (
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
  )
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
      coalesce((case when om.fx = 0 then ((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) else cast(round(((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) * om.fxm, 0) as bigint) end), 0) as refunded
    from ao o left join om on om.id = o.id) as refreshed where 1 = 1
    on conflict (order_id) do update set created_at = excluded.created_at, shop_currency = excluded.shop_currency, identity = excluded.identity, channel = excluded.channel, channel_source = excluded.channel_source, payment_method = excluded.payment_method, city_name = excluded.city_name, shipping_method_id = excluded.shipping_method_id, shipping_method_kind = excluded.shipping_method_kind, requires_shipping = excluded.requires_shipping, fulfillment_location_id = excluded.fulfillment_location_id, order_count = excluded.order_count, placed = excluded.placed, cancelled = excluded.cancelled, gross = excluded.gross, disc = excluded.disc, returns = excluded.returns, shipping = excluded.shipping, taxes = excluded.taxes, net_units = excluded.net_units, cod = excluded.cod, rts = excluded.rts, cod_delivered = excluded.cod_delivered, refunded = excluded.refunded
    where analytics_order_facts.created_at IS NOT excluded.created_at OR analytics_order_facts.shop_currency IS NOT excluded.shop_currency OR analytics_order_facts.identity IS NOT excluded.identity OR analytics_order_facts.channel IS NOT excluded.channel OR analytics_order_facts.channel_source IS NOT excluded.channel_source OR analytics_order_facts.payment_method IS NOT excluded.payment_method OR analytics_order_facts.city_name IS NOT excluded.city_name OR analytics_order_facts.shipping_method_id IS NOT excluded.shipping_method_id OR analytics_order_facts.shipping_method_kind IS NOT excluded.shipping_method_kind OR analytics_order_facts.requires_shipping IS NOT excluded.requires_shipping OR analytics_order_facts.fulfillment_location_id IS NOT excluded.fulfillment_location_id OR analytics_order_facts.order_count IS NOT excluded.order_count OR analytics_order_facts.placed IS NOT excluded.placed OR analytics_order_facts.cancelled IS NOT excluded.cancelled OR analytics_order_facts.gross IS NOT excluded.gross OR analytics_order_facts.disc IS NOT excluded.disc OR analytics_order_facts.returns IS NOT excluded.returns OR analytics_order_facts.shipping IS NOT excluded.shipping OR analytics_order_facts.taxes IS NOT excluded.taxes OR analytics_order_facts.net_units IS NOT excluded.net_units OR analytics_order_facts.cod IS NOT excluded.cod OR analytics_order_facts.rts IS NOT excluded.rts OR analytics_order_facts.cod_delivered IS NOT excluded.cod_delivered OR analytics_order_facts.refunded IS NOT excluded.refunded;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_cod_tracking_delete
AFTER DELETE ON cod_tracking
BEGIN
  insert into analytics_order_facts (order_id, created_at, shop_currency, identity, channel, channel_source, payment_method, city_name, shipping_method_id, shipping_method_kind, requires_shipping, fulfillment_location_id, order_count, placed, cancelled, gross, disc, returns, shipping, taxes, net_units, cod, rts, cod_delivered, refunded)
    select * from (with ao as materialized (select o.id, o.created_at, o.deleted_at, o.status, o.shop_currency, o.currency_code, o.currency_decimal_places, o.fx_rate, o.prices_include_tax, o.shipping_amount_minor, o.discount_amount_minor, o.tax_amount_minor, o.customer_id, o.customer_phone, o.channel, o.channel_source, o.payment_method, o.city_name, o.shipping_method_id, o.shipping_method_kind, o.requires_shipping, o.fulfillment_location_id from orders o where o.id in (OLD.order_id)),
    so as materialized (
      select o.id, o.created_at, o.status, o.payment_method, o.channel, o.channel_source,
        o.city_name, o.fulfillment_location_id, o.shipping_method_id, o.shipping_method_kind,
        o.requires_shipping, o.customer_id, o.customer_phone, o.prices_include_tax as incl,
        case when o.currency_code = o.shop_currency then o.shipping_amount_minor else cast(round(o.shipping_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as shipping_amount_minor, case when o.currency_code = o.shop_currency then o.discount_amount_minor else cast(round(o.discount_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as discount_amount_minor, case when o.currency_code = o.shop_currency then o.tax_amount_minor else cast(round(o.tax_amount_minor * (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end), 0) as bigint) end as tax_amount_minor,
        case when o.currency_code = o.shop_currency then 0 else 1 end as fx,
        case when o.currency_code = o.shop_currency then 1.0 else (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1.0 when 1 then 0.1 when 2 then 0.01 when 3 then 0.001 else 1.0 end) when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 1000.0 when 1 then 100.0 when 2 then 10.0 when 3 then 1.0 else 1.0 end) when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 10000.0 when 1 then 1000.0 when 2 then 100.0 when 3 then 10.0 else 1.0 end) else cast(o.fx_rate as double precision) * (case o.currency_decimal_places when 0 then 100.0 when 1 then 10.0 when 2 then 1.0 when 3 then 0.1 else 1.0 end) end) end as fxm,
        case when o.status in ('returned', 'refunded') then 1 else 0 end as reversed
      from ao o where o.deleted_at is null and o.status not in ('incomplete', 'cancelled')
    ), rq as (
    select rl.order_item_id, cast(sum(rl.approved_quantity) as bigint) as approved
    from so
    cross join order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = so.id and rr.status in ('approved', 'receiving', 'completed')
    group by rl.order_item_id
  ),
  sl as (
    select oi.id as line_id, oi.order_id, oi.product_id, oi.variant_id, oi.quantity,
      oi.product_name, oi.variant_label, so.created_at, so.reversed,
      case when oi.fulfillment_type = 'gift_card' then 1 else 0 end as gc,
      (case when so.fx = 0 then (oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) else cast(round((oi.line_subtotal_minor - case when so.incl = 1 then oi.tax_amount_minor else 0 end) * so.fxm, 0) as bigint) end) as gross,
      (case when so.fx = 0 then (oi.discount_amount_minor) else cast(round((oi.discount_amount_minor) * so.fxm, 0) as bigint) end) as disc,
      (case when so.fx = 0 then (oi.tax_amount_minor) else cast(round((oi.tax_amount_minor) * so.fxm, 0) as bigint) end) as tax,
      null as unit_cost,
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
  ), lo as (
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
  )
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
      coalesce((case when om.fx = 0 then ((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) else cast(round(((select sum(p.amount_minor) from order_payments p where p.order_id = om.id and p.payment_type = 'refund' and p.status = 'refunded')) * om.fxm, 0) as bigint) end), 0) as refunded
    from ao o left join om on om.id = o.id) as refreshed where 1 = 1
    on conflict (order_id) do update set created_at = excluded.created_at, shop_currency = excluded.shop_currency, identity = excluded.identity, channel = excluded.channel, channel_source = excluded.channel_source, payment_method = excluded.payment_method, city_name = excluded.city_name, shipping_method_id = excluded.shipping_method_id, shipping_method_kind = excluded.shipping_method_kind, requires_shipping = excluded.requires_shipping, fulfillment_location_id = excluded.fulfillment_location_id, order_count = excluded.order_count, placed = excluded.placed, cancelled = excluded.cancelled, gross = excluded.gross, disc = excluded.disc, returns = excluded.returns, shipping = excluded.shipping, taxes = excluded.taxes, net_units = excluded.net_units, cod = excluded.cod, rts = excluded.rts, cod_delivered = excluded.cod_delivered, refunded = excluded.refunded
    where analytics_order_facts.created_at IS NOT excluded.created_at OR analytics_order_facts.shop_currency IS NOT excluded.shop_currency OR analytics_order_facts.identity IS NOT excluded.identity OR analytics_order_facts.channel IS NOT excluded.channel OR analytics_order_facts.channel_source IS NOT excluded.channel_source OR analytics_order_facts.payment_method IS NOT excluded.payment_method OR analytics_order_facts.city_name IS NOT excluded.city_name OR analytics_order_facts.shipping_method_id IS NOT excluded.shipping_method_id OR analytics_order_facts.shipping_method_kind IS NOT excluded.shipping_method_kind OR analytics_order_facts.requires_shipping IS NOT excluded.requires_shipping OR analytics_order_facts.fulfillment_location_id IS NOT excluded.fulfillment_location_id OR analytics_order_facts.order_count IS NOT excluded.order_count OR analytics_order_facts.placed IS NOT excluded.placed OR analytics_order_facts.cancelled IS NOT excluded.cancelled OR analytics_order_facts.gross IS NOT excluded.gross OR analytics_order_facts.disc IS NOT excluded.disc OR analytics_order_facts.returns IS NOT excluded.returns OR analytics_order_facts.shipping IS NOT excluded.shipping OR analytics_order_facts.taxes IS NOT excluded.taxes OR analytics_order_facts.net_units IS NOT excluded.net_units OR analytics_order_facts.cod IS NOT excluded.cod OR analytics_order_facts.rts IS NOT excluded.rts OR analytics_order_facts.cod_delivered IS NOT excluded.cod_delivered OR analytics_order_facts.refunded IS NOT excluded.refunded;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_facts_buckets_insert
AFTER INSERT ON analytics_order_facts
BEGIN
  insert into analytics_sales_buckets (grain_seconds, dimension_kind, bucket_start, shop_currency, key1, key2, order_count, placed, cancelled, gross, disc, returns, shipping, taxes, net_units, cod, rts, cod_delivered, refunded)
    select grain_seconds, dimension_kind, bucket_start, shop_currency, key1, key2, sum(contributions.order_count) as order_count, sum(contributions.placed) as placed, sum(contributions.cancelled) as cancelled, sum(contributions.gross) as gross, sum(contributions.disc) as disc, sum(contributions.returns) as returns, sum(contributions.shipping) as shipping, sum(contributions.taxes) as taxes, sum(contributions.net_units) as net_units, sum(contributions.cod) as cod, sum(contributions.rts) as rts, sum(contributions.cod_delivered) as cod_delivered, sum(contributions.refunded) as refunded
    from (select * from (select 86400 as grain_seconds, 'total' as dimension_kind,
    ((cast(f.created_at / 86400 as bigint) - case when f.created_at < 0 and f.created_at <> cast(f.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400) as bucket_start,
    f.shop_currency, '' as key1, '' as key2, f.order_count, f.placed, f.cancelled, f.gross, f.disc, f.returns, f.shipping, f.taxes, f.net_units, f.cod, f.rts, f.cod_delivered, f.refunded
    from (select NEW.order_id as order_id, NEW.created_at as created_at, NEW.shop_currency as shop_currency, NEW.identity as identity, NEW.channel as channel, NEW.channel_source as channel_source, NEW.payment_method as payment_method, NEW.city_name as city_name, NEW.shipping_method_id as shipping_method_id, NEW.shipping_method_kind as shipping_method_kind, NEW.requires_shipping as requires_shipping, NEW.fulfillment_location_id as fulfillment_location_id, 1 * NEW.order_count as order_count, 1 * NEW.placed as placed, 1 * NEW.cancelled as cancelled, 1 * NEW.gross as gross, 1 * NEW.disc as disc, 1 * NEW.returns as returns, 1 * NEW.shipping as shipping, 1 * NEW.taxes as taxes, 1 * NEW.net_units as net_units, 1 * NEW.cod as cod, 1 * NEW.rts as rts, 1 * NEW.cod_delivered as cod_delivered, 1 * NEW.refunded as refunded) f where f.placed <> 0 union all select 86400 as grain_seconds, 'channel' as dimension_kind,
    ((cast(f.created_at / 86400 as bigint) - case when f.created_at < 0 and f.created_at <> cast(f.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400) as bucket_start,
    f.shop_currency, f.channel as key1, coalesce(f.channel_source, '') as key2, f.order_count, 0 as placed, 0 as cancelled, f.gross, f.disc, f.returns, f.shipping, f.taxes, f.net_units, 0 as cod, 0 as rts, 0 as cod_delivered, 0 as refunded
    from (select NEW.order_id as order_id, NEW.created_at as created_at, NEW.shop_currency as shop_currency, NEW.identity as identity, NEW.channel as channel, NEW.channel_source as channel_source, NEW.payment_method as payment_method, NEW.city_name as city_name, NEW.shipping_method_id as shipping_method_id, NEW.shipping_method_kind as shipping_method_kind, NEW.requires_shipping as requires_shipping, NEW.fulfillment_location_id as fulfillment_location_id, 1 * NEW.order_count as order_count, 1 * NEW.placed as placed, 1 * NEW.cancelled as cancelled, 1 * NEW.gross as gross, 1 * NEW.disc as disc, 1 * NEW.returns as returns, 1 * NEW.shipping as shipping, 1 * NEW.taxes as taxes, 1 * NEW.net_units as net_units, 1 * NEW.cod as cod, 1 * NEW.rts as rts, 1 * NEW.cod_delivered as cod_delivered, 1 * NEW.refunded as refunded) f where f.order_count <> 0 union all select 86400 as grain_seconds, 'payment' as dimension_kind,
    ((cast(f.created_at / 86400 as bigint) - case when f.created_at < 0 and f.created_at <> cast(f.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400) as bucket_start,
    f.shop_currency, f.payment_method as key1, '' as key2, f.order_count, 0 as placed, 0 as cancelled, f.gross, f.disc, f.returns, f.shipping, f.taxes, f.net_units, 0 as cod, 0 as rts, 0 as cod_delivered, 0 as refunded
    from (select NEW.order_id as order_id, NEW.created_at as created_at, NEW.shop_currency as shop_currency, NEW.identity as identity, NEW.channel as channel, NEW.channel_source as channel_source, NEW.payment_method as payment_method, NEW.city_name as city_name, NEW.shipping_method_id as shipping_method_id, NEW.shipping_method_kind as shipping_method_kind, NEW.requires_shipping as requires_shipping, NEW.fulfillment_location_id as fulfillment_location_id, 1 * NEW.order_count as order_count, 1 * NEW.placed as placed, 1 * NEW.cancelled as cancelled, 1 * NEW.gross as gross, 1 * NEW.disc as disc, 1 * NEW.returns as returns, 1 * NEW.shipping as shipping, 1 * NEW.taxes as taxes, 1 * NEW.net_units as net_units, 1 * NEW.cod as cod, 1 * NEW.rts as rts, 1 * NEW.cod_delivered as cod_delivered, 1 * NEW.refunded as refunded) f where f.order_count <> 0 union all select 86400 as grain_seconds, 'city' as dimension_kind,
    ((cast(f.created_at / 86400 as bigint) - case when f.created_at < 0 and f.created_at <> cast(f.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400) as bucket_start,
    f.shop_currency, coalesce(f.city_name, '') as key1, '' as key2, f.order_count, 0 as placed, 0 as cancelled, f.gross, f.disc, f.returns, f.shipping, f.taxes, f.net_units, 0 as cod, 0 as rts, 0 as cod_delivered, 0 as refunded
    from (select NEW.order_id as order_id, NEW.created_at as created_at, NEW.shop_currency as shop_currency, NEW.identity as identity, NEW.channel as channel, NEW.channel_source as channel_source, NEW.payment_method as payment_method, NEW.city_name as city_name, NEW.shipping_method_id as shipping_method_id, NEW.shipping_method_kind as shipping_method_kind, NEW.requires_shipping as requires_shipping, NEW.fulfillment_location_id as fulfillment_location_id, 1 * NEW.order_count as order_count, 1 * NEW.placed as placed, 1 * NEW.cancelled as cancelled, 1 * NEW.gross as gross, 1 * NEW.disc as disc, 1 * NEW.returns as returns, 1 * NEW.shipping as shipping, 1 * NEW.taxes as taxes, 1 * NEW.net_units as net_units, 1 * NEW.cod as cod, 1 * NEW.rts as rts, 1 * NEW.cod_delivered as cod_delivered, 1 * NEW.refunded as refunded) f where f.order_count <> 0) as first_dimensions
    union all select * from (select 86400 as grain_seconds, 'delivery' as dimension_kind,
    ((cast(f.created_at / 86400 as bigint) - case when f.created_at < 0 and f.created_at <> cast(f.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400) as bucket_start,
    f.shop_currency, case when f.requires_shipping = 0 then 'none' when f.shipping_method_kind = 'pickup' then 'pickup' when f.shipping_method_id is null then 'unknown' else 'method' end as key1, coalesce(f.shipping_method_id, '') as key2, f.order_count, 0 as placed, 0 as cancelled, f.gross, f.disc, f.returns, f.shipping, f.taxes, f.net_units, 0 as cod, 0 as rts, 0 as cod_delivered, 0 as refunded
    from (select NEW.order_id as order_id, NEW.created_at as created_at, NEW.shop_currency as shop_currency, NEW.identity as identity, NEW.channel as channel, NEW.channel_source as channel_source, NEW.payment_method as payment_method, NEW.city_name as city_name, NEW.shipping_method_id as shipping_method_id, NEW.shipping_method_kind as shipping_method_kind, NEW.requires_shipping as requires_shipping, NEW.fulfillment_location_id as fulfillment_location_id, 1 * NEW.order_count as order_count, 1 * NEW.placed as placed, 1 * NEW.cancelled as cancelled, 1 * NEW.gross as gross, 1 * NEW.disc as disc, 1 * NEW.returns as returns, 1 * NEW.shipping as shipping, 1 * NEW.taxes as taxes, 1 * NEW.net_units as net_units, 1 * NEW.cod as cod, 1 * NEW.rts as rts, 1 * NEW.cod_delivered as cod_delivered, 1 * NEW.refunded as refunded) f where f.order_count <> 0 union all select 86400 as grain_seconds, 'location' as dimension_kind,
    ((cast(f.created_at / 86400 as bigint) - case when f.created_at < 0 and f.created_at <> cast(f.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400) as bucket_start,
    f.shop_currency, case when f.fulfillment_location_id is null then 'default' else 'id' end as key1, coalesce(f.fulfillment_location_id, '') as key2, f.order_count, 0 as placed, 0 as cancelled, f.gross, f.disc, f.returns, f.shipping, f.taxes, f.net_units, 0 as cod, 0 as rts, 0 as cod_delivered, 0 as refunded
    from (select NEW.order_id as order_id, NEW.created_at as created_at, NEW.shop_currency as shop_currency, NEW.identity as identity, NEW.channel as channel, NEW.channel_source as channel_source, NEW.payment_method as payment_method, NEW.city_name as city_name, NEW.shipping_method_id as shipping_method_id, NEW.shipping_method_kind as shipping_method_kind, NEW.requires_shipping as requires_shipping, NEW.fulfillment_location_id as fulfillment_location_id, 1 * NEW.order_count as order_count, 1 * NEW.placed as placed, 1 * NEW.cancelled as cancelled, 1 * NEW.gross as gross, 1 * NEW.disc as disc, 1 * NEW.returns as returns, 1 * NEW.shipping as shipping, 1 * NEW.taxes as taxes, 1 * NEW.net_units as net_units, 1 * NEW.cod as cod, 1 * NEW.rts as rts, 1 * NEW.cod_delivered as cod_delivered, 1 * NEW.refunded as refunded) f where f.order_count <> 0 union all select 900 as grain_seconds, 'total' as dimension_kind,
    ((cast(f.created_at / 900 as bigint) - case when f.created_at < 0 and f.created_at <> cast(f.created_at / 900 as bigint) * 900 then 1 else 0 end) * 900) as bucket_start,
    f.shop_currency, '' as key1, '' as key2, f.order_count, f.placed, f.cancelled, f.gross, f.disc, f.returns, f.shipping, f.taxes, f.net_units, f.cod, f.rts, f.cod_delivered, f.refunded from (select NEW.order_id as order_id, NEW.created_at as created_at, NEW.shop_currency as shop_currency, NEW.identity as identity, NEW.channel as channel, NEW.channel_source as channel_source, NEW.payment_method as payment_method, NEW.city_name as city_name, NEW.shipping_method_id as shipping_method_id, NEW.shipping_method_kind as shipping_method_kind, NEW.requires_shipping as requires_shipping, NEW.fulfillment_location_id as fulfillment_location_id, 1 * NEW.order_count as order_count, 1 * NEW.placed as placed, 1 * NEW.cancelled as cancelled, 1 * NEW.gross as gross, 1 * NEW.disc as disc, 1 * NEW.returns as returns, 1 * NEW.shipping as shipping, 1 * NEW.taxes as taxes, 1 * NEW.net_units as net_units, 1 * NEW.cod as cod, 1 * NEW.rts as rts, 1 * NEW.cod_delivered as cod_delivered, 1 * NEW.refunded as refunded) f where f.placed <> 0) as last_dimensions) as contributions
    group by grain_seconds, dimension_kind, bucket_start, shop_currency, key1, key2 having sum(contributions.order_count) <> 0 or sum(contributions.placed) <> 0 or sum(contributions.cancelled) <> 0 or sum(contributions.gross) <> 0 or sum(contributions.disc) <> 0 or sum(contributions.returns) <> 0 or sum(contributions.shipping) <> 0 or sum(contributions.taxes) <> 0 or sum(contributions.net_units) <> 0 or sum(contributions.cod) <> 0 or sum(contributions.rts) <> 0 or sum(contributions.cod_delivered) <> 0 or sum(contributions.refunded) <> 0
    on conflict (grain_seconds, dimension_kind, bucket_start, shop_currency, key1, key2) do update set order_count = analytics_sales_buckets.order_count + excluded.order_count, placed = analytics_sales_buckets.placed + excluded.placed, cancelled = analytics_sales_buckets.cancelled + excluded.cancelled, gross = analytics_sales_buckets.gross + excluded.gross, disc = analytics_sales_buckets.disc + excluded.disc, returns = analytics_sales_buckets.returns + excluded.returns, shipping = analytics_sales_buckets.shipping + excluded.shipping, taxes = analytics_sales_buckets.taxes + excluded.taxes, net_units = analytics_sales_buckets.net_units + excluded.net_units, cod = analytics_sales_buckets.cod + excluded.cod, rts = analytics_sales_buckets.rts + excluded.rts, cod_delivered = analytics_sales_buckets.cod_delivered + excluded.cod_delivered, refunded = analytics_sales_buckets.refunded + excluded.refunded;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_facts_first_sale_insert
AFTER INSERT ON analytics_order_facts
WHEN NEW.order_count = 1
BEGIN
  insert into analytics_customer_first_sale (identity, first_sale_at)
      select identity, (select min(f.created_at) from analytics_order_facts f where f.identity = affected.identity and f.order_count = 1)
      from (select NEW.identity as identity) as affected where 1 = 1
      on conflict (identity) do update set first_sale_at = excluded.first_sale_at
      where analytics_customer_first_sale.first_sale_at IS NOT excluded.first_sale_at;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_facts_customer_summary_insert
AFTER INSERT ON analytics_order_facts
WHEN NEW.order_count = 1
BEGIN
  insert into analytics_customer_currency_summary (identity, shop_currency, first_sale_at, second_sale_at, last_sale_at, first_sale_any_currency_at)
      select identity, shop_currency, (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at limit 1), (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at limit 1 offset 1), (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at desc limit 1),
        (select f.created_at from analytics_order_facts f where f.identity = affected.identity and f.order_count = 1 order by f.created_at limit 1)
      from (select NEW.identity as identity, NEW.shop_currency as shop_currency) as affected where 1 = 1
      on conflict (identity, shop_currency) do update set first_sale_at = excluded.first_sale_at, second_sale_at = excluded.second_sale_at, last_sale_at = excluded.last_sale_at, first_sale_any_currency_at = excluded.first_sale_any_currency_at
      where analytics_customer_currency_summary.first_sale_at IS NOT excluded.first_sale_at OR analytics_customer_currency_summary.second_sale_at IS NOT excluded.second_sale_at OR analytics_customer_currency_summary.last_sale_at IS NOT excluded.last_sale_at OR analytics_customer_currency_summary.first_sale_any_currency_at IS NOT excluded.first_sale_any_currency_at;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_facts_buckets_update
AFTER UPDATE ON analytics_order_facts
WHEN OLD.order_id IS NOT NEW.order_id OR OLD.created_at IS NOT NEW.created_at OR OLD.shop_currency IS NOT NEW.shop_currency OR OLD.identity IS NOT NEW.identity OR OLD.channel IS NOT NEW.channel OR OLD.channel_source IS NOT NEW.channel_source OR OLD.payment_method IS NOT NEW.payment_method OR OLD.city_name IS NOT NEW.city_name OR OLD.shipping_method_id IS NOT NEW.shipping_method_id OR OLD.shipping_method_kind IS NOT NEW.shipping_method_kind OR OLD.requires_shipping IS NOT NEW.requires_shipping OR OLD.fulfillment_location_id IS NOT NEW.fulfillment_location_id OR OLD.order_count IS NOT NEW.order_count OR OLD.placed IS NOT NEW.placed OR OLD.cancelled IS NOT NEW.cancelled OR OLD.gross IS NOT NEW.gross OR OLD.disc IS NOT NEW.disc OR OLD.returns IS NOT NEW.returns OR OLD.shipping IS NOT NEW.shipping OR OLD.taxes IS NOT NEW.taxes OR OLD.net_units IS NOT NEW.net_units OR OLD.cod IS NOT NEW.cod OR OLD.rts IS NOT NEW.rts OR OLD.cod_delivered IS NOT NEW.cod_delivered OR OLD.refunded IS NOT NEW.refunded
BEGIN
  insert into analytics_sales_buckets (grain_seconds, dimension_kind, bucket_start, shop_currency, key1, key2, order_count, placed, cancelled, gross, disc, returns, shipping, taxes, net_units, cod, rts, cod_delivered, refunded)
    select grain_seconds, dimension_kind, bucket_start, shop_currency, key1, key2, sum(contributions.order_count) as order_count, sum(contributions.placed) as placed, sum(contributions.cancelled) as cancelled, sum(contributions.gross) as gross, sum(contributions.disc) as disc, sum(contributions.returns) as returns, sum(contributions.shipping) as shipping, sum(contributions.taxes) as taxes, sum(contributions.net_units) as net_units, sum(contributions.cod) as cod, sum(contributions.rts) as rts, sum(contributions.cod_delivered) as cod_delivered, sum(contributions.refunded) as refunded
    from (select * from (select 86400 as grain_seconds, 'total' as dimension_kind,
    ((cast(f.created_at / 86400 as bigint) - case when f.created_at < 0 and f.created_at <> cast(f.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400) as bucket_start,
    f.shop_currency, '' as key1, '' as key2, f.order_count, f.placed, f.cancelled, f.gross, f.disc, f.returns, f.shipping, f.taxes, f.net_units, f.cod, f.rts, f.cod_delivered, f.refunded
    from (select OLD.order_id as order_id, OLD.created_at as created_at, OLD.shop_currency as shop_currency, OLD.identity as identity, OLD.channel as channel, OLD.channel_source as channel_source, OLD.payment_method as payment_method, OLD.city_name as city_name, OLD.shipping_method_id as shipping_method_id, OLD.shipping_method_kind as shipping_method_kind, OLD.requires_shipping as requires_shipping, OLD.fulfillment_location_id as fulfillment_location_id, -1 * OLD.order_count as order_count, -1 * OLD.placed as placed, -1 * OLD.cancelled as cancelled, -1 * OLD.gross as gross, -1 * OLD.disc as disc, -1 * OLD.returns as returns, -1 * OLD.shipping as shipping, -1 * OLD.taxes as taxes, -1 * OLD.net_units as net_units, -1 * OLD.cod as cod, -1 * OLD.rts as rts, -1 * OLD.cod_delivered as cod_delivered, -1 * OLD.refunded as refunded union all select NEW.order_id as order_id, NEW.created_at as created_at, NEW.shop_currency as shop_currency, NEW.identity as identity, NEW.channel as channel, NEW.channel_source as channel_source, NEW.payment_method as payment_method, NEW.city_name as city_name, NEW.shipping_method_id as shipping_method_id, NEW.shipping_method_kind as shipping_method_kind, NEW.requires_shipping as requires_shipping, NEW.fulfillment_location_id as fulfillment_location_id, 1 * NEW.order_count as order_count, 1 * NEW.placed as placed, 1 * NEW.cancelled as cancelled, 1 * NEW.gross as gross, 1 * NEW.disc as disc, 1 * NEW.returns as returns, 1 * NEW.shipping as shipping, 1 * NEW.taxes as taxes, 1 * NEW.net_units as net_units, 1 * NEW.cod as cod, 1 * NEW.rts as rts, 1 * NEW.cod_delivered as cod_delivered, 1 * NEW.refunded as refunded) f where f.placed <> 0 union all select 86400 as grain_seconds, 'channel' as dimension_kind,
    ((cast(f.created_at / 86400 as bigint) - case when f.created_at < 0 and f.created_at <> cast(f.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400) as bucket_start,
    f.shop_currency, f.channel as key1, coalesce(f.channel_source, '') as key2, f.order_count, 0 as placed, 0 as cancelled, f.gross, f.disc, f.returns, f.shipping, f.taxes, f.net_units, 0 as cod, 0 as rts, 0 as cod_delivered, 0 as refunded
    from (select OLD.order_id as order_id, OLD.created_at as created_at, OLD.shop_currency as shop_currency, OLD.identity as identity, OLD.channel as channel, OLD.channel_source as channel_source, OLD.payment_method as payment_method, OLD.city_name as city_name, OLD.shipping_method_id as shipping_method_id, OLD.shipping_method_kind as shipping_method_kind, OLD.requires_shipping as requires_shipping, OLD.fulfillment_location_id as fulfillment_location_id, -1 * OLD.order_count as order_count, -1 * OLD.placed as placed, -1 * OLD.cancelled as cancelled, -1 * OLD.gross as gross, -1 * OLD.disc as disc, -1 * OLD.returns as returns, -1 * OLD.shipping as shipping, -1 * OLD.taxes as taxes, -1 * OLD.net_units as net_units, -1 * OLD.cod as cod, -1 * OLD.rts as rts, -1 * OLD.cod_delivered as cod_delivered, -1 * OLD.refunded as refunded union all select NEW.order_id as order_id, NEW.created_at as created_at, NEW.shop_currency as shop_currency, NEW.identity as identity, NEW.channel as channel, NEW.channel_source as channel_source, NEW.payment_method as payment_method, NEW.city_name as city_name, NEW.shipping_method_id as shipping_method_id, NEW.shipping_method_kind as shipping_method_kind, NEW.requires_shipping as requires_shipping, NEW.fulfillment_location_id as fulfillment_location_id, 1 * NEW.order_count as order_count, 1 * NEW.placed as placed, 1 * NEW.cancelled as cancelled, 1 * NEW.gross as gross, 1 * NEW.disc as disc, 1 * NEW.returns as returns, 1 * NEW.shipping as shipping, 1 * NEW.taxes as taxes, 1 * NEW.net_units as net_units, 1 * NEW.cod as cod, 1 * NEW.rts as rts, 1 * NEW.cod_delivered as cod_delivered, 1 * NEW.refunded as refunded) f where f.order_count <> 0 union all select 86400 as grain_seconds, 'payment' as dimension_kind,
    ((cast(f.created_at / 86400 as bigint) - case when f.created_at < 0 and f.created_at <> cast(f.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400) as bucket_start,
    f.shop_currency, f.payment_method as key1, '' as key2, f.order_count, 0 as placed, 0 as cancelled, f.gross, f.disc, f.returns, f.shipping, f.taxes, f.net_units, 0 as cod, 0 as rts, 0 as cod_delivered, 0 as refunded
    from (select OLD.order_id as order_id, OLD.created_at as created_at, OLD.shop_currency as shop_currency, OLD.identity as identity, OLD.channel as channel, OLD.channel_source as channel_source, OLD.payment_method as payment_method, OLD.city_name as city_name, OLD.shipping_method_id as shipping_method_id, OLD.shipping_method_kind as shipping_method_kind, OLD.requires_shipping as requires_shipping, OLD.fulfillment_location_id as fulfillment_location_id, -1 * OLD.order_count as order_count, -1 * OLD.placed as placed, -1 * OLD.cancelled as cancelled, -1 * OLD.gross as gross, -1 * OLD.disc as disc, -1 * OLD.returns as returns, -1 * OLD.shipping as shipping, -1 * OLD.taxes as taxes, -1 * OLD.net_units as net_units, -1 * OLD.cod as cod, -1 * OLD.rts as rts, -1 * OLD.cod_delivered as cod_delivered, -1 * OLD.refunded as refunded union all select NEW.order_id as order_id, NEW.created_at as created_at, NEW.shop_currency as shop_currency, NEW.identity as identity, NEW.channel as channel, NEW.channel_source as channel_source, NEW.payment_method as payment_method, NEW.city_name as city_name, NEW.shipping_method_id as shipping_method_id, NEW.shipping_method_kind as shipping_method_kind, NEW.requires_shipping as requires_shipping, NEW.fulfillment_location_id as fulfillment_location_id, 1 * NEW.order_count as order_count, 1 * NEW.placed as placed, 1 * NEW.cancelled as cancelled, 1 * NEW.gross as gross, 1 * NEW.disc as disc, 1 * NEW.returns as returns, 1 * NEW.shipping as shipping, 1 * NEW.taxes as taxes, 1 * NEW.net_units as net_units, 1 * NEW.cod as cod, 1 * NEW.rts as rts, 1 * NEW.cod_delivered as cod_delivered, 1 * NEW.refunded as refunded) f where f.order_count <> 0 union all select 86400 as grain_seconds, 'city' as dimension_kind,
    ((cast(f.created_at / 86400 as bigint) - case when f.created_at < 0 and f.created_at <> cast(f.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400) as bucket_start,
    f.shop_currency, coalesce(f.city_name, '') as key1, '' as key2, f.order_count, 0 as placed, 0 as cancelled, f.gross, f.disc, f.returns, f.shipping, f.taxes, f.net_units, 0 as cod, 0 as rts, 0 as cod_delivered, 0 as refunded
    from (select OLD.order_id as order_id, OLD.created_at as created_at, OLD.shop_currency as shop_currency, OLD.identity as identity, OLD.channel as channel, OLD.channel_source as channel_source, OLD.payment_method as payment_method, OLD.city_name as city_name, OLD.shipping_method_id as shipping_method_id, OLD.shipping_method_kind as shipping_method_kind, OLD.requires_shipping as requires_shipping, OLD.fulfillment_location_id as fulfillment_location_id, -1 * OLD.order_count as order_count, -1 * OLD.placed as placed, -1 * OLD.cancelled as cancelled, -1 * OLD.gross as gross, -1 * OLD.disc as disc, -1 * OLD.returns as returns, -1 * OLD.shipping as shipping, -1 * OLD.taxes as taxes, -1 * OLD.net_units as net_units, -1 * OLD.cod as cod, -1 * OLD.rts as rts, -1 * OLD.cod_delivered as cod_delivered, -1 * OLD.refunded as refunded union all select NEW.order_id as order_id, NEW.created_at as created_at, NEW.shop_currency as shop_currency, NEW.identity as identity, NEW.channel as channel, NEW.channel_source as channel_source, NEW.payment_method as payment_method, NEW.city_name as city_name, NEW.shipping_method_id as shipping_method_id, NEW.shipping_method_kind as shipping_method_kind, NEW.requires_shipping as requires_shipping, NEW.fulfillment_location_id as fulfillment_location_id, 1 * NEW.order_count as order_count, 1 * NEW.placed as placed, 1 * NEW.cancelled as cancelled, 1 * NEW.gross as gross, 1 * NEW.disc as disc, 1 * NEW.returns as returns, 1 * NEW.shipping as shipping, 1 * NEW.taxes as taxes, 1 * NEW.net_units as net_units, 1 * NEW.cod as cod, 1 * NEW.rts as rts, 1 * NEW.cod_delivered as cod_delivered, 1 * NEW.refunded as refunded) f where f.order_count <> 0) as first_dimensions
    union all select * from (select 86400 as grain_seconds, 'delivery' as dimension_kind,
    ((cast(f.created_at / 86400 as bigint) - case when f.created_at < 0 and f.created_at <> cast(f.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400) as bucket_start,
    f.shop_currency, case when f.requires_shipping = 0 then 'none' when f.shipping_method_kind = 'pickup' then 'pickup' when f.shipping_method_id is null then 'unknown' else 'method' end as key1, coalesce(f.shipping_method_id, '') as key2, f.order_count, 0 as placed, 0 as cancelled, f.gross, f.disc, f.returns, f.shipping, f.taxes, f.net_units, 0 as cod, 0 as rts, 0 as cod_delivered, 0 as refunded
    from (select OLD.order_id as order_id, OLD.created_at as created_at, OLD.shop_currency as shop_currency, OLD.identity as identity, OLD.channel as channel, OLD.channel_source as channel_source, OLD.payment_method as payment_method, OLD.city_name as city_name, OLD.shipping_method_id as shipping_method_id, OLD.shipping_method_kind as shipping_method_kind, OLD.requires_shipping as requires_shipping, OLD.fulfillment_location_id as fulfillment_location_id, -1 * OLD.order_count as order_count, -1 * OLD.placed as placed, -1 * OLD.cancelled as cancelled, -1 * OLD.gross as gross, -1 * OLD.disc as disc, -1 * OLD.returns as returns, -1 * OLD.shipping as shipping, -1 * OLD.taxes as taxes, -1 * OLD.net_units as net_units, -1 * OLD.cod as cod, -1 * OLD.rts as rts, -1 * OLD.cod_delivered as cod_delivered, -1 * OLD.refunded as refunded union all select NEW.order_id as order_id, NEW.created_at as created_at, NEW.shop_currency as shop_currency, NEW.identity as identity, NEW.channel as channel, NEW.channel_source as channel_source, NEW.payment_method as payment_method, NEW.city_name as city_name, NEW.shipping_method_id as shipping_method_id, NEW.shipping_method_kind as shipping_method_kind, NEW.requires_shipping as requires_shipping, NEW.fulfillment_location_id as fulfillment_location_id, 1 * NEW.order_count as order_count, 1 * NEW.placed as placed, 1 * NEW.cancelled as cancelled, 1 * NEW.gross as gross, 1 * NEW.disc as disc, 1 * NEW.returns as returns, 1 * NEW.shipping as shipping, 1 * NEW.taxes as taxes, 1 * NEW.net_units as net_units, 1 * NEW.cod as cod, 1 * NEW.rts as rts, 1 * NEW.cod_delivered as cod_delivered, 1 * NEW.refunded as refunded) f where f.order_count <> 0 union all select 86400 as grain_seconds, 'location' as dimension_kind,
    ((cast(f.created_at / 86400 as bigint) - case when f.created_at < 0 and f.created_at <> cast(f.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400) as bucket_start,
    f.shop_currency, case when f.fulfillment_location_id is null then 'default' else 'id' end as key1, coalesce(f.fulfillment_location_id, '') as key2, f.order_count, 0 as placed, 0 as cancelled, f.gross, f.disc, f.returns, f.shipping, f.taxes, f.net_units, 0 as cod, 0 as rts, 0 as cod_delivered, 0 as refunded
    from (select OLD.order_id as order_id, OLD.created_at as created_at, OLD.shop_currency as shop_currency, OLD.identity as identity, OLD.channel as channel, OLD.channel_source as channel_source, OLD.payment_method as payment_method, OLD.city_name as city_name, OLD.shipping_method_id as shipping_method_id, OLD.shipping_method_kind as shipping_method_kind, OLD.requires_shipping as requires_shipping, OLD.fulfillment_location_id as fulfillment_location_id, -1 * OLD.order_count as order_count, -1 * OLD.placed as placed, -1 * OLD.cancelled as cancelled, -1 * OLD.gross as gross, -1 * OLD.disc as disc, -1 * OLD.returns as returns, -1 * OLD.shipping as shipping, -1 * OLD.taxes as taxes, -1 * OLD.net_units as net_units, -1 * OLD.cod as cod, -1 * OLD.rts as rts, -1 * OLD.cod_delivered as cod_delivered, -1 * OLD.refunded as refunded union all select NEW.order_id as order_id, NEW.created_at as created_at, NEW.shop_currency as shop_currency, NEW.identity as identity, NEW.channel as channel, NEW.channel_source as channel_source, NEW.payment_method as payment_method, NEW.city_name as city_name, NEW.shipping_method_id as shipping_method_id, NEW.shipping_method_kind as shipping_method_kind, NEW.requires_shipping as requires_shipping, NEW.fulfillment_location_id as fulfillment_location_id, 1 * NEW.order_count as order_count, 1 * NEW.placed as placed, 1 * NEW.cancelled as cancelled, 1 * NEW.gross as gross, 1 * NEW.disc as disc, 1 * NEW.returns as returns, 1 * NEW.shipping as shipping, 1 * NEW.taxes as taxes, 1 * NEW.net_units as net_units, 1 * NEW.cod as cod, 1 * NEW.rts as rts, 1 * NEW.cod_delivered as cod_delivered, 1 * NEW.refunded as refunded) f where f.order_count <> 0 union all select 900 as grain_seconds, 'total' as dimension_kind,
    ((cast(f.created_at / 900 as bigint) - case when f.created_at < 0 and f.created_at <> cast(f.created_at / 900 as bigint) * 900 then 1 else 0 end) * 900) as bucket_start,
    f.shop_currency, '' as key1, '' as key2, f.order_count, f.placed, f.cancelled, f.gross, f.disc, f.returns, f.shipping, f.taxes, f.net_units, f.cod, f.rts, f.cod_delivered, f.refunded from (select OLD.order_id as order_id, OLD.created_at as created_at, OLD.shop_currency as shop_currency, OLD.identity as identity, OLD.channel as channel, OLD.channel_source as channel_source, OLD.payment_method as payment_method, OLD.city_name as city_name, OLD.shipping_method_id as shipping_method_id, OLD.shipping_method_kind as shipping_method_kind, OLD.requires_shipping as requires_shipping, OLD.fulfillment_location_id as fulfillment_location_id, -1 * OLD.order_count as order_count, -1 * OLD.placed as placed, -1 * OLD.cancelled as cancelled, -1 * OLD.gross as gross, -1 * OLD.disc as disc, -1 * OLD.returns as returns, -1 * OLD.shipping as shipping, -1 * OLD.taxes as taxes, -1 * OLD.net_units as net_units, -1 * OLD.cod as cod, -1 * OLD.rts as rts, -1 * OLD.cod_delivered as cod_delivered, -1 * OLD.refunded as refunded union all select NEW.order_id as order_id, NEW.created_at as created_at, NEW.shop_currency as shop_currency, NEW.identity as identity, NEW.channel as channel, NEW.channel_source as channel_source, NEW.payment_method as payment_method, NEW.city_name as city_name, NEW.shipping_method_id as shipping_method_id, NEW.shipping_method_kind as shipping_method_kind, NEW.requires_shipping as requires_shipping, NEW.fulfillment_location_id as fulfillment_location_id, 1 * NEW.order_count as order_count, 1 * NEW.placed as placed, 1 * NEW.cancelled as cancelled, 1 * NEW.gross as gross, 1 * NEW.disc as disc, 1 * NEW.returns as returns, 1 * NEW.shipping as shipping, 1 * NEW.taxes as taxes, 1 * NEW.net_units as net_units, 1 * NEW.cod as cod, 1 * NEW.rts as rts, 1 * NEW.cod_delivered as cod_delivered, 1 * NEW.refunded as refunded) f where f.placed <> 0) as last_dimensions) as contributions
    group by grain_seconds, dimension_kind, bucket_start, shop_currency, key1, key2 having sum(contributions.order_count) <> 0 or sum(contributions.placed) <> 0 or sum(contributions.cancelled) <> 0 or sum(contributions.gross) <> 0 or sum(contributions.disc) <> 0 or sum(contributions.returns) <> 0 or sum(contributions.shipping) <> 0 or sum(contributions.taxes) <> 0 or sum(contributions.net_units) <> 0 or sum(contributions.cod) <> 0 or sum(contributions.rts) <> 0 or sum(contributions.cod_delivered) <> 0 or sum(contributions.refunded) <> 0
    on conflict (grain_seconds, dimension_kind, bucket_start, shop_currency, key1, key2) do update set order_count = analytics_sales_buckets.order_count + excluded.order_count, placed = analytics_sales_buckets.placed + excluded.placed, cancelled = analytics_sales_buckets.cancelled + excluded.cancelled, gross = analytics_sales_buckets.gross + excluded.gross, disc = analytics_sales_buckets.disc + excluded.disc, returns = analytics_sales_buckets.returns + excluded.returns, shipping = analytics_sales_buckets.shipping + excluded.shipping, taxes = analytics_sales_buckets.taxes + excluded.taxes, net_units = analytics_sales_buckets.net_units + excluded.net_units, cod = analytics_sales_buckets.cod + excluded.cod, rts = analytics_sales_buckets.rts + excluded.rts, cod_delivered = analytics_sales_buckets.cod_delivered + excluded.cod_delivered, refunded = analytics_sales_buckets.refunded + excluded.refunded;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_facts_first_sale_update
AFTER UPDATE ON analytics_order_facts
WHEN OLD.identity IS NOT NEW.identity OR OLD.created_at IS NOT NEW.created_at OR OLD.order_count IS NOT NEW.order_count
BEGIN
  insert into analytics_customer_first_sale (identity, first_sale_at)
      select identity, (select min(f.created_at) from analytics_order_facts f where f.identity = affected.identity and f.order_count = 1)
      from (select OLD.identity as identity union select NEW.identity as identity) as affected where 1 = 1
      on conflict (identity) do update set first_sale_at = excluded.first_sale_at
      where analytics_customer_first_sale.first_sale_at IS NOT excluded.first_sale_at;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_facts_customer_summary_update
AFTER UPDATE ON analytics_order_facts
WHEN (OLD.order_count = 1 OR NEW.order_count = 1) AND (OLD.identity IS NOT NEW.identity OR OLD.shop_currency IS NOT NEW.shop_currency OR OLD.created_at IS NOT NEW.created_at OR OLD.order_count IS NOT NEW.order_count)
BEGIN
  insert into analytics_customer_currency_summary (identity, shop_currency, first_sale_at, second_sale_at, last_sale_at, first_sale_any_currency_at)
      select identity, shop_currency, (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at limit 1), (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at limit 1 offset 1), (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at desc limit 1),
        (select f.created_at from analytics_order_facts f where f.identity = affected.identity and f.order_count = 1 order by f.created_at limit 1)
      from (select OLD.identity as identity, OLD.shop_currency as shop_currency union select NEW.identity as identity, NEW.shop_currency as shop_currency) as affected where 1 = 1
      on conflict (identity, shop_currency) do update set first_sale_at = excluded.first_sale_at, second_sale_at = excluded.second_sale_at, last_sale_at = excluded.last_sale_at, first_sale_any_currency_at = excluded.first_sale_any_currency_at
      where analytics_customer_currency_summary.first_sale_at IS NOT excluded.first_sale_at OR analytics_customer_currency_summary.second_sale_at IS NOT excluded.second_sale_at OR analytics_customer_currency_summary.last_sale_at IS NOT excluded.last_sale_at OR analytics_customer_currency_summary.first_sale_any_currency_at IS NOT excluded.first_sale_any_currency_at;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_facts_buckets_delete
AFTER DELETE ON analytics_order_facts
BEGIN
  insert into analytics_sales_buckets (grain_seconds, dimension_kind, bucket_start, shop_currency, key1, key2, order_count, placed, cancelled, gross, disc, returns, shipping, taxes, net_units, cod, rts, cod_delivered, refunded)
    select grain_seconds, dimension_kind, bucket_start, shop_currency, key1, key2, sum(contributions.order_count) as order_count, sum(contributions.placed) as placed, sum(contributions.cancelled) as cancelled, sum(contributions.gross) as gross, sum(contributions.disc) as disc, sum(contributions.returns) as returns, sum(contributions.shipping) as shipping, sum(contributions.taxes) as taxes, sum(contributions.net_units) as net_units, sum(contributions.cod) as cod, sum(contributions.rts) as rts, sum(contributions.cod_delivered) as cod_delivered, sum(contributions.refunded) as refunded
    from (select * from (select 86400 as grain_seconds, 'total' as dimension_kind,
    ((cast(f.created_at / 86400 as bigint) - case when f.created_at < 0 and f.created_at <> cast(f.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400) as bucket_start,
    f.shop_currency, '' as key1, '' as key2, f.order_count, f.placed, f.cancelled, f.gross, f.disc, f.returns, f.shipping, f.taxes, f.net_units, f.cod, f.rts, f.cod_delivered, f.refunded
    from (select OLD.order_id as order_id, OLD.created_at as created_at, OLD.shop_currency as shop_currency, OLD.identity as identity, OLD.channel as channel, OLD.channel_source as channel_source, OLD.payment_method as payment_method, OLD.city_name as city_name, OLD.shipping_method_id as shipping_method_id, OLD.shipping_method_kind as shipping_method_kind, OLD.requires_shipping as requires_shipping, OLD.fulfillment_location_id as fulfillment_location_id, -1 * OLD.order_count as order_count, -1 * OLD.placed as placed, -1 * OLD.cancelled as cancelled, -1 * OLD.gross as gross, -1 * OLD.disc as disc, -1 * OLD.returns as returns, -1 * OLD.shipping as shipping, -1 * OLD.taxes as taxes, -1 * OLD.net_units as net_units, -1 * OLD.cod as cod, -1 * OLD.rts as rts, -1 * OLD.cod_delivered as cod_delivered, -1 * OLD.refunded as refunded) f where f.placed <> 0 union all select 86400 as grain_seconds, 'channel' as dimension_kind,
    ((cast(f.created_at / 86400 as bigint) - case when f.created_at < 0 and f.created_at <> cast(f.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400) as bucket_start,
    f.shop_currency, f.channel as key1, coalesce(f.channel_source, '') as key2, f.order_count, 0 as placed, 0 as cancelled, f.gross, f.disc, f.returns, f.shipping, f.taxes, f.net_units, 0 as cod, 0 as rts, 0 as cod_delivered, 0 as refunded
    from (select OLD.order_id as order_id, OLD.created_at as created_at, OLD.shop_currency as shop_currency, OLD.identity as identity, OLD.channel as channel, OLD.channel_source as channel_source, OLD.payment_method as payment_method, OLD.city_name as city_name, OLD.shipping_method_id as shipping_method_id, OLD.shipping_method_kind as shipping_method_kind, OLD.requires_shipping as requires_shipping, OLD.fulfillment_location_id as fulfillment_location_id, -1 * OLD.order_count as order_count, -1 * OLD.placed as placed, -1 * OLD.cancelled as cancelled, -1 * OLD.gross as gross, -1 * OLD.disc as disc, -1 * OLD.returns as returns, -1 * OLD.shipping as shipping, -1 * OLD.taxes as taxes, -1 * OLD.net_units as net_units, -1 * OLD.cod as cod, -1 * OLD.rts as rts, -1 * OLD.cod_delivered as cod_delivered, -1 * OLD.refunded as refunded) f where f.order_count <> 0 union all select 86400 as grain_seconds, 'payment' as dimension_kind,
    ((cast(f.created_at / 86400 as bigint) - case when f.created_at < 0 and f.created_at <> cast(f.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400) as bucket_start,
    f.shop_currency, f.payment_method as key1, '' as key2, f.order_count, 0 as placed, 0 as cancelled, f.gross, f.disc, f.returns, f.shipping, f.taxes, f.net_units, 0 as cod, 0 as rts, 0 as cod_delivered, 0 as refunded
    from (select OLD.order_id as order_id, OLD.created_at as created_at, OLD.shop_currency as shop_currency, OLD.identity as identity, OLD.channel as channel, OLD.channel_source as channel_source, OLD.payment_method as payment_method, OLD.city_name as city_name, OLD.shipping_method_id as shipping_method_id, OLD.shipping_method_kind as shipping_method_kind, OLD.requires_shipping as requires_shipping, OLD.fulfillment_location_id as fulfillment_location_id, -1 * OLD.order_count as order_count, -1 * OLD.placed as placed, -1 * OLD.cancelled as cancelled, -1 * OLD.gross as gross, -1 * OLD.disc as disc, -1 * OLD.returns as returns, -1 * OLD.shipping as shipping, -1 * OLD.taxes as taxes, -1 * OLD.net_units as net_units, -1 * OLD.cod as cod, -1 * OLD.rts as rts, -1 * OLD.cod_delivered as cod_delivered, -1 * OLD.refunded as refunded) f where f.order_count <> 0 union all select 86400 as grain_seconds, 'city' as dimension_kind,
    ((cast(f.created_at / 86400 as bigint) - case when f.created_at < 0 and f.created_at <> cast(f.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400) as bucket_start,
    f.shop_currency, coalesce(f.city_name, '') as key1, '' as key2, f.order_count, 0 as placed, 0 as cancelled, f.gross, f.disc, f.returns, f.shipping, f.taxes, f.net_units, 0 as cod, 0 as rts, 0 as cod_delivered, 0 as refunded
    from (select OLD.order_id as order_id, OLD.created_at as created_at, OLD.shop_currency as shop_currency, OLD.identity as identity, OLD.channel as channel, OLD.channel_source as channel_source, OLD.payment_method as payment_method, OLD.city_name as city_name, OLD.shipping_method_id as shipping_method_id, OLD.shipping_method_kind as shipping_method_kind, OLD.requires_shipping as requires_shipping, OLD.fulfillment_location_id as fulfillment_location_id, -1 * OLD.order_count as order_count, -1 * OLD.placed as placed, -1 * OLD.cancelled as cancelled, -1 * OLD.gross as gross, -1 * OLD.disc as disc, -1 * OLD.returns as returns, -1 * OLD.shipping as shipping, -1 * OLD.taxes as taxes, -1 * OLD.net_units as net_units, -1 * OLD.cod as cod, -1 * OLD.rts as rts, -1 * OLD.cod_delivered as cod_delivered, -1 * OLD.refunded as refunded) f where f.order_count <> 0) as first_dimensions
    union all select * from (select 86400 as grain_seconds, 'delivery' as dimension_kind,
    ((cast(f.created_at / 86400 as bigint) - case when f.created_at < 0 and f.created_at <> cast(f.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400) as bucket_start,
    f.shop_currency, case when f.requires_shipping = 0 then 'none' when f.shipping_method_kind = 'pickup' then 'pickup' when f.shipping_method_id is null then 'unknown' else 'method' end as key1, coalesce(f.shipping_method_id, '') as key2, f.order_count, 0 as placed, 0 as cancelled, f.gross, f.disc, f.returns, f.shipping, f.taxes, f.net_units, 0 as cod, 0 as rts, 0 as cod_delivered, 0 as refunded
    from (select OLD.order_id as order_id, OLD.created_at as created_at, OLD.shop_currency as shop_currency, OLD.identity as identity, OLD.channel as channel, OLD.channel_source as channel_source, OLD.payment_method as payment_method, OLD.city_name as city_name, OLD.shipping_method_id as shipping_method_id, OLD.shipping_method_kind as shipping_method_kind, OLD.requires_shipping as requires_shipping, OLD.fulfillment_location_id as fulfillment_location_id, -1 * OLD.order_count as order_count, -1 * OLD.placed as placed, -1 * OLD.cancelled as cancelled, -1 * OLD.gross as gross, -1 * OLD.disc as disc, -1 * OLD.returns as returns, -1 * OLD.shipping as shipping, -1 * OLD.taxes as taxes, -1 * OLD.net_units as net_units, -1 * OLD.cod as cod, -1 * OLD.rts as rts, -1 * OLD.cod_delivered as cod_delivered, -1 * OLD.refunded as refunded) f where f.order_count <> 0 union all select 86400 as grain_seconds, 'location' as dimension_kind,
    ((cast(f.created_at / 86400 as bigint) - case when f.created_at < 0 and f.created_at <> cast(f.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400) as bucket_start,
    f.shop_currency, case when f.fulfillment_location_id is null then 'default' else 'id' end as key1, coalesce(f.fulfillment_location_id, '') as key2, f.order_count, 0 as placed, 0 as cancelled, f.gross, f.disc, f.returns, f.shipping, f.taxes, f.net_units, 0 as cod, 0 as rts, 0 as cod_delivered, 0 as refunded
    from (select OLD.order_id as order_id, OLD.created_at as created_at, OLD.shop_currency as shop_currency, OLD.identity as identity, OLD.channel as channel, OLD.channel_source as channel_source, OLD.payment_method as payment_method, OLD.city_name as city_name, OLD.shipping_method_id as shipping_method_id, OLD.shipping_method_kind as shipping_method_kind, OLD.requires_shipping as requires_shipping, OLD.fulfillment_location_id as fulfillment_location_id, -1 * OLD.order_count as order_count, -1 * OLD.placed as placed, -1 * OLD.cancelled as cancelled, -1 * OLD.gross as gross, -1 * OLD.disc as disc, -1 * OLD.returns as returns, -1 * OLD.shipping as shipping, -1 * OLD.taxes as taxes, -1 * OLD.net_units as net_units, -1 * OLD.cod as cod, -1 * OLD.rts as rts, -1 * OLD.cod_delivered as cod_delivered, -1 * OLD.refunded as refunded) f where f.order_count <> 0 union all select 900 as grain_seconds, 'total' as dimension_kind,
    ((cast(f.created_at / 900 as bigint) - case when f.created_at < 0 and f.created_at <> cast(f.created_at / 900 as bigint) * 900 then 1 else 0 end) * 900) as bucket_start,
    f.shop_currency, '' as key1, '' as key2, f.order_count, f.placed, f.cancelled, f.gross, f.disc, f.returns, f.shipping, f.taxes, f.net_units, f.cod, f.rts, f.cod_delivered, f.refunded from (select OLD.order_id as order_id, OLD.created_at as created_at, OLD.shop_currency as shop_currency, OLD.identity as identity, OLD.channel as channel, OLD.channel_source as channel_source, OLD.payment_method as payment_method, OLD.city_name as city_name, OLD.shipping_method_id as shipping_method_id, OLD.shipping_method_kind as shipping_method_kind, OLD.requires_shipping as requires_shipping, OLD.fulfillment_location_id as fulfillment_location_id, -1 * OLD.order_count as order_count, -1 * OLD.placed as placed, -1 * OLD.cancelled as cancelled, -1 * OLD.gross as gross, -1 * OLD.disc as disc, -1 * OLD.returns as returns, -1 * OLD.shipping as shipping, -1 * OLD.taxes as taxes, -1 * OLD.net_units as net_units, -1 * OLD.cod as cod, -1 * OLD.rts as rts, -1 * OLD.cod_delivered as cod_delivered, -1 * OLD.refunded as refunded) f where f.placed <> 0) as last_dimensions) as contributions
    group by grain_seconds, dimension_kind, bucket_start, shop_currency, key1, key2 having sum(contributions.order_count) <> 0 or sum(contributions.placed) <> 0 or sum(contributions.cancelled) <> 0 or sum(contributions.gross) <> 0 or sum(contributions.disc) <> 0 or sum(contributions.returns) <> 0 or sum(contributions.shipping) <> 0 or sum(contributions.taxes) <> 0 or sum(contributions.net_units) <> 0 or sum(contributions.cod) <> 0 or sum(contributions.rts) <> 0 or sum(contributions.cod_delivered) <> 0 or sum(contributions.refunded) <> 0
    on conflict (grain_seconds, dimension_kind, bucket_start, shop_currency, key1, key2) do update set order_count = analytics_sales_buckets.order_count + excluded.order_count, placed = analytics_sales_buckets.placed + excluded.placed, cancelled = analytics_sales_buckets.cancelled + excluded.cancelled, gross = analytics_sales_buckets.gross + excluded.gross, disc = analytics_sales_buckets.disc + excluded.disc, returns = analytics_sales_buckets.returns + excluded.returns, shipping = analytics_sales_buckets.shipping + excluded.shipping, taxes = analytics_sales_buckets.taxes + excluded.taxes, net_units = analytics_sales_buckets.net_units + excluded.net_units, cod = analytics_sales_buckets.cod + excluded.cod, rts = analytics_sales_buckets.rts + excluded.rts, cod_delivered = analytics_sales_buckets.cod_delivered + excluded.cod_delivered, refunded = analytics_sales_buckets.refunded + excluded.refunded;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_facts_first_sale_delete
AFTER DELETE ON analytics_order_facts
WHEN OLD.order_count = 1
BEGIN
  insert into analytics_customer_first_sale (identity, first_sale_at)
      select identity, (select min(f.created_at) from analytics_order_facts f where f.identity = affected.identity and f.order_count = 1)
      from (select OLD.identity as identity) as affected where 1 = 1
      on conflict (identity) do update set first_sale_at = excluded.first_sale_at
      where analytics_customer_first_sale.first_sale_at IS NOT excluded.first_sale_at;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_facts_customer_summary_delete
AFTER DELETE ON analytics_order_facts
WHEN OLD.order_count = 1
BEGIN
  insert into analytics_customer_currency_summary (identity, shop_currency, first_sale_at, second_sale_at, last_sale_at, first_sale_any_currency_at)
      select identity, shop_currency, (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at limit 1), (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at limit 1 offset 1), (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at desc limit 1),
        (select f.created_at from analytics_order_facts f where f.identity = affected.identity and f.order_count = 1 order by f.created_at limit 1)
      from (select OLD.identity as identity, OLD.shop_currency as shop_currency) as affected where 1 = 1
      on conflict (identity, shop_currency) do update set first_sale_at = excluded.first_sale_at, second_sale_at = excluded.second_sale_at, last_sale_at = excluded.last_sale_at, first_sale_any_currency_at = excluded.first_sale_any_currency_at
      where analytics_customer_currency_summary.first_sale_at IS NOT excluded.first_sale_at OR analytics_customer_currency_summary.second_sale_at IS NOT excluded.second_sale_at OR analytics_customer_currency_summary.last_sale_at IS NOT excluded.last_sale_at OR analytics_customer_currency_summary.first_sale_any_currency_at IS NOT excluded.first_sale_any_currency_at;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_first_sale_summary_insert
AFTER INSERT ON analytics_customer_first_sale
WHEN NEW.first_sale_at IS NOT NULL
BEGIN
  update analytics_customer_currency_summary set first_sale_any_currency_at = NEW.first_sale_at
      where identity = NEW.identity and first_sale_any_currency_at IS NOT NEW.first_sale_at;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_first_sale_summary_update
AFTER UPDATE ON analytics_customer_first_sale
WHEN OLD.first_sale_at IS NOT NEW.first_sale_at
BEGIN
  update analytics_customer_currency_summary set first_sale_any_currency_at = NEW.first_sale_at
      where identity = NEW.identity and first_sale_any_currency_at IS NOT NEW.first_sale_at;
END;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (131, '0131_analytics_rollup', '77097e27fd9d135018c543306841f8c407482a9e5cfac4f9fd67c29fd09b296f');
