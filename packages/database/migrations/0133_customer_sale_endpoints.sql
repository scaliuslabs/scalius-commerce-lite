DROP INDEX `analytics_customer_currency_range_idx`;
--> statement-breakpoint
ALTER TABLE `analytics_customer_currency_summary` ADD `third_sale_at` integer;
--> statement-breakpoint
ALTER TABLE `analytics_customer_currency_summary` ADD `fourth_sale_at` integer;
--> statement-breakpoint
ALTER TABLE `analytics_customer_currency_summary` ADD `penultimate_sale_at` integer;
--> statement-breakpoint
ALTER TABLE `analytics_customer_currency_summary` ADD `third_last_sale_at` integer;
--> statement-breakpoint
ALTER TABLE `analytics_customer_currency_summary` ADD `fourth_last_sale_at` integer;
--> statement-breakpoint
update analytics_customer_currency_summary set third_sale_at =
    (select f.created_at from analytics_order_facts f
      where f.shop_currency = analytics_customer_currency_summary.shop_currency
        and f.identity = analytics_customer_currency_summary.identity and f.order_count = 1
      order by f.created_at limit 1 offset 2), fourth_sale_at =
    (select f.created_at from analytics_order_facts f
      where f.shop_currency = analytics_customer_currency_summary.shop_currency
        and f.identity = analytics_customer_currency_summary.identity and f.order_count = 1
      order by f.created_at limit 1 offset 3), penultimate_sale_at =
    (select f.created_at from analytics_order_facts f
      where f.shop_currency = analytics_customer_currency_summary.shop_currency
        and f.identity = analytics_customer_currency_summary.identity and f.order_count = 1
      order by f.created_at desc limit 1 offset 1), third_last_sale_at =
    (select f.created_at from analytics_order_facts f
      where f.shop_currency = analytics_customer_currency_summary.shop_currency
        and f.identity = analytics_customer_currency_summary.identity and f.order_count = 1
      order by f.created_at desc limit 1 offset 2), fourth_last_sale_at =
    (select f.created_at from analytics_order_facts f
      where f.shop_currency = analytics_customer_currency_summary.shop_currency
        and f.identity = analytics_customer_currency_summary.identity and f.order_count = 1
      order by f.created_at desc limit 1 offset 3)
    where first_sale_at is not null;
--> statement-breakpoint
CREATE INDEX `analytics_customer_currency_range_idx` ON `analytics_customer_currency_summary` (`shop_currency`,`first_sale_at`,`last_sale_at`,`second_sale_at`,`first_sale_any_currency_at`,`identity`,`third_sale_at`,`fourth_sale_at`,`penultimate_sale_at`,`third_last_sale_at`,`fourth_last_sale_at`) WHERE "analytics_customer_currency_summary"."first_sale_at" IS NOT NULL;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_facts_customer_summary_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_facts_customer_summary_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS analytics_facts_customer_summary_delete;
--> statement-breakpoint
CREATE TRIGGER analytics_facts_customer_summary_insert
AFTER INSERT ON analytics_order_facts
WHEN NEW.order_count = 1
BEGIN
  insert into analytics_customer_currency_summary (identity, shop_currency, first_sale_at, second_sale_at, last_sale_at, first_sale_any_currency_at, third_sale_at, fourth_sale_at, penultimate_sale_at, third_last_sale_at, fourth_last_sale_at)
      select identity, shop_currency, (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at limit 1), (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at limit 1 offset 1), (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at desc limit 1),
        (select f.created_at from analytics_order_facts f where f.identity = affected.identity and f.order_count = 1 order by f.created_at limit 1), (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at limit 1 offset 2), (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at limit 1 offset 3), (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at desc limit 1 offset 1), (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at desc limit 1 offset 2), (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at desc limit 1 offset 3)
      from (select NEW.identity as identity, NEW.shop_currency as shop_currency) as affected where 1 = 1
      on conflict (identity, shop_currency) do update set first_sale_at = excluded.first_sale_at, second_sale_at = excluded.second_sale_at, last_sale_at = excluded.last_sale_at, first_sale_any_currency_at = excluded.first_sale_any_currency_at, third_sale_at = excluded.third_sale_at, fourth_sale_at = excluded.fourth_sale_at, penultimate_sale_at = excluded.penultimate_sale_at, third_last_sale_at = excluded.third_last_sale_at, fourth_last_sale_at = excluded.fourth_last_sale_at
      where analytics_customer_currency_summary.first_sale_at IS NOT excluded.first_sale_at OR analytics_customer_currency_summary.second_sale_at IS NOT excluded.second_sale_at OR analytics_customer_currency_summary.last_sale_at IS NOT excluded.last_sale_at OR analytics_customer_currency_summary.first_sale_any_currency_at IS NOT excluded.first_sale_any_currency_at OR analytics_customer_currency_summary.third_sale_at IS NOT excluded.third_sale_at OR analytics_customer_currency_summary.fourth_sale_at IS NOT excluded.fourth_sale_at OR analytics_customer_currency_summary.penultimate_sale_at IS NOT excluded.penultimate_sale_at OR analytics_customer_currency_summary.third_last_sale_at IS NOT excluded.third_last_sale_at OR analytics_customer_currency_summary.fourth_last_sale_at IS NOT excluded.fourth_last_sale_at;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_facts_customer_summary_update
