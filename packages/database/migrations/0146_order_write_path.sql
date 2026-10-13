DROP TRIGGER IF EXISTS analytics_orders_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_orders_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_order_items_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_order_items_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_order_items_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_order_returns_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_order_returns_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_order_returns_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_order_return_lines_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_order_return_lines_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_order_return_lines_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_order_payments_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_order_payments_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_order_payments_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_cod_tracking_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_cod_tracking_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_cod_tracking_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_facts_buckets_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_facts_buckets_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_facts_buckets_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_facts_first_sale_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_facts_first_sale_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_facts_first_sale_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_facts_customer_summary_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_facts_customer_summary_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_facts_customer_summary_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_first_sale_summary_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_first_sale_summary_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS buyer_public_counts_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS buyer_public_counts_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS buyer_public_counts_delete;
--> statement-breakpoint
DROP TABLE `product_buyer_public_counts`;
--> statement-breakpoint
DROP TABLE `conversation_search_state`;
--> statement-breakpoint
DROP TABLE `analytics_customer_currency_summary`;
--> statement-breakpoint
DROP TABLE `analytics_customer_first_sale`;
--> statement-breakpoint
DROP TABLE `analytics_order_facts`;
--> statement-breakpoint
DROP INDEX `product_variants_product_stock_idx`;
--> statement-breakpoint
DROP INDEX `product_variants_valuation_cost_idx`;
--> statement-breakpoint
DROP INDEX `product_variants_alerts_idx`;
--> statement-breakpoint
DROP INDEX `products_inventory_idx`;
--> statement-breakpoint
DROP INDEX `order_items_order_id_idx`;
--> statement-breakpoint
DROP INDEX `order_returns_sales_idx`;
--> statement-breakpoint
DROP INDEX `orders_recommendation_buyers_idx`;
--> statement-breakpoint
DROP INDEX `orders_recommendation_id_buyers_idx`;
--> statement-breakpoint
DROP INDEX `orders_overview_idx`;
--> statement-breakpoint
DROP INDEX `orders_customer_sales_idx`;
--> statement-breakpoint
DROP INDEX `orders_guest_sales_idx`;
--> statement-breakpoint
ALTER TABLE `conversations` DROP COLUMN `search_indexed_seq`;
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
	`reversed` integer DEFAULT 0 NOT NULL,
	`delivered` integer DEFAULT 0 NOT NULL,
	`incl` integer DEFAULT 0 NOT NULL,
	`fx_rate` text,
	`fx_shift` integer,
	`order_shipping` integer DEFAULT 0 NOT NULL,
	`order_discount` integer DEFAULT 0 NOT NULL,
	`order_tax` integer DEFAULT 0 NOT NULL,
	`line_gross` integer DEFAULT 0 NOT NULL,
	`line_disc` integer DEFAULT 0 NOT NULL,
	`line_returns` integer DEFAULT 0 NOT NULL,
	`line_kept_tax` integer DEFAULT 0 NOT NULL,
	`line_units` integer DEFAULT 0 NOT NULL,
	`line_rev_returns` integer DEFAULT 0 NOT NULL,
	`line_rev_kept_tax` integer DEFAULT 0 NOT NULL,
	`line_disc_all` integer DEFAULT 0 NOT NULL,
	`line_tax_all` integer DEFAULT 0 NOT NULL,
	`refund_sum` integer DEFAULT 0 NOT NULL,
	`cod_collected` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `analytics_facts_range_idx` ON `analytics_order_facts` (`created_at`,`shop_currency`);
