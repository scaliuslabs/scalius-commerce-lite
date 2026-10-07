-- Markets step 6 (docs/MARKETS-DESIGN.md D2-D5, "Step 6 implemented"): a
-- second currency.
--
-- markets gain the currency they sell in: currency_code NULL sells in the
-- shop currency (the backup market always does); a code sells in that
-- currency, its prices converted from the base prices at fx_rate (price mode
-- `fx`) unless a price list fixes them (MARKET_CURRENCY_INVALID). The rate
-- keeps the time it was set (fx_rate_as_of, an order's fx_as_of) and the
-- minutes a placed order keeps it (fx_lock_minutes, default 30: an order's
-- fx_locked_until). Nothing changes for a store: every market keeps the shop
-- currency.
--
-- A change of a market's currency or lock advances the checkout authority
-- fence: a checkout priced in the old currency prices again. Its row's cache
-- dependency trigger (generated from packages/shared/src/cache-deps.ts) gains
-- the currency.
--
-- customer_order_stats counts what customers spent in the shop currency: an
-- order paid in another currency adds its paid share of its shop total. A
-- same-currency order adds what it did before, so no row changes.
ALTER TABLE `markets` ADD `currency_code` text CONSTRAINT `markets_currency_shape` CHECK (`currency_code` IS NULL OR (length(`currency_code`) = 3 AND `currency_code` NOT GLOB '*[^A-Z]*'));
--> statement-breakpoint
ALTER TABLE `markets` ADD `fx_rate_as_of` integer;
--> statement-breakpoint
ALTER TABLE `markets` ADD `fx_lock_minutes` integer DEFAULT 30 NOT NULL CONSTRAINT `markets_fx_lock_minutes` CHECK (`fx_lock_minutes` BETWEEN 5 AND 1440);
--> statement-breakpoint
-- A manual rate set before step 6 is as of the market's last change.
UPDATE `markets` SET `fx_rate_as_of` = `updated_at` WHERE `fx_rate` IS NOT NULL;
--> statement-breakpoint
-- The backup market sells in the shop currency; a market in another
-- currency derives its prices at its rate.
CREATE TRIGGER `markets_currency_insert_guard`
BEFORE INSERT ON `markets`
WHEN NEW.`currency_code` IS NOT NULL AND (NEW.`is_backup` = 1 OR NEW.`price_mode` <> 'fx')
BEGIN
  SELECT RAISE(ABORT, 'MARKET_CURRENCY_INVALID');
END;
--> statement-breakpoint
CREATE TRIGGER `markets_currency_update_guard`
BEFORE UPDATE OF `currency_code`, `is_backup`, `price_mode` ON `markets`
WHEN NEW.`currency_code` IS NOT NULL AND (NEW.`is_backup` = 1 OR NEW.`price_mode` <> 'fx')
BEGIN
  SELECT RAISE(ABORT, 'MARKET_CURRENCY_INVALID');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `markets_checkout_authority_update`;
--> statement-breakpoint
-- A checkout priced before the backup's price increment, a market's status,
-- its tax inclusion, its pricing, its currency, its rate lock or a country's
-- market changed reviews again.
CREATE TRIGGER `markets_checkout_authority_update`
AFTER UPDATE ON `markets`
WHEN NEW.`price_increment_minor` IS NOT OLD.`price_increment_minor` OR NEW.`status` IS NOT OLD.`status` OR NEW.`prices_include_tax` IS NOT OLD.`prices_include_tax` OR NEW.`price_mode` IS NOT OLD.`price_mode` OR NEW.`fx_rate` IS NOT OLD.`fx_rate` OR NEW.`price_adjustment_bps` IS NOT OLD.`price_adjustment_bps` OR NEW.`price_rounding_minor` IS NOT OLD.`price_rounding_minor` OR NEW.`price_ending_minor` IS NOT OLD.`price_ending_minor` OR NEW.`currency_code` IS NOT OLD.`currency_code` OR NEW.`fx_lock_minutes` IS NOT OLD.`fx_lock_minutes`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `cdep_markets_upd`;
--> statement-breakpoint
CREATE TRIGGER `cdep_markets_upd` AFTER UPDATE ON `markets`
WHEN (OLD.`id` IS NOT NEW.`id` OR OLD.`handle` IS NOT NEW.`handle` OR OLD.`name` IS NOT NEW.`name` OR OLD.`status` IS NOT NEW.`status` OR OLD.`is_backup` IS NOT NEW.`is_backup` OR OLD.`price_increment_minor` IS NOT NEW.`price_increment_minor` OR OLD.`currency_code` IS NOT NEW.`currency_code`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('mk:' || NEW.`id`, 'mk:*', 't:markets')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `customer_order_stats_order_ins`;
--> statement-breakpoint
-- customer_order_stats: what each customer spent, in the shop currency.
CREATE TRIGGER `customer_order_stats_order_ins` AFTER INSERT ON `orders`
WHEN NEW.`customer_id` IS NOT NULL
BEGIN
  INSERT INTO `customer_order_stats` (`customer_id`, `orders_count`, `total_spent_minor`, `first_order_at`, `last_order_at`, `updated_at`) SELECT `customers`.`id`, count(`orders`.`id`), COALESCE(sum(CASE WHEN `orders`.`currency_code` = `orders`.`shop_currency` OR `orders`.`total_amount_minor` <= 0 THEN max(`orders`.`paid_amount_minor`, 0) ELSE CAST(round(max(`orders`.`paid_amount_minor`, 0) * 1.0 * `orders`.`total_shop_minor` / `orders`.`total_amount_minor`) AS INTEGER) END), 0), min(CAST(`orders`.`created_at` AS INTEGER)), max(CAST(`orders`.`created_at` AS INTEGER)), unixepoch() FROM `customers` LEFT JOIN `orders` ON `orders`.`customer_id` = `customers`.`id` AND `orders`.`deleted_at` IS NULL AND `orders`.`status` <> 'incomplete' WHERE `customers`.`id` = NEW.`customer_id` GROUP BY `customers`.`id` ON CONFLICT (`customer_id`) DO UPDATE SET `orders_count` = excluded.`orders_count`, `total_spent_minor` = excluded.`total_spent_minor`, `first_order_at` = excluded.`first_order_at`, `last_order_at` = excluded.`last_order_at`, `updated_at` = excluded.`updated_at`;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `customer_order_stats_order_upd`;
--> statement-breakpoint
CREATE TRIGGER `customer_order_stats_order_upd` AFTER UPDATE ON `orders`
WHEN NEW.`customer_id` IS NOT NULL AND (OLD.`customer_id` IS NOT NEW.`customer_id` OR OLD.`paid_amount_minor` IS NOT NEW.`paid_amount_minor` OR OLD.`deleted_at` IS NOT NEW.`deleted_at` OR OLD.`created_at` IS NOT NEW.`created_at` OR (OLD.`status` IS NOT NEW.`status` AND (OLD.`status` = 'incomplete' OR NEW.`status` = 'incomplete')) OR (NEW.`currency_code` <> NEW.`shop_currency` AND (OLD.`total_shop_minor` IS NOT NEW.`total_shop_minor` OR OLD.`total_amount_minor` IS NOT NEW.`total_amount_minor`)))
BEGIN
  INSERT INTO `customer_order_stats` (`customer_id`, `orders_count`, `total_spent_minor`, `first_order_at`, `last_order_at`, `updated_at`) SELECT `customers`.`id`, count(`orders`.`id`), COALESCE(sum(CASE WHEN `orders`.`currency_code` = `orders`.`shop_currency` OR `orders`.`total_amount_minor` <= 0 THEN max(`orders`.`paid_amount_minor`, 0) ELSE CAST(round(max(`orders`.`paid_amount_minor`, 0) * 1.0 * `orders`.`total_shop_minor` / `orders`.`total_amount_minor`) AS INTEGER) END), 0), min(CAST(`orders`.`created_at` AS INTEGER)), max(CAST(`orders`.`created_at` AS INTEGER)), unixepoch() FROM `customers` LEFT JOIN `orders` ON `orders`.`customer_id` = `customers`.`id` AND `orders`.`deleted_at` IS NULL AND `orders`.`status` <> 'incomplete' WHERE `customers`.`id` = NEW.`customer_id` GROUP BY `customers`.`id` ON CONFLICT (`customer_id`) DO UPDATE SET `orders_count` = excluded.`orders_count`, `total_spent_minor` = excluded.`total_spent_minor`, `first_order_at` = excluded.`first_order_at`, `last_order_at` = excluded.`last_order_at`, `updated_at` = excluded.`updated_at`;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `customer_order_stats_order_upd_old`;
--> statement-breakpoint
CREATE TRIGGER `customer_order_stats_order_upd_old` AFTER UPDATE ON `orders`
WHEN OLD.`customer_id` IS NOT NULL AND OLD.`customer_id` IS NOT NEW.`customer_id`
BEGIN
  INSERT INTO `customer_order_stats` (`customer_id`, `orders_count`, `total_spent_minor`, `first_order_at`, `last_order_at`, `updated_at`) SELECT `customers`.`id`, count(`orders`.`id`), COALESCE(sum(CASE WHEN `orders`.`currency_code` = `orders`.`shop_currency` OR `orders`.`total_amount_minor` <= 0 THEN max(`orders`.`paid_amount_minor`, 0) ELSE CAST(round(max(`orders`.`paid_amount_minor`, 0) * 1.0 * `orders`.`total_shop_minor` / `orders`.`total_amount_minor`) AS INTEGER) END), 0), min(CAST(`orders`.`created_at` AS INTEGER)), max(CAST(`orders`.`created_at` AS INTEGER)), unixepoch() FROM `customers` LEFT JOIN `orders` ON `orders`.`customer_id` = `customers`.`id` AND `orders`.`deleted_at` IS NULL AND `orders`.`status` <> 'incomplete' WHERE `customers`.`id` = OLD.`customer_id` GROUP BY `customers`.`id` ON CONFLICT (`customer_id`) DO UPDATE SET `orders_count` = excluded.`orders_count`, `total_spent_minor` = excluded.`total_spent_minor`, `first_order_at` = excluded.`first_order_at`, `last_order_at` = excluded.`last_order_at`, `updated_at` = excluded.`updated_at`;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `customer_order_stats_order_del`;
--> statement-breakpoint
CREATE TRIGGER `customer_order_stats_order_del` AFTER DELETE ON `orders`
WHEN OLD.`customer_id` IS NOT NULL
BEGIN
  INSERT INTO `customer_order_stats` (`customer_id`, `orders_count`, `total_spent_minor`, `first_order_at`, `last_order_at`, `updated_at`) SELECT `customers`.`id`, count(`orders`.`id`), COALESCE(sum(CASE WHEN `orders`.`currency_code` = `orders`.`shop_currency` OR `orders`.`total_amount_minor` <= 0 THEN max(`orders`.`paid_amount_minor`, 0) ELSE CAST(round(max(`orders`.`paid_amount_minor`, 0) * 1.0 * `orders`.`total_shop_minor` / `orders`.`total_amount_minor`) AS INTEGER) END), 0), min(CAST(`orders`.`created_at` AS INTEGER)), max(CAST(`orders`.`created_at` AS INTEGER)), unixepoch() FROM `customers` LEFT JOIN `orders` ON `orders`.`customer_id` = `customers`.`id` AND `orders`.`deleted_at` IS NULL AND `orders`.`status` <> 'incomplete' WHERE `customers`.`id` = OLD.`customer_id` GROUP BY `customers`.`id` ON CONFLICT (`customer_id`) DO UPDATE SET `orders_count` = excluded.`orders_count`, `total_spent_minor` = excluded.`total_spent_minor`, `first_order_at` = excluded.`first_order_at`, `last_order_at` = excluded.`last_order_at`, `updated_at` = excluded.`updated_at`;
END;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (123, '0123_market_currencies', '6c6cf8a662eef18fd8a097c8dd413acb6a85a681d150d355d08e9b5549770977');