AFTER UPDATE ON analytics_order_facts
WHEN (OLD.order_count = 1 OR NEW.order_count = 1) AND (OLD.identity IS NOT NEW.identity OR OLD.shop_currency IS NOT NEW.shop_currency OR OLD.created_at IS NOT NEW.created_at OR OLD.order_count IS NOT NEW.order_count)
BEGIN
  insert into analytics_customer_currency_summary (identity, shop_currency, first_sale_at, second_sale_at, last_sale_at, first_sale_any_currency_at, third_sale_at, fourth_sale_at, penultimate_sale_at, third_last_sale_at, fourth_last_sale_at)
      select identity, shop_currency, (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at limit 1), (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at limit 1 offset 1), (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at desc limit 1),
        (select f.created_at from analytics_order_facts f where f.identity = affected.identity and f.order_count = 1 order by f.created_at limit 1), (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at limit 1 offset 2), (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at limit 1 offset 3), (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at desc limit 1 offset 1), (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at desc limit 1 offset 2), (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at desc limit 1 offset 3)
      from (select OLD.identity as identity, OLD.shop_currency as shop_currency union select NEW.identity as identity, NEW.shop_currency as shop_currency) as affected where 1 = 1
      on conflict (identity, shop_currency) do update set first_sale_at = excluded.first_sale_at, second_sale_at = excluded.second_sale_at, last_sale_at = excluded.last_sale_at, first_sale_any_currency_at = excluded.first_sale_any_currency_at, third_sale_at = excluded.third_sale_at, fourth_sale_at = excluded.fourth_sale_at, penultimate_sale_at = excluded.penultimate_sale_at, third_last_sale_at = excluded.third_last_sale_at, fourth_last_sale_at = excluded.fourth_last_sale_at
      where analytics_customer_currency_summary.first_sale_at IS NOT excluded.first_sale_at OR analytics_customer_currency_summary.second_sale_at IS NOT excluded.second_sale_at OR analytics_customer_currency_summary.last_sale_at IS NOT excluded.last_sale_at OR analytics_customer_currency_summary.first_sale_any_currency_at IS NOT excluded.first_sale_any_currency_at OR analytics_customer_currency_summary.third_sale_at IS NOT excluded.third_sale_at OR analytics_customer_currency_summary.fourth_sale_at IS NOT excluded.fourth_sale_at OR analytics_customer_currency_summary.penultimate_sale_at IS NOT excluded.penultimate_sale_at OR analytics_customer_currency_summary.third_last_sale_at IS NOT excluded.third_last_sale_at OR analytics_customer_currency_summary.fourth_last_sale_at IS NOT excluded.fourth_last_sale_at;
END;
--> statement-breakpoint
CREATE TRIGGER analytics_facts_customer_summary_delete
AFTER DELETE ON analytics_order_facts
WHEN OLD.order_count = 1
BEGIN
  insert into analytics_customer_currency_summary (identity, shop_currency, first_sale_at, second_sale_at, last_sale_at, first_sale_any_currency_at, third_sale_at, fourth_sale_at, penultimate_sale_at, third_last_sale_at, fourth_last_sale_at)
      select identity, shop_currency, (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at limit 1), (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at limit 1 offset 1), (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at desc limit 1),
        (select f.created_at from analytics_order_facts f where f.identity = affected.identity and f.order_count = 1 order by f.created_at limit 1), (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at limit 1 offset 2), (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at limit 1 offset 3), (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at desc limit 1 offset 1), (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at desc limit 1 offset 2), (select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at desc limit 1 offset 3)
      from (select OLD.identity as identity, OLD.shop_currency as shop_currency) as affected where 1 = 1
      on conflict (identity, shop_currency) do update set first_sale_at = excluded.first_sale_at, second_sale_at = excluded.second_sale_at, last_sale_at = excluded.last_sale_at, first_sale_any_currency_at = excluded.first_sale_any_currency_at, third_sale_at = excluded.third_sale_at, fourth_sale_at = excluded.fourth_sale_at, penultimate_sale_at = excluded.penultimate_sale_at, third_last_sale_at = excluded.third_last_sale_at, fourth_last_sale_at = excluded.fourth_last_sale_at
      where analytics_customer_currency_summary.first_sale_at IS NOT excluded.first_sale_at OR analytics_customer_currency_summary.second_sale_at IS NOT excluded.second_sale_at OR analytics_customer_currency_summary.last_sale_at IS NOT excluded.last_sale_at OR analytics_customer_currency_summary.first_sale_any_currency_at IS NOT excluded.first_sale_any_currency_at OR analytics_customer_currency_summary.third_sale_at IS NOT excluded.third_sale_at OR analytics_customer_currency_summary.fourth_sale_at IS NOT excluded.fourth_sale_at OR analytics_customer_currency_summary.penultimate_sale_at IS NOT excluded.penultimate_sale_at OR analytics_customer_currency_summary.third_last_sale_at IS NOT excluded.third_last_sale_at OR analytics_customer_currency_summary.fourth_last_sale_at IS NOT excluded.fourth_last_sale_at;
END;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (133, '0133_customer_sale_endpoints', 'ed33c27cab213caf9fa3271322213ddae5f8b44150fafbd09bba30d95fb28aa8');