--> statement-breakpoint
CREATE INDEX `analytics_facts_customer_range_idx` ON `analytics_order_facts` (`shop_currency`,`created_at`,`identity`) WHERE "analytics_order_facts"."order_count" = 1;
--> statement-breakpoint
CREATE INDEX `analytics_facts_identity_idx` ON `analytics_order_facts` (`identity`,`created_at`) WHERE "analytics_order_facts"."order_count" = 1;
--> statement-breakpoint
CREATE TABLE `analytics_sealed_days` (
	`day` integer PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE INDEX `staff_alerts_recorded_idx` ON `staff_alerts` (`recorded_at`);
--> statement-breakpoint
insert into analytics_order_facts (order_id, created_at, shop_currency, identity, channel, channel_source, payment_method, city_name, shipping_method_id, shipping_method_kind, requires_shipping, fulfillment_location_id, order_count, placed, cancelled, reversed, delivered, incl, fx_rate, fx_shift, order_shipping, order_discount, order_tax, line_gross, line_disc, line_returns, line_kept_tax, line_units, line_rev_returns, line_rev_kept_tax, line_disc_all, line_tax_all, refund_sum, cod_collected) with so as materialized (select s.order_id, s.created_at, s.shop_currency, s.identity, s.channel, s.channel_source, s.payment_method, s.city_name, s.shipping_method_id, s.shipping_method_kind, s.requires_shipping, s.fulfillment_location_id, s.order_count, s.placed, s.cancelled, s.reversed, s.delivered, s.incl, s.fx_rate, s.fx_shift, (case when s.fx_shift is null then (s.order_shipping) else cast(round((s.order_shipping) * (cast(s.fx_rate as double precision) * (case s.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as order_shipping, (case when s.fx_shift is null then (s.order_discount) else cast(round((s.order_discount) * (cast(s.fx_rate as double precision) * (case s.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as order_discount, (case when s.fx_shift is null then (s.order_tax) else cast(round((s.order_tax) * (cast(s.fx_rate as double precision) * (case s.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as order_tax from (select o.id as order_id, o.created_at as created_at, o.shop_currency as shop_currency, (case when o.customer_id is not null then 'c:' || o.customer_id else 'o:' || o.id end) as identity, o.channel as channel, o.channel_source as channel_source, o.payment_method as payment_method, o.city_name as city_name, o.shipping_method_id as shipping_method_id, o.shipping_method_kind as shipping_method_kind, o.requires_shipping as requires_shipping, o.fulfillment_location_id as fulfillment_location_id, (case when o.deleted_at is null and o.status not in ('incomplete', 'cancelled') then 1 else 0 end) as order_count, (case when o.deleted_at is null and o.status <> 'incomplete' then 1 else 0 end) as placed, (case when o.deleted_at is null and o.status = 'cancelled' then 1 else 0 end) as cancelled, (case when o.status in ('returned', 'refunded') then 1 else 0 end) as reversed, (case when o.status in ('delivered', 'completed') then 1 else 0 end) as delivered, (case when o.prices_include_tax = 1 then 1 else 0 end) as incl, o.fx_rate as fx_rate, (case when o.currency_code = o.shop_currency then null
    when o.currency_decimal_places in (0, 1, 2, 3) then (case when upper(trim(o.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then 0 when upper(trim(o.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then 3 when upper(trim(o.shop_currency)) in ('CLF', 'UYW') then 4 else 2 end) - o.currency_decimal_places else 0 end) as fx_shift, o.shipping_amount_minor as order_shipping, o.discount_amount_minor as order_discount, o.tax_amount_minor as order_tax from orders o where 1 = 1) as s),
    lr as materialized (select oi.order_id as order_id, oi.quantity as quantity, oi.line_subtotal_minor as line_subtotal_minor, oi.discount_amount_minor as discount_amount_minor, oi.tax_amount_minor as tax_amount_minor, oi.fulfillment_type as fulfillment_type, so.fx_rate as fx_rate, so.fx_shift as fx_shift, so.incl as incl,
    (select cast(coalesce(sum(rl.approved_quantity), 0) as bigint) from order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = oi.order_id and rl.order_item_id = oi.id and rr.status in ('approved', 'receiving', 'completed')) as raw, 1 as sign
    from so cross join order_items oi where oi.order_id = so.order_id),
    lb as materialized (select lr.order_id, lr.sign, lr.quantity as q,
        (case when lr.raw > lr.quantity then lr.quantity else lr.raw end) as rq,
        (case when lr.fulfillment_type = 'gift_card' then 1 else 0 end) as gc,
        (case when lr.fx_shift is null then (lr.line_subtotal_minor - (case when lr.incl = 1 then lr.tax_amount_minor else 0 end)) else cast(round((lr.line_subtotal_minor - (case when lr.incl = 1 then lr.tax_amount_minor else 0 end)) * (cast(lr.fx_rate as double precision) * (case lr.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as g,
        (case when lr.fx_shift is null then (lr.discount_amount_minor) else cast(round((lr.discount_amount_minor) * (cast(lr.fx_rate as double precision) * (case lr.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as d, (case when lr.fx_shift is null then (lr.tax_amount_minor) else cast(round((lr.tax_amount_minor) * (cast(lr.fx_rate as double precision) * (case lr.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as t
      from lr), ls as (select lb.order_id, cast(sum(lb.sign * (case when lb.gc = 0 then lb.g else 0 end)) as bigint) as line_gross, cast(sum(lb.sign * (case when lb.gc = 0 then lb.d else 0 end)) as bigint) as line_disc, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.rq = 0 then 0 when lb.rq = lb.q then lb.g - lb.d
    else ((lb.g - lb.d) * lb.rq) / lb.q end) else 0 end)) as bigint) as line_returns, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.rq = 0 then lb.t when lb.rq = lb.q then 0
    else lb.t - (lb.t * lb.rq) / lb.q end) else 0 end)) as bigint) as line_kept_tax, cast(sum(lb.sign * (case when lb.gc = 0 then (lb.q - lb.rq) else 0 end)) as bigint) as line_units, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.q = 0 then 0 else lb.g - lb.d end) else 0 end)) as bigint) as line_rev_returns, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.q = 0 then lb.t else 0 end) else 0 end)) as bigint) as line_rev_kept_tax, cast(sum(lb.sign * lb.d) as bigint) as line_disc_all, cast(sum(lb.sign * lb.t) as bigint) as line_tax_all
  from lb group by lb.order_id)
    select so.order_id, so.created_at, so.shop_currency, so.identity, so.channel, so.channel_source, so.payment_method, so.city_name, so.shipping_method_id, so.shipping_method_kind, so.requires_shipping, so.fulfillment_location_id, so.order_count, so.placed, so.cancelled, so.reversed, so.delivered, so.incl, so.fx_rate, so.fx_shift, so.order_shipping, so.order_discount, so.order_tax, coalesce(ls.line_gross, 0) as line_gross, coalesce(ls.line_disc, 0) as line_disc, coalesce(ls.line_returns, 0) as line_returns, coalesce(ls.line_kept_tax, 0) as line_kept_tax, coalesce(ls.line_units, 0) as line_units, coalesce(ls.line_rev_returns, 0) as line_rev_returns, coalesce(ls.line_rev_kept_tax, 0) as line_rev_kept_tax, coalesce(ls.line_disc_all, 0) as line_disc_all, coalesce(ls.line_tax_all, 0) as line_tax_all, (select cast(coalesce(sum(p.amount_minor), 0) as bigint) from order_payments p
    where p.order_id = so.order_id and p.payment_type = 'refund' and p.status = 'refunded') as refund_sum, (select count(*) from cod_tracking ct where ct.order_id = so.order_id and ct.cod_status = 'collected') as cod_collected
    from so left join ls on ls.order_id = so.order_id;
--> statement-breakpoint
CREATE TRIGGER analytics_orders_insert
AFTER INSERT ON orders
BEGIN
  insert into analytics_order_facts (order_id, created_at, shop_currency, identity, channel, channel_source, payment_method, city_name, shipping_method_id, shipping_method_kind, requires_shipping, fulfillment_location_id, order_count, placed, cancelled, reversed, delivered, incl, fx_rate, fx_shift, order_shipping, order_discount, order_tax)
    select * from (select s.order_id, s.created_at, s.shop_currency, s.identity, s.channel, s.channel_source, s.payment_method, s.city_name, s.shipping_method_id, s.shipping_method_kind, s.requires_shipping, s.fulfillment_location_id, s.order_count, s.placed, s.cancelled, s.reversed, s.delivered, s.incl, s.fx_rate, s.fx_shift, (case when s.fx_shift is null then (s.order_shipping) else cast(round((s.order_shipping) * (cast(s.fx_rate as double precision) * (case s.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as order_shipping, (case when s.fx_shift is null then (s.order_discount) else cast(round((s.order_discount) * (cast(s.fx_rate as double precision) * (case s.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as order_discount, (case when s.fx_shift is null then (s.order_tax) else cast(round((s.order_tax) * (cast(s.fx_rate as double precision) * (case s.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as order_tax from (select NEW.id as order_id, NEW.created_at as created_at, NEW.shop_currency as shop_currency, (case when NEW.customer_id is not null then 'c:' || NEW.customer_id else 'o:' || NEW.id end) as identity, NEW.channel as channel, NEW.channel_source as channel_source, NEW.payment_method as payment_method, NEW.city_name as city_name, NEW.shipping_method_id as shipping_method_id, NEW.shipping_method_kind as shipping_method_kind, NEW.requires_shipping as requires_shipping, NEW.fulfillment_location_id as fulfillment_location_id, (case when NEW.deleted_at is null and NEW.status not in ('incomplete', 'cancelled') then 1 else 0 end) as order_count, (case when NEW.deleted_at is null and NEW.status <> 'incomplete' then 1 else 0 end) as placed, (case when NEW.deleted_at is null and NEW.status = 'cancelled' then 1 else 0 end) as cancelled, (case when NEW.status in ('returned', 'refunded') then 1 else 0 end) as reversed, (case when NEW.status in ('delivered', 'completed') then 1 else 0 end) as delivered, (case when NEW.prices_include_tax = 1 then 1 else 0 end) as incl, NEW.fx_rate as fx_rate, (case when NEW.currency_code = NEW.shop_currency then null
    when NEW.currency_decimal_places in (0, 1, 2, 3) then (case when upper(trim(NEW.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then 0 when upper(trim(NEW.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then 3 when upper(trim(NEW.shop_currency)) in ('CLF', 'UYW') then 4 else 2 end) - NEW.currency_decimal_places else 0 end) as fx_shift, NEW.shipping_amount_minor as order_shipping, NEW.discount_amount_minor as order_discount, NEW.tax_amount_minor as order_tax) as s) as o where 1 = 1
    on conflict (order_id) do update set created_at = excluded.created_at, shop_currency = excluded.shop_currency, identity = excluded.identity, channel = excluded.channel, channel_source = excluded.channel_source, payment_method = excluded.payment_method, city_name = excluded.city_name, shipping_method_id = excluded.shipping_method_id, shipping_method_kind = excluded.shipping_method_kind, requires_shipping = excluded.requires_shipping, fulfillment_location_id = excluded.fulfillment_location_id, order_count = excluded.order_count, placed = excluded.placed, cancelled = excluded.cancelled, reversed = excluded.reversed, delivered = excluded.delivered, incl = excluded.incl, fx_rate = excluded.fx_rate, fx_shift = excluded.fx_shift, order_shipping = excluded.order_shipping, order_discount = excluded.order_discount, order_tax = excluded.order_tax;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_orders_update
AFTER UPDATE OF created_at, deleted_at, status, shop_currency, currency_code, currency_decimal_places, fx_rate, prices_include_tax, shipping_amount_minor, discount_amount_minor, tax_amount_minor, customer_id, channel, channel_source, payment_method, city_name, shipping_method_id, shipping_method_kind, requires_shipping, fulfillment_location_id ON orders
WHEN OLD.created_at IS NOT NEW.created_at OR OLD.deleted_at IS NOT NEW.deleted_at OR OLD.status IS NOT NEW.status OR OLD.shop_currency IS NOT NEW.shop_currency OR OLD.currency_code IS NOT NEW.currency_code OR OLD.currency_decimal_places IS NOT NEW.currency_decimal_places OR OLD.fx_rate IS NOT NEW.fx_rate OR OLD.prices_include_tax IS NOT NEW.prices_include_tax OR OLD.shipping_amount_minor IS NOT NEW.shipping_amount_minor OR OLD.discount_amount_minor IS NOT NEW.discount_amount_minor OR OLD.tax_amount_minor IS NOT NEW.tax_amount_minor OR OLD.customer_id IS NOT NEW.customer_id OR OLD.channel IS NOT NEW.channel OR OLD.channel_source IS NOT NEW.channel_source OR OLD.payment_method IS NOT NEW.payment_method OR OLD.city_name IS NOT NEW.city_name OR OLD.shipping_method_id IS NOT NEW.shipping_method_id OR OLD.shipping_method_kind IS NOT NEW.shipping_method_kind OR OLD.requires_shipping IS NOT NEW.requires_shipping OR OLD.fulfillment_location_id IS NOT NEW.fulfillment_location_id
BEGIN
  insert into analytics_order_facts (order_id, created_at, shop_currency, identity, channel, channel_source, payment_method, city_name, shipping_method_id, shipping_method_kind, requires_shipping, fulfillment_location_id, order_count, placed, cancelled, reversed, delivered, incl, fx_rate, fx_shift, order_shipping, order_discount, order_tax)
    select * from (select s.order_id, s.created_at, s.shop_currency, s.identity, s.channel, s.channel_source, s.payment_method, s.city_name, s.shipping_method_id, s.shipping_method_kind, s.requires_shipping, s.fulfillment_location_id, s.order_count, s.placed, s.cancelled, s.reversed, s.delivered, s.incl, s.fx_rate, s.fx_shift, (case when s.fx_shift is null then (s.order_shipping) else cast(round((s.order_shipping) * (cast(s.fx_rate as double precision) * (case s.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as order_shipping, (case when s.fx_shift is null then (s.order_discount) else cast(round((s.order_discount) * (cast(s.fx_rate as double precision) * (case s.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as order_discount, (case when s.fx_shift is null then (s.order_tax) else cast(round((s.order_tax) * (cast(s.fx_rate as double precision) * (case s.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as order_tax from (select NEW.id as order_id, NEW.created_at as created_at, NEW.shop_currency as shop_currency, (case when NEW.customer_id is not null then 'c:' || NEW.customer_id else 'o:' || NEW.id end) as identity, NEW.channel as channel, NEW.channel_source as channel_source, NEW.payment_method as payment_method, NEW.city_name as city_name, NEW.shipping_method_id as shipping_method_id, NEW.shipping_method_kind as shipping_method_kind, NEW.requires_shipping as requires_shipping, NEW.fulfillment_location_id as fulfillment_location_id, (case when NEW.deleted_at is null and NEW.status not in ('incomplete', 'cancelled') then 1 else 0 end) as order_count, (case when NEW.deleted_at is null and NEW.status <> 'incomplete' then 1 else 0 end) as placed, (case when NEW.deleted_at is null and NEW.status = 'cancelled' then 1 else 0 end) as cancelled, (case when NEW.status in ('returned', 'refunded') then 1 else 0 end) as reversed, (case when NEW.status in ('delivered', 'completed') then 1 else 0 end) as delivered, (case when NEW.prices_include_tax = 1 then 1 else 0 end) as incl, NEW.fx_rate as fx_rate, (case when NEW.currency_code = NEW.shop_currency then null
    when NEW.currency_decimal_places in (0, 1, 2, 3) then (case when upper(trim(NEW.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then 0 when upper(trim(NEW.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then 3 when upper(trim(NEW.shop_currency)) in ('CLF', 'UYW') then 4 else 2 end) - NEW.currency_decimal_places else 0 end) as fx_shift, NEW.shipping_amount_minor as order_shipping, NEW.discount_amount_minor as order_discount, NEW.tax_amount_minor as order_tax) as s) as o where 1 = 1
    on conflict (order_id) do update set created_at = excluded.created_at, shop_currency = excluded.shop_currency, identity = excluded.identity, channel = excluded.channel, channel_source = excluded.channel_source, payment_method = excluded.payment_method, city_name = excluded.city_name, shipping_method_id = excluded.shipping_method_id, shipping_method_kind = excluded.shipping_method_kind, requires_shipping = excluded.requires_shipping, fulfillment_location_id = excluded.fulfillment_location_id, order_count = excluded.order_count, placed = excluded.placed, cancelled = excluded.cancelled, reversed = excluded.reversed, delivered = excluded.delivered, incl = excluded.incl, fx_rate = excluded.fx_rate, fx_shift = excluded.fx_shift, order_shipping = excluded.order_shipping, order_discount = excluded.order_discount, order_tax = excluded.order_tax;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_orders_reconvert
AFTER UPDATE OF shop_currency, currency_code, currency_decimal_places, fx_rate, prices_include_tax ON orders
WHEN OLD.shop_currency IS NOT NEW.shop_currency OR OLD.currency_code IS NOT NEW.currency_code OR OLD.currency_decimal_places IS NOT NEW.currency_decimal_places OR OLD.fx_rate IS NOT NEW.fx_rate OR OLD.prices_include_tax IS NOT NEW.prices_include_tax
BEGIN
  insert into analytics_order_facts (order_id, created_at, shop_currency, identity, channel, payment_method, requires_shipping, line_gross, line_disc, line_returns, line_kept_tax, line_units, line_rev_returns, line_rev_kept_tax, line_disc_all, line_tax_all)
    select f.order_id, f.created_at, f.shop_currency, f.identity, f.channel, f.payment_method, f.requires_shipping, coalesce(s.line_gross, 0), coalesce(s.line_disc, 0), coalesce(s.line_returns, 0), coalesce(s.line_kept_tax, 0), coalesce(s.line_units, 0), coalesce(s.line_rev_returns, 0), coalesce(s.line_rev_kept_tax, 0), coalesce(s.line_disc_all, 0), coalesce(s.line_tax_all, 0)
    from analytics_order_facts f left join (with lr as materialized (select oi.order_id as order_id, oi.quantity as quantity, oi.line_subtotal_minor as line_subtotal_minor, oi.discount_amount_minor as discount_amount_minor, oi.tax_amount_minor as tax_amount_minor, oi.fulfillment_type as fulfillment_type, x.fx_rate as fx_rate, x.fx_shift as fx_shift, x.incl as incl,
      (select cast(coalesce(sum(rl.approved_quantity), 0) as bigint) from order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = oi.order_id and rl.order_item_id = oi.id and rr.status in ('approved', 'receiving', 'completed')) as raw, 1 as sign
    from order_items oi cross join (select NEW.fx_rate as fx_rate, (case when NEW.currency_code = NEW.shop_currency then null
    when NEW.currency_decimal_places in (0, 1, 2, 3) then (case when upper(trim(NEW.shop_currency)) in ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF') then 0 when upper(trim(NEW.shop_currency)) in ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') then 3 when upper(trim(NEW.shop_currency)) in ('CLF', 'UYW') then 4 else 2 end) - NEW.currency_decimal_places else 0 end) as fx_shift,
      (case when NEW.prices_include_tax = 1 then 1 else 0 end) as incl) as x
    where oi.order_id = NEW.id),
    lb as materialized (select lr.order_id, lr.sign, lr.quantity as q,
        (case when lr.raw > lr.quantity then lr.quantity else lr.raw end) as rq,
        (case when lr.fulfillment_type = 'gift_card' then 1 else 0 end) as gc,
        (case when lr.fx_shift is null then (lr.line_subtotal_minor - (case when lr.incl = 1 then lr.tax_amount_minor else 0 end)) else cast(round((lr.line_subtotal_minor - (case when lr.incl = 1 then lr.tax_amount_minor else 0 end)) * (cast(lr.fx_rate as double precision) * (case lr.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as g,
        (case when lr.fx_shift is null then (lr.discount_amount_minor) else cast(round((lr.discount_amount_minor) * (cast(lr.fx_rate as double precision) * (case lr.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as d, (case when lr.fx_shift is null then (lr.tax_amount_minor) else cast(round((lr.tax_amount_minor) * (cast(lr.fx_rate as double precision) * (case lr.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as t
      from lr) select lb.order_id, cast(sum(lb.sign * (case when lb.gc = 0 then lb.g else 0 end)) as bigint) as line_gross, cast(sum(lb.sign * (case when lb.gc = 0 then lb.d else 0 end)) as bigint) as line_disc, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.rq = 0 then 0 when lb.rq = lb.q then lb.g - lb.d
    else ((lb.g - lb.d) * lb.rq) / lb.q end) else 0 end)) as bigint) as line_returns, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.rq = 0 then lb.t when lb.rq = lb.q then 0
    else lb.t - (lb.t * lb.rq) / lb.q end) else 0 end)) as bigint) as line_kept_tax, cast(sum(lb.sign * (case when lb.gc = 0 then (lb.q - lb.rq) else 0 end)) as bigint) as line_units, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.q = 0 then 0 else lb.g - lb.d end) else 0 end)) as bigint) as line_rev_returns, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.q = 0 then lb.t else 0 end) else 0 end)) as bigint) as line_rev_kept_tax, cast(sum(lb.sign * lb.d) as bigint) as line_disc_all, cast(sum(lb.sign * lb.t) as bigint) as line_tax_all
  from lb group by lb.order_id) as s on s.order_id = f.order_id
    where f.order_id = NEW.id
    on conflict (order_id) do update set line_gross = excluded.line_gross, line_disc = excluded.line_disc, line_returns = excluded.line_returns, line_kept_tax = excluded.line_kept_tax, line_units = excluded.line_units, line_rev_returns = excluded.line_rev_returns, line_rev_kept_tax = excluded.line_rev_kept_tax, line_disc_all = excluded.line_disc_all, line_tax_all = excluded.line_tax_all;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_order_items_insert
AFTER INSERT ON order_items
BEGIN
  insert into analytics_order_facts (order_id, created_at, shop_currency, identity, channel, payment_method, requires_shipping, line_gross, line_disc, line_returns, line_kept_tax, line_units, line_rev_returns, line_rev_kept_tax, line_disc_all, line_tax_all)
    select f.order_id, f.created_at, f.shop_currency, f.identity, f.channel, f.payment_method, f.requires_shipping, f.line_gross + s.line_gross, f.line_disc + s.line_disc, f.line_returns + s.line_returns, f.line_kept_tax + s.line_kept_tax, f.line_units + s.line_units, f.line_rev_returns + s.line_rev_returns, f.line_rev_kept_tax + s.line_rev_kept_tax, f.line_disc_all + s.line_disc_all, f.line_tax_all + s.line_tax_all
    from analytics_order_facts f join (with lr as materialized (select NEW.order_id as order_id, NEW.quantity as quantity, NEW.line_subtotal_minor as line_subtotal_minor, NEW.discount_amount_minor as discount_amount_minor, NEW.tax_amount_minor as tax_amount_minor, NEW.fulfillment_type as fulfillment_type, c.fx_rate as fx_rate, c.fx_shift as fx_shift, c.incl as incl,
      (select cast(coalesce(sum(rl.approved_quantity), 0) as bigint) from order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = NEW.order_id and rl.order_item_id = NEW.id and rr.status in ('approved', 'receiving', 'completed')) as raw, 1 as sign
    from analytics_order_facts c where c.order_id = NEW.order_id),
    lb as materialized (select lr.order_id, lr.sign, lr.quantity as q,
        (case when lr.raw > lr.quantity then lr.quantity else lr.raw end) as rq,
        (case when lr.fulfillment_type = 'gift_card' then 1 else 0 end) as gc,
        (case when lr.fx_shift is null then (lr.line_subtotal_minor - (case when lr.incl = 1 then lr.tax_amount_minor else 0 end)) else cast(round((lr.line_subtotal_minor - (case when lr.incl = 1 then lr.tax_amount_minor else 0 end)) * (cast(lr.fx_rate as double precision) * (case lr.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as g,
        (case when lr.fx_shift is null then (lr.discount_amount_minor) else cast(round((lr.discount_amount_minor) * (cast(lr.fx_rate as double precision) * (case lr.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as d, (case when lr.fx_shift is null then (lr.tax_amount_minor) else cast(round((lr.tax_amount_minor) * (cast(lr.fx_rate as double precision) * (case lr.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as t
      from lr) select lb.order_id, cast(sum(lb.sign * (case when lb.gc = 0 then lb.g else 0 end)) as bigint) as line_gross, cast(sum(lb.sign * (case when lb.gc = 0 then lb.d else 0 end)) as bigint) as line_disc, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.rq = 0 then 0 when lb.rq = lb.q then lb.g - lb.d
    else ((lb.g - lb.d) * lb.rq) / lb.q end) else 0 end)) as bigint) as line_returns, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.rq = 0 then lb.t when lb.rq = lb.q then 0
    else lb.t - (lb.t * lb.rq) / lb.q end) else 0 end)) as bigint) as line_kept_tax, cast(sum(lb.sign * (case when lb.gc = 0 then (lb.q - lb.rq) else 0 end)) as bigint) as line_units, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.q = 0 then 0 else lb.g - lb.d end) else 0 end)) as bigint) as line_rev_returns, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.q = 0 then lb.t else 0 end) else 0 end)) as bigint) as line_rev_kept_tax, cast(sum(lb.sign * lb.d) as bigint) as line_disc_all, cast(sum(lb.sign * lb.t) as bigint) as line_tax_all
  from lb group by lb.order_id) as s on s.order_id = f.order_id
    where 1 = 1
    on conflict (order_id) do update set line_gross = excluded.line_gross, line_disc = excluded.line_disc, line_returns = excluded.line_returns, line_kept_tax = excluded.line_kept_tax, line_units = excluded.line_units, line_rev_returns = excluded.line_rev_returns, line_rev_kept_tax = excluded.line_rev_kept_tax, line_disc_all = excluded.line_disc_all, line_tax_all = excluded.line_tax_all;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_order_items_update
AFTER UPDATE OF id, order_id, quantity, line_subtotal_minor, discount_amount_minor, tax_amount_minor, fulfillment_type ON order_items
WHEN OLD.id IS NOT NEW.id OR OLD.order_id IS NOT NEW.order_id OR OLD.quantity IS NOT NEW.quantity OR OLD.line_subtotal_minor IS NOT NEW.line_subtotal_minor OR OLD.discount_amount_minor IS NOT NEW.discount_amount_minor OR OLD.tax_amount_minor IS NOT NEW.tax_amount_minor OR OLD.fulfillment_type IS NOT NEW.fulfillment_type
BEGIN
  insert into analytics_order_facts (order_id, created_at, shop_currency, identity, channel, payment_method, requires_shipping, line_gross, line_disc, line_returns, line_kept_tax, line_units, line_rev_returns, line_rev_kept_tax, line_disc_all, line_tax_all)
    select f.order_id, f.created_at, f.shop_currency, f.identity, f.channel, f.payment_method, f.requires_shipping, f.line_gross + s.line_gross, f.line_disc + s.line_disc, f.line_returns + s.line_returns, f.line_kept_tax + s.line_kept_tax, f.line_units + s.line_units, f.line_rev_returns + s.line_rev_returns, f.line_rev_kept_tax + s.line_rev_kept_tax, f.line_disc_all + s.line_disc_all, f.line_tax_all + s.line_tax_all
    from analytics_order_facts f join (with lr as materialized (select OLD.order_id as order_id, OLD.quantity as quantity, OLD.line_subtotal_minor as line_subtotal_minor, OLD.discount_amount_minor as discount_amount_minor, OLD.tax_amount_minor as tax_amount_minor, OLD.fulfillment_type as fulfillment_type, c.fx_rate as fx_rate, c.fx_shift as fx_shift, c.incl as incl,
      (select cast(coalesce(sum(rl.approved_quantity), 0) as bigint) from order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = OLD.order_id and rl.order_item_id = OLD.id and rr.status in ('approved', 'receiving', 'completed')) as raw, -1 as sign
    from analytics_order_facts c where c.order_id = OLD.order_id union all select NEW.order_id as order_id, NEW.quantity as quantity, NEW.line_subtotal_minor as line_subtotal_minor, NEW.discount_amount_minor as discount_amount_minor, NEW.tax_amount_minor as tax_amount_minor, NEW.fulfillment_type as fulfillment_type, c.fx_rate as fx_rate, c.fx_shift as fx_shift, c.incl as incl,
      (select cast(coalesce(sum(rl.approved_quantity), 0) as bigint) from order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = NEW.order_id and rl.order_item_id = NEW.id and rr.status in ('approved', 'receiving', 'completed')) as raw, 1 as sign
    from analytics_order_facts c where c.order_id = NEW.order_id),
    lb as materialized (select lr.order_id, lr.sign, lr.quantity as q,
        (case when lr.raw > lr.quantity then lr.quantity else lr.raw end) as rq,
        (case when lr.fulfillment_type = 'gift_card' then 1 else 0 end) as gc,
        (case when lr.fx_shift is null then (lr.line_subtotal_minor - (case when lr.incl = 1 then lr.tax_amount_minor else 0 end)) else cast(round((lr.line_subtotal_minor - (case when lr.incl = 1 then lr.tax_amount_minor else 0 end)) * (cast(lr.fx_rate as double precision) * (case lr.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as g,
        (case when lr.fx_shift is null then (lr.discount_amount_minor) else cast(round((lr.discount_amount_minor) * (cast(lr.fx_rate as double precision) * (case lr.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as d, (case when lr.fx_shift is null then (lr.tax_amount_minor) else cast(round((lr.tax_amount_minor) * (cast(lr.fx_rate as double precision) * (case lr.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as t
      from lr) select lb.order_id, cast(sum(lb.sign * (case when lb.gc = 0 then lb.g else 0 end)) as bigint) as line_gross, cast(sum(lb.sign * (case when lb.gc = 0 then lb.d else 0 end)) as bigint) as line_disc, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.rq = 0 then 0 when lb.rq = lb.q then lb.g - lb.d
    else ((lb.g - lb.d) * lb.rq) / lb.q end) else 0 end)) as bigint) as line_returns, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.rq = 0 then lb.t when lb.rq = lb.q then 0
    else lb.t - (lb.t * lb.rq) / lb.q end) else 0 end)) as bigint) as line_kept_tax, cast(sum(lb.sign * (case when lb.gc = 0 then (lb.q - lb.rq) else 0 end)) as bigint) as line_units, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.q = 0 then 0 else lb.g - lb.d end) else 0 end)) as bigint) as line_rev_returns, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.q = 0 then lb.t else 0 end) else 0 end)) as bigint) as line_rev_kept_tax, cast(sum(lb.sign * lb.d) as bigint) as line_disc_all, cast(sum(lb.sign * lb.t) as bigint) as line_tax_all
  from lb group by lb.order_id) as s on s.order_id = f.order_id
    where 1 = 1
    on conflict (order_id) do update set line_gross = excluded.line_gross, line_disc = excluded.line_disc, line_returns = excluded.line_returns, line_kept_tax = excluded.line_kept_tax, line_units = excluded.line_units, line_rev_returns = excluded.line_rev_returns, line_rev_kept_tax = excluded.line_rev_kept_tax, line_disc_all = excluded.line_disc_all, line_tax_all = excluded.line_tax_all;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_order_items_delete
AFTER DELETE ON order_items
BEGIN
  insert into analytics_order_facts (order_id, created_at, shop_currency, identity, channel, payment_method, requires_shipping, line_gross, line_disc, line_returns, line_kept_tax, line_units, line_rev_returns, line_rev_kept_tax, line_disc_all, line_tax_all)
    select f.order_id, f.created_at, f.shop_currency, f.identity, f.channel, f.payment_method, f.requires_shipping, f.line_gross + s.line_gross, f.line_disc + s.line_disc, f.line_returns + s.line_returns, f.line_kept_tax + s.line_kept_tax, f.line_units + s.line_units, f.line_rev_returns + s.line_rev_returns, f.line_rev_kept_tax + s.line_rev_kept_tax, f.line_disc_all + s.line_disc_all, f.line_tax_all + s.line_tax_all
    from analytics_order_facts f join (with lr as materialized (select OLD.order_id as order_id, OLD.quantity as quantity, OLD.line_subtotal_minor as line_subtotal_minor, OLD.discount_amount_minor as discount_amount_minor, OLD.tax_amount_minor as tax_amount_minor, OLD.fulfillment_type as fulfillment_type, c.fx_rate as fx_rate, c.fx_shift as fx_shift, c.incl as incl,
      (select cast(coalesce(sum(rl.approved_quantity), 0) as bigint) from order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = OLD.order_id and rl.order_item_id = OLD.id and rr.status in ('approved', 'receiving', 'completed')) as raw, -1 as sign
    from analytics_order_facts c where c.order_id = OLD.order_id),
    lb as materialized (select lr.order_id, lr.sign, lr.quantity as q,
        (case when lr.raw > lr.quantity then lr.quantity else lr.raw end) as rq,
        (case when lr.fulfillment_type = 'gift_card' then 1 else 0 end) as gc,
        (case when lr.fx_shift is null then (lr.line_subtotal_minor - (case when lr.incl = 1 then lr.tax_amount_minor else 0 end)) else cast(round((lr.line_subtotal_minor - (case when lr.incl = 1 then lr.tax_amount_minor else 0 end)) * (cast(lr.fx_rate as double precision) * (case lr.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as g,
        (case when lr.fx_shift is null then (lr.discount_amount_minor) else cast(round((lr.discount_amount_minor) * (cast(lr.fx_rate as double precision) * (case lr.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as d, (case when lr.fx_shift is null then (lr.tax_amount_minor) else cast(round((lr.tax_amount_minor) * (cast(lr.fx_rate as double precision) * (case lr.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as t
      from lr) select lb.order_id, cast(sum(lb.sign * (case when lb.gc = 0 then lb.g else 0 end)) as bigint) as line_gross, cast(sum(lb.sign * (case when lb.gc = 0 then lb.d else 0 end)) as bigint) as line_disc, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.rq = 0 then 0 when lb.rq = lb.q then lb.g - lb.d
    else ((lb.g - lb.d) * lb.rq) / lb.q end) else 0 end)) as bigint) as line_returns, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.rq = 0 then lb.t when lb.rq = lb.q then 0
    else lb.t - (lb.t * lb.rq) / lb.q end) else 0 end)) as bigint) as line_kept_tax, cast(sum(lb.sign * (case when lb.gc = 0 then (lb.q - lb.rq) else 0 end)) as bigint) as line_units, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.q = 0 then 0 else lb.g - lb.d end) else 0 end)) as bigint) as line_rev_returns, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.q = 0 then lb.t else 0 end) else 0 end)) as bigint) as line_rev_kept_tax, cast(sum(lb.sign * lb.d) as bigint) as line_disc_all, cast(sum(lb.sign * lb.t) as bigint) as line_tax_all
  from lb group by lb.order_id) as s on s.order_id = f.order_id
    where 1 = 1
    on conflict (order_id) do update set line_gross = excluded.line_gross, line_disc = excluded.line_disc, line_returns = excluded.line_returns, line_kept_tax = excluded.line_kept_tax, line_units = excluded.line_units, line_rev_returns = excluded.line_rev_returns, line_rev_kept_tax = excluded.line_rev_kept_tax, line_disc_all = excluded.line_disc_all, line_tax_all = excluded.line_tax_all;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_return_lines_insert
AFTER INSERT ON order_return_lines
WHEN NEW.approved_quantity <> 0 AND EXISTS (SELECT 1 FROM order_returns r WHERE r.id = NEW.return_id AND r.status IN ('approved', 'receiving', 'completed'))
BEGIN
  insert into analytics_order_facts (order_id, created_at, shop_currency, identity, channel, payment_method, requires_shipping, line_gross, line_disc, line_returns, line_kept_tax, line_units, line_rev_returns, line_rev_kept_tax, line_disc_all, line_tax_all)
    select f.order_id, f.created_at, f.shop_currency, f.identity, f.channel, f.payment_method, f.requires_shipping, f.line_gross + s.line_gross, f.line_disc + s.line_disc, f.line_returns + s.line_returns, f.line_kept_tax + s.line_kept_tax, f.line_units + s.line_units, f.line_rev_returns + s.line_rev_returns, f.line_rev_kept_tax + s.line_rev_kept_tax, f.line_disc_all + s.line_disc_all, f.line_tax_all + s.line_tax_all
    from analytics_order_facts f join (with lr as materialized (select oi.order_id as order_id, oi.quantity as quantity, oi.line_subtotal_minor as line_subtotal_minor, oi.discount_amount_minor as discount_amount_minor, oi.tax_amount_minor as tax_amount_minor, oi.fulfillment_type as fulfillment_type, c.fx_rate as fx_rate, c.fx_shift as fx_shift, c.incl as incl,
        (select cast(coalesce(sum(rl.approved_quantity), 0) as bigint) from order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = oi.order_id and rl.order_item_id = oi.id and rr.status in ('approved', 'receiving', 'completed')) + (case when x.sign = 1 then 0 else - (case when (oi.id = NEW.order_item_id and oi.order_id = NEW.order_id) and EXISTS (SELECT 1 FROM order_returns r WHERE r.id = NEW.return_id AND r.status IN ('approved', 'receiving', 'completed')) then NEW.approved_quantity else 0 end) end) as raw, x.sign as sign
      from order_items oi join analytics_order_facts c on c.order_id = oi.order_id cross join (select 1 as sign union all select -1 as sign) as x
      where (oi.id = NEW.order_item_id and oi.order_id = NEW.order_id)),
    lb as materialized (select lr.order_id, lr.sign, lr.quantity as q,
        (case when lr.raw > lr.quantity then lr.quantity else lr.raw end) as rq,
        (case when lr.fulfillment_type = 'gift_card' then 1 else 0 end) as gc,
        (case when lr.fx_shift is null then (lr.line_subtotal_minor - (case when lr.incl = 1 then lr.tax_amount_minor else 0 end)) else cast(round((lr.line_subtotal_minor - (case when lr.incl = 1 then lr.tax_amount_minor else 0 end)) * (cast(lr.fx_rate as double precision) * (case lr.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as g,
        (case when lr.fx_shift is null then (lr.discount_amount_minor) else cast(round((lr.discount_amount_minor) * (cast(lr.fx_rate as double precision) * (case lr.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as d, (case when lr.fx_shift is null then (lr.tax_amount_minor) else cast(round((lr.tax_amount_minor) * (cast(lr.fx_rate as double precision) * (case lr.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as t
      from lr) select lb.order_id, cast(sum(lb.sign * (case when lb.gc = 0 then lb.g else 0 end)) as bigint) as line_gross, cast(sum(lb.sign * (case when lb.gc = 0 then lb.d else 0 end)) as bigint) as line_disc, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.rq = 0 then 0 when lb.rq = lb.q then lb.g - lb.d
    else ((lb.g - lb.d) * lb.rq) / lb.q end) else 0 end)) as bigint) as line_returns, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.rq = 0 then lb.t when lb.rq = lb.q then 0
    else lb.t - (lb.t * lb.rq) / lb.q end) else 0 end)) as bigint) as line_kept_tax, cast(sum(lb.sign * (case when lb.gc = 0 then (lb.q - lb.rq) else 0 end)) as bigint) as line_units, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.q = 0 then 0 else lb.g - lb.d end) else 0 end)) as bigint) as line_rev_returns, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.q = 0 then lb.t else 0 end) else 0 end)) as bigint) as line_rev_kept_tax, cast(sum(lb.sign * lb.d) as bigint) as line_disc_all, cast(sum(lb.sign * lb.t) as bigint) as line_tax_all
  from lb group by lb.order_id) as s on s.order_id = f.order_id
    where 1 = 1
    on conflict (order_id) do update set line_gross = excluded.line_gross, line_disc = excluded.line_disc, line_returns = excluded.line_returns, line_kept_tax = excluded.line_kept_tax, line_units = excluded.line_units, line_rev_returns = excluded.line_rev_returns, line_rev_kept_tax = excluded.line_rev_kept_tax, line_disc_all = excluded.line_disc_all, line_tax_all = excluded.line_tax_all;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_return_lines_update
AFTER UPDATE OF order_id, return_id, order_item_id, approved_quantity ON order_return_lines
WHEN (OLD.order_id IS NOT NEW.order_id OR OLD.return_id IS NOT NEW.return_id OR OLD.order_item_id IS NOT NEW.order_item_id OR OLD.approved_quantity IS NOT NEW.approved_quantity) AND (EXISTS (SELECT 1 FROM order_returns r WHERE r.id = OLD.return_id AND r.status IN ('approved', 'receiving', 'completed')) OR EXISTS (SELECT 1 FROM order_returns r WHERE r.id = NEW.return_id AND r.status IN ('approved', 'receiving', 'completed')))
BEGIN
  insert into analytics_order_facts (order_id, created_at, shop_currency, identity, channel, payment_method, requires_shipping, line_gross, line_disc, line_returns, line_kept_tax, line_units, line_rev_returns, line_rev_kept_tax, line_disc_all, line_tax_all)
    select f.order_id, f.created_at, f.shop_currency, f.identity, f.channel, f.payment_method, f.requires_shipping, f.line_gross + s.line_gross, f.line_disc + s.line_disc, f.line_returns + s.line_returns, f.line_kept_tax + s.line_kept_tax, f.line_units + s.line_units, f.line_rev_returns + s.line_rev_returns, f.line_rev_kept_tax + s.line_rev_kept_tax, f.line_disc_all + s.line_disc_all, f.line_tax_all + s.line_tax_all
    from analytics_order_facts f join (with lr as materialized (select oi.order_id as order_id, oi.quantity as quantity, oi.line_subtotal_minor as line_subtotal_minor, oi.discount_amount_minor as discount_amount_minor, oi.tax_amount_minor as tax_amount_minor, oi.fulfillment_type as fulfillment_type, c.fx_rate as fx_rate, c.fx_shift as fx_shift, c.incl as incl,
        (select cast(coalesce(sum(rl.approved_quantity), 0) as bigint) from order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = oi.order_id and rl.order_item_id = oi.id and rr.status in ('approved', 'receiving', 'completed')) + (case when x.sign = 1 then 0 else + (case when (oi.id = OLD.order_item_id and oi.order_id = OLD.order_id) and EXISTS (SELECT 1 FROM order_returns r WHERE r.id = OLD.return_id AND r.status IN ('approved', 'receiving', 'completed')) then OLD.approved_quantity else 0 end) - (case when (oi.id = NEW.order_item_id and oi.order_id = NEW.order_id) and EXISTS (SELECT 1 FROM order_returns r WHERE r.id = NEW.return_id AND r.status IN ('approved', 'receiving', 'completed')) then NEW.approved_quantity else 0 end) end) as raw, x.sign as sign
      from order_items oi join analytics_order_facts c on c.order_id = oi.order_id cross join (select 1 as sign union all select -1 as sign) as x
      where (oi.id = OLD.order_item_id and oi.order_id = OLD.order_id) or (oi.id = NEW.order_item_id and oi.order_id = NEW.order_id)),
    lb as materialized (select lr.order_id, lr.sign, lr.quantity as q,
        (case when lr.raw > lr.quantity then lr.quantity else lr.raw end) as rq,
        (case when lr.fulfillment_type = 'gift_card' then 1 else 0 end) as gc,
        (case when lr.fx_shift is null then (lr.line_subtotal_minor - (case when lr.incl = 1 then lr.tax_amount_minor else 0 end)) else cast(round((lr.line_subtotal_minor - (case when lr.incl = 1 then lr.tax_amount_minor else 0 end)) * (cast(lr.fx_rate as double precision) * (case lr.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as g,
        (case when lr.fx_shift is null then (lr.discount_amount_minor) else cast(round((lr.discount_amount_minor) * (cast(lr.fx_rate as double precision) * (case lr.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as d, (case when lr.fx_shift is null then (lr.tax_amount_minor) else cast(round((lr.tax_amount_minor) * (cast(lr.fx_rate as double precision) * (case lr.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as t
      from lr) select lb.order_id, cast(sum(lb.sign * (case when lb.gc = 0 then lb.g else 0 end)) as bigint) as line_gross, cast(sum(lb.sign * (case when lb.gc = 0 then lb.d else 0 end)) as bigint) as line_disc, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.rq = 0 then 0 when lb.rq = lb.q then lb.g - lb.d
    else ((lb.g - lb.d) * lb.rq) / lb.q end) else 0 end)) as bigint) as line_returns, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.rq = 0 then lb.t when lb.rq = lb.q then 0
    else lb.t - (lb.t * lb.rq) / lb.q end) else 0 end)) as bigint) as line_kept_tax, cast(sum(lb.sign * (case when lb.gc = 0 then (lb.q - lb.rq) else 0 end)) as bigint) as line_units, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.q = 0 then 0 else lb.g - lb.d end) else 0 end)) as bigint) as line_rev_returns, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.q = 0 then lb.t else 0 end) else 0 end)) as bigint) as line_rev_kept_tax, cast(sum(lb.sign * lb.d) as bigint) as line_disc_all, cast(sum(lb.sign * lb.t) as bigint) as line_tax_all
  from lb group by lb.order_id) as s on s.order_id = f.order_id
    where 1 = 1
    on conflict (order_id) do update set line_gross = excluded.line_gross, line_disc = excluded.line_disc, line_returns = excluded.line_returns, line_kept_tax = excluded.line_kept_tax, line_units = excluded.line_units, line_rev_returns = excluded.line_rev_returns, line_rev_kept_tax = excluded.line_rev_kept_tax, line_disc_all = excluded.line_disc_all, line_tax_all = excluded.line_tax_all;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_return_lines_delete
AFTER DELETE ON order_return_lines
WHEN OLD.approved_quantity <> 0 AND EXISTS (SELECT 1 FROM order_returns r WHERE r.id = OLD.return_id AND r.status IN ('approved', 'receiving', 'completed'))
BEGIN
  insert into analytics_order_facts (order_id, created_at, shop_currency, identity, channel, payment_method, requires_shipping, line_gross, line_disc, line_returns, line_kept_tax, line_units, line_rev_returns, line_rev_kept_tax, line_disc_all, line_tax_all)
    select f.order_id, f.created_at, f.shop_currency, f.identity, f.channel, f.payment_method, f.requires_shipping, f.line_gross + s.line_gross, f.line_disc + s.line_disc, f.line_returns + s.line_returns, f.line_kept_tax + s.line_kept_tax, f.line_units + s.line_units, f.line_rev_returns + s.line_rev_returns, f.line_rev_kept_tax + s.line_rev_kept_tax, f.line_disc_all + s.line_disc_all, f.line_tax_all + s.line_tax_all
    from analytics_order_facts f join (with lr as materialized (select oi.order_id as order_id, oi.quantity as quantity, oi.line_subtotal_minor as line_subtotal_minor, oi.discount_amount_minor as discount_amount_minor, oi.tax_amount_minor as tax_amount_minor, oi.fulfillment_type as fulfillment_type, c.fx_rate as fx_rate, c.fx_shift as fx_shift, c.incl as incl,
        (select cast(coalesce(sum(rl.approved_quantity), 0) as bigint) from order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = oi.order_id and rl.order_item_id = oi.id and rr.status in ('approved', 'receiving', 'completed')) + (case when x.sign = 1 then 0 else + (case when (oi.id = OLD.order_item_id and oi.order_id = OLD.order_id) and EXISTS (SELECT 1 FROM order_returns r WHERE r.id = OLD.return_id AND r.status IN ('approved', 'receiving', 'completed')) then OLD.approved_quantity else 0 end) end) as raw, x.sign as sign
      from order_items oi join analytics_order_facts c on c.order_id = oi.order_id cross join (select 1 as sign union all select -1 as sign) as x
      where (oi.id = OLD.order_item_id and oi.order_id = OLD.order_id)),
    lb as materialized (select lr.order_id, lr.sign, lr.quantity as q,
        (case when lr.raw > lr.quantity then lr.quantity else lr.raw end) as rq,
        (case when lr.fulfillment_type = 'gift_card' then 1 else 0 end) as gc,
        (case when lr.fx_shift is null then (lr.line_subtotal_minor - (case when lr.incl = 1 then lr.tax_amount_minor else 0 end)) else cast(round((lr.line_subtotal_minor - (case when lr.incl = 1 then lr.tax_amount_minor else 0 end)) * (cast(lr.fx_rate as double precision) * (case lr.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as g,
        (case when lr.fx_shift is null then (lr.discount_amount_minor) else cast(round((lr.discount_amount_minor) * (cast(lr.fx_rate as double precision) * (case lr.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as d, (case when lr.fx_shift is null then (lr.tax_amount_minor) else cast(round((lr.tax_amount_minor) * (cast(lr.fx_rate as double precision) * (case lr.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as t
      from lr) select lb.order_id, cast(sum(lb.sign * (case when lb.gc = 0 then lb.g else 0 end)) as bigint) as line_gross, cast(sum(lb.sign * (case when lb.gc = 0 then lb.d else 0 end)) as bigint) as line_disc, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.rq = 0 then 0 when lb.rq = lb.q then lb.g - lb.d
    else ((lb.g - lb.d) * lb.rq) / lb.q end) else 0 end)) as bigint) as line_returns, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.rq = 0 then lb.t when lb.rq = lb.q then 0
    else lb.t - (lb.t * lb.rq) / lb.q end) else 0 end)) as bigint) as line_kept_tax, cast(sum(lb.sign * (case when lb.gc = 0 then (lb.q - lb.rq) else 0 end)) as bigint) as line_units, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.q = 0 then 0 else lb.g - lb.d end) else 0 end)) as bigint) as line_rev_returns, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.q = 0 then lb.t else 0 end) else 0 end)) as bigint) as line_rev_kept_tax, cast(sum(lb.sign * lb.d) as bigint) as line_disc_all, cast(sum(lb.sign * lb.t) as bigint) as line_tax_all
  from lb group by lb.order_id) as s on s.order_id = f.order_id
    where 1 = 1
    on conflict (order_id) do update set line_gross = excluded.line_gross, line_disc = excluded.line_disc, line_returns = excluded.line_returns, line_kept_tax = excluded.line_kept_tax, line_units = excluded.line_units, line_rev_returns = excluded.line_rev_returns, line_rev_kept_tax = excluded.line_rev_kept_tax, line_disc_all = excluded.line_disc_all, line_tax_all = excluded.line_tax_all;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_returns_status
AFTER UPDATE OF status ON order_returns
WHEN (case when OLD.status in ('approved', 'receiving', 'completed') then 1 else 0 end) <> (case when NEW.status in ('approved', 'receiving', 'completed') then 1 else 0 end)
BEGIN
  insert into analytics_order_facts (order_id, created_at, shop_currency, identity, channel, payment_method, requires_shipping, line_gross, line_disc, line_returns, line_kept_tax, line_units, line_rev_returns, line_rev_kept_tax, line_disc_all, line_tax_all)
    select f.order_id, f.created_at, f.shop_currency, f.identity, f.channel, f.payment_method, f.requires_shipping, f.line_gross + s.line_gross, f.line_disc + s.line_disc, f.line_returns + s.line_returns, f.line_kept_tax + s.line_kept_tax, f.line_units + s.line_units, f.line_rev_returns + s.line_rev_returns, f.line_rev_kept_tax + s.line_rev_kept_tax, f.line_disc_all + s.line_disc_all, f.line_tax_all + s.line_tax_all
    from analytics_order_facts f join (with lr as materialized (select oi.order_id as order_id, oi.quantity as quantity, oi.line_subtotal_minor as line_subtotal_minor, oi.discount_amount_minor as discount_amount_minor, oi.tax_amount_minor as tax_amount_minor, oi.fulfillment_type as fulfillment_type, c.fx_rate as fx_rate, c.fx_shift as fx_shift, c.incl as incl,
      (select cast(coalesce(sum(rl.approved_quantity), 0) as bigint) from order_return_lines rl
    join order_returns rr on rr.id = rl.return_id
    where rl.order_id = oi.order_id and rl.order_item_id = oi.id and rr.status in ('approved', 'receiving', 'completed')) + (case when x.sign = 1 then 0
        else ((case when OLD.status in ('approved', 'receiving', 'completed') then 1 else 0 end) - (case when NEW.status in ('approved', 'receiving', 'completed') then 1 else 0 end)) * rl.approved_quantity end) as raw, x.sign as sign
    from order_return_lines rl join order_items oi on oi.id = rl.order_item_id and oi.order_id = rl.order_id
    join analytics_order_facts c on c.order_id = oi.order_id cross join (select 1 as sign union all select -1 as sign) as x
    where rl.return_id = NEW.id),
    lb as materialized (select lr.order_id, lr.sign, lr.quantity as q,
        (case when lr.raw > lr.quantity then lr.quantity else lr.raw end) as rq,
        (case when lr.fulfillment_type = 'gift_card' then 1 else 0 end) as gc,
        (case when lr.fx_shift is null then (lr.line_subtotal_minor - (case when lr.incl = 1 then lr.tax_amount_minor else 0 end)) else cast(round((lr.line_subtotal_minor - (case when lr.incl = 1 then lr.tax_amount_minor else 0 end)) * (cast(lr.fx_rate as double precision) * (case lr.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as g,
        (case when lr.fx_shift is null then (lr.discount_amount_minor) else cast(round((lr.discount_amount_minor) * (cast(lr.fx_rate as double precision) * (case lr.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as d, (case when lr.fx_shift is null then (lr.tax_amount_minor) else cast(round((lr.tax_amount_minor) * (cast(lr.fx_rate as double precision) * (case lr.fx_shift when 4 then 10000.0 when 3 then 1000.0 when 2 then 100.0 when 1 then 10.0 when 0 then 1.0 when -1 then 0.1 when -2 then 0.01 when -3 then 0.001 end)), 0) as bigint) end) as t
      from lr) select lb.order_id, cast(sum(lb.sign * (case when lb.gc = 0 then lb.g else 0 end)) as bigint) as line_gross, cast(sum(lb.sign * (case when lb.gc = 0 then lb.d else 0 end)) as bigint) as line_disc, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.rq = 0 then 0 when lb.rq = lb.q then lb.g - lb.d
    else ((lb.g - lb.d) * lb.rq) / lb.q end) else 0 end)) as bigint) as line_returns, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.rq = 0 then lb.t when lb.rq = lb.q then 0
    else lb.t - (lb.t * lb.rq) / lb.q end) else 0 end)) as bigint) as line_kept_tax, cast(sum(lb.sign * (case when lb.gc = 0 then (lb.q - lb.rq) else 0 end)) as bigint) as line_units, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.q = 0 then 0 else lb.g - lb.d end) else 0 end)) as bigint) as line_rev_returns, cast(sum(lb.sign * (case when lb.gc = 0 then (case when lb.q = 0 then lb.t else 0 end) else 0 end)) as bigint) as line_rev_kept_tax, cast(sum(lb.sign * lb.d) as bigint) as line_disc_all, cast(sum(lb.sign * lb.t) as bigint) as line_tax_all
  from lb group by lb.order_id) as s on s.order_id = f.order_id
    where 1 = 1
    on conflict (order_id) do update set line_gross = excluded.line_gross, line_disc = excluded.line_disc, line_returns = excluded.line_returns, line_kept_tax = excluded.line_kept_tax, line_units = excluded.line_units, line_rev_returns = excluded.line_rev_returns, line_rev_kept_tax = excluded.line_rev_kept_tax, line_disc_all = excluded.line_disc_all, line_tax_all = excluded.line_tax_all;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_payments_insert
AFTER INSERT ON order_payments
WHEN NEW.payment_type = 'refund' AND NEW.status = 'refunded'
BEGIN
  UPDATE analytics_order_facts SET refund_sum = refund_sum + (case when order_id = NEW.order_id and NEW.payment_type = 'refund' AND NEW.status = 'refunded' then coalesce(NEW.amount_minor, 0) else 0 end) WHERE order_id IN (NEW.order_id);
END;
--> statement-breakpoint
CREATE TRIGGER analytics_payments_update
AFTER UPDATE OF order_id, payment_type, status, amount_minor ON order_payments
WHEN (OLD.order_id IS NOT NEW.order_id OR OLD.payment_type IS NOT NEW.payment_type OR OLD.status IS NOT NEW.status OR OLD.amount_minor IS NOT NEW.amount_minor) AND (OLD.payment_type = 'refund' AND OLD.status = 'refunded' OR NEW.payment_type = 'refund' AND NEW.status = 'refunded')
BEGIN
  UPDATE analytics_order_facts SET refund_sum = refund_sum - (case when order_id = OLD.order_id and OLD.payment_type = 'refund' AND OLD.status = 'refunded' then coalesce(OLD.amount_minor, 0) else 0 end) + (case when order_id = NEW.order_id and NEW.payment_type = 'refund' AND NEW.status = 'refunded' then coalesce(NEW.amount_minor, 0) else 0 end) WHERE order_id IN (OLD.order_id, NEW.order_id);
END;
--> statement-breakpoint
CREATE TRIGGER analytics_payments_delete
AFTER DELETE ON order_payments
WHEN OLD.payment_type = 'refund' AND OLD.status = 'refunded'
BEGIN
  UPDATE analytics_order_facts SET refund_sum = refund_sum - (case when order_id = OLD.order_id and OLD.payment_type = 'refund' AND OLD.status = 'refunded' then coalesce(OLD.amount_minor, 0) else 0 end) WHERE order_id IN (OLD.order_id);
END;
--> statement-breakpoint
CREATE TRIGGER analytics_cod_insert
AFTER INSERT ON cod_tracking
WHEN NEW.cod_status = 'collected'
BEGIN
  UPDATE analytics_order_facts SET cod_collected = cod_collected + (case when order_id = NEW.order_id and NEW.cod_status = 'collected' then 1 else 0 end) WHERE order_id IN (NEW.order_id);
END;
--> statement-breakpoint
CREATE TRIGGER analytics_cod_update
AFTER UPDATE OF order_id, cod_status ON cod_tracking
WHEN (OLD.order_id IS NOT NEW.order_id OR OLD.cod_status IS NOT NEW.cod_status) AND (OLD.cod_status = 'collected' OR NEW.cod_status = 'collected')
BEGIN
  UPDATE analytics_order_facts SET cod_collected = cod_collected - (case when order_id = OLD.order_id and OLD.cod_status = 'collected' then 1 else 0 end) + (case when order_id = NEW.order_id and NEW.cod_status = 'collected' then 1 else 0 end) WHERE order_id IN (OLD.order_id, NEW.order_id);
END;
--> statement-breakpoint
CREATE TRIGGER analytics_cod_delete
AFTER DELETE ON cod_tracking
WHEN OLD.cod_status = 'collected'
BEGIN
  UPDATE analytics_order_facts SET cod_collected = cod_collected - (case when order_id = OLD.order_id and OLD.cod_status = 'collected' then 1 else 0 end) WHERE order_id IN (OLD.order_id);
END;
--> statement-breakpoint
CREATE TRIGGER analytics_facts_unseal_insert
AFTER INSERT ON analytics_order_facts
WHEN EXISTS (SELECT 1 FROM analytics_sealed_days s WHERE s.day = ((cast(NEW.created_at / 86400 as bigint) - case when NEW.created_at < 0 and NEW.created_at <> cast(NEW.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400))
BEGIN
  DELETE FROM analytics_sealed_days WHERE day IN (((cast(NEW.created_at / 86400 as bigint) - case when NEW.created_at < 0 and NEW.created_at <> cast(NEW.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400));
END;
--> statement-breakpoint
CREATE TRIGGER analytics_facts_unseal_update
AFTER UPDATE ON analytics_order_facts
WHEN EXISTS (SELECT 1 FROM analytics_sealed_days s WHERE s.day = ((cast(OLD.created_at / 86400 as bigint) - case when OLD.created_at < 0 and OLD.created_at <> cast(OLD.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400)) OR EXISTS (SELECT 1 FROM analytics_sealed_days s WHERE s.day = ((cast(NEW.created_at / 86400 as bigint) - case when NEW.created_at < 0 and NEW.created_at <> cast(NEW.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400))
BEGIN
  DELETE FROM analytics_sealed_days WHERE day IN (((cast(OLD.created_at / 86400 as bigint) - case when OLD.created_at < 0 and OLD.created_at <> cast(OLD.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400), ((cast(NEW.created_at / 86400 as bigint) - case when NEW.created_at < 0 and NEW.created_at <> cast(NEW.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400));
END;
--> statement-breakpoint
CREATE TRIGGER analytics_facts_unseal_delete
AFTER DELETE ON analytics_order_facts
WHEN EXISTS (SELECT 1 FROM analytics_sealed_days s WHERE s.day = ((cast(OLD.created_at / 86400 as bigint) - case when OLD.created_at < 0 and OLD.created_at <> cast(OLD.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400))
BEGIN
  DELETE FROM analytics_sealed_days WHERE day IN (((cast(OLD.created_at / 86400 as bigint) - case when OLD.created_at < 0 and OLD.created_at <> cast(OLD.created_at / 86400 as bigint) * 86400 then 1 else 0 end) * 86400));
END;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (146, '0146_order_write_path', '3801adf16e889edd6f221afcc363e00edaf8fc143a8269a4519366e43c1d8ec0');
