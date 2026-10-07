-- Markets step 4a (docs/MARKETS-DESIGN.md D5, "Step 4a implemented"): price
-- lists and FX-derived market prices.
--
-- price_lists: fixed prices for a market (`market`), for the members of one
-- customer segment in a market (`segment`) or a scheduled sale (`sale`), with
-- a status, a schedule, a priority and a revision. price_list_prices: one
-- price of a SKU in a list per currency and quantity break (`min_quantity`),
-- with an optional compare-at. Market and sale lists price a non-backup
-- market (PRICE_LIST_BACKUP_MARKET): the backup market sells at base prices,
-- so the root catalogue never varies. Segment lists may price any market.
--
-- markets gain how they price: price_mode `fixed` (base and list prices) or
-- `fx` (base prices converted at fx_rate, adjusted by price_adjustment_bps,
-- rounded up to price_rounding_minor and ending in price_ending_minor). The
-- backup market is always `fixed`. Nothing is backfilled: every market stays
-- `fixed` with no list, so every price is today's.
--
-- Every write that can change a checkout price (an active list, its prices, a
-- market's pricing) advances the checkout authority fence. The cache
-- dependency triggers are generated from packages/shared/src/cache-deps.ts.
CREATE TABLE `price_lists` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`kind` text NOT NULL,
	`market_id` text NOT NULL,
	`segment_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`starts_at` integer,
	`ends_at` integer,
	`priority` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`market_id`) REFERENCES `markets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`segment_id`) REFERENCES `customer_segments`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "price_lists_id_shape" CHECK(substr("price_lists"."id", 1, 3) = 'pl_' AND length("price_lists"."id") BETWEEN 6 AND 40),
	CONSTRAINT "price_lists_name_length" CHECK("price_lists"."name" = trim("price_lists"."name") AND length("price_lists"."name") BETWEEN 1 AND 80),
	CONSTRAINT "price_lists_description_length" CHECK("price_lists"."description" IS NULL OR length("price_lists"."description") BETWEEN 1 AND 300),
	CONSTRAINT "price_lists_kind_check" CHECK("price_lists"."kind" IN ('market', 'segment', 'sale')),
	CONSTRAINT "price_lists_status_check" CHECK("price_lists"."status" IN ('draft', 'active')),
	CONSTRAINT "price_lists_segment_kind" CHECK(("price_lists"."kind" = 'segment') = ("price_lists"."segment_id" IS NOT NULL)),
	CONSTRAINT "price_lists_schedule" CHECK("price_lists"."starts_at" IS NULL OR "price_lists"."ends_at" IS NULL OR "price_lists"."ends_at" > "price_lists"."starts_at"),
	CONSTRAINT "price_lists_priority_range" CHECK("price_lists"."priority" BETWEEN 0 AND 1000),
	CONSTRAINT "price_lists_revision_positive" CHECK("price_lists"."revision" >= 1)
);
--> statement-breakpoint
CREATE INDEX `price_lists_market_status_idx` ON `price_lists` (`market_id`,`status`);
--> statement-breakpoint
CREATE INDEX `price_lists_segment_idx` ON `price_lists` (`segment_id`);
--> statement-breakpoint
CREATE TABLE `price_list_prices` (
	`price_list_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`currency_code` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`compare_at_minor` integer,
	`min_quantity` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	PRIMARY KEY(`price_list_id`, `variant_id`, `currency_code`, `min_quantity`),
	FOREIGN KEY (`price_list_id`) REFERENCES `price_lists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "price_list_prices_currency_shape" CHECK(length("price_list_prices"."currency_code") = 3 AND "price_list_prices"."currency_code" NOT GLOB '*[^A-Z]*'),
	CONSTRAINT "price_list_prices_amount_positive" CHECK("price_list_prices"."amount_minor" > 0),
	CONSTRAINT "price_list_prices_compare_at" CHECK("price_list_prices"."compare_at_minor" IS NULL OR "price_list_prices"."compare_at_minor" > "price_list_prices"."amount_minor"),
	CONSTRAINT "price_list_prices_min_quantity" CHECK("price_list_prices"."min_quantity" BETWEEN 1 AND 10000)
);
--> statement-breakpoint
CREATE INDEX `price_list_prices_variant_idx` ON `price_list_prices` (`variant_id`);
--> statement-breakpoint
-- How each market prices; every market starts `fixed` (today's prices).
ALTER TABLE `markets` ADD `price_mode` text DEFAULT 'fixed' NOT NULL CONSTRAINT `markets_price_mode_check` CHECK (`price_mode` IN ('fixed', 'fx') AND (`is_backup` = 0 OR `price_mode` = 'fixed'));
--> statement-breakpoint
ALTER TABLE `markets` ADD `fx_rate` text CONSTRAINT `markets_fx_rate_shape` CHECK (`fx_rate` IS NULL OR (length(`fx_rate`) BETWEEN 1 AND 25 AND `fx_rate` GLOB '[0-9]*' AND `fx_rate` NOT GLOB '*[^0-9.]*'));
--> statement-breakpoint
ALTER TABLE `markets` ADD `price_adjustment_bps` integer DEFAULT 0 NOT NULL CONSTRAINT `markets_price_adjustment_range` CHECK (`price_adjustment_bps` BETWEEN -9900 AND 100000);
--> statement-breakpoint
ALTER TABLE `markets` ADD `price_rounding_minor` integer CONSTRAINT `markets_price_rounding` CHECK (`price_rounding_minor` IS NULL OR `price_rounding_minor` BETWEEN 1 AND 100000000);
--> statement-breakpoint
ALTER TABLE `markets` ADD `price_ending_minor` integer CONSTRAINT `markets_price_ending` CHECK (`price_ending_minor` IS NULL OR (`price_rounding_minor` IS NOT NULL AND `price_ending_minor` > 0 AND `price_ending_minor` < `price_rounding_minor`));
--> statement-breakpoint
-- Market and sale lists price a non-backup market: the backup market sells
-- at base prices (segment lists may price any market).
CREATE TRIGGER `price_lists_backup_market_insert`
BEFORE INSERT ON `price_lists`
WHEN NEW.`kind` <> 'segment' AND EXISTS (SELECT 1 FROM `markets` WHERE `markets`.`id` = NEW.`market_id` AND `markets`.`is_backup` = 1)
BEGIN
  SELECT RAISE(ABORT, 'PRICE_LIST_BACKUP_MARKET');
END;
--> statement-breakpoint
CREATE TRIGGER `price_lists_backup_market_update`
BEFORE UPDATE OF `kind`, `market_id` ON `price_lists`
WHEN NEW.`kind` <> 'segment' AND EXISTS (SELECT 1 FROM `markets` WHERE `markets`.`id` = NEW.`market_id` AND `markets`.`is_backup` = 1)
BEGIN
  SELECT RAISE(ABORT, 'PRICE_LIST_BACKUP_MARKET');
END;
--> statement-breakpoint
-- A checkout priced before an active list, its prices or a market's pricing
-- changed reviews again instead of committing.
CREATE TRIGGER `price_lists_checkout_authority_insert`
AFTER INSERT ON `price_lists`
WHEN NEW.`status` = 'active'
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `price_lists_checkout_authority_update`
AFTER UPDATE ON `price_lists`
WHEN (OLD.`status` = 'active' OR NEW.`status` = 'active') AND (NEW.`status` IS NOT OLD.`status` OR NEW.`kind` IS NOT OLD.`kind` OR NEW.`market_id` IS NOT OLD.`market_id` OR NEW.`segment_id` IS NOT OLD.`segment_id` OR NEW.`starts_at` IS NOT OLD.`starts_at` OR NEW.`ends_at` IS NOT OLD.`ends_at` OR NEW.`priority` IS NOT OLD.`priority`)
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `price_lists_checkout_authority_delete`
AFTER DELETE ON `price_lists`
WHEN OLD.`status` = 'active'
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `price_list_prices_checkout_authority_insert`
AFTER INSERT ON `price_list_prices`
WHEN EXISTS (SELECT 1 FROM `price_lists` WHERE `price_lists`.`id` = NEW.`price_list_id` AND `price_lists`.`status` = 'active')
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `price_list_prices_checkout_authority_update`
AFTER UPDATE ON `price_list_prices`
WHEN EXISTS (SELECT 1 FROM `price_lists` WHERE `price_lists`.`id` IN (NEW.`price_list_id`, OLD.`price_list_id`) AND `price_lists`.`status` = 'active')
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `price_list_prices_checkout_authority_delete`
AFTER DELETE ON `price_list_prices`
WHEN EXISTS (SELECT 1 FROM `price_lists` WHERE `price_lists`.`id` = OLD.`price_list_id` AND `price_lists`.`status` = 'active')
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `markets_checkout_authority_update`;
--> statement-breakpoint
-- A checkout priced before the backup's price increment, a market's status,
-- its tax inclusion, its pricing or a country's market changed reviews again.
CREATE TRIGGER `markets_checkout_authority_update`
AFTER UPDATE ON `markets`
WHEN NEW.`price_increment_minor` IS NOT OLD.`price_increment_minor` OR NEW.`status` IS NOT OLD.`status` OR NEW.`prices_include_tax` IS NOT OLD.`prices_include_tax` OR NEW.`price_mode` IS NOT OLD.`price_mode` OR NEW.`fx_rate` IS NOT OLD.`fx_rate` OR NEW.`price_adjustment_bps` IS NOT OLD.`price_adjustment_bps` OR NEW.`price_rounding_minor` IS NOT OLD.`price_rounding_minor` OR NEW.`price_ending_minor` IS NOT OLD.`price_ending_minor`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_markets_pricing` AFTER UPDATE ON `markets`
WHEN (OLD.`price_mode` IS NOT NEW.`price_mode` OR OLD.`fx_rate` IS NOT NEW.`fx_rate` OR OLD.`price_adjustment_bps` IS NOT NEW.`price_adjustment_bps` OR OLD.`price_rounding_minor` IS NOT NEW.`price_rounding_minor` OR OLD.`price_ending_minor` IS NOT NEW.`price_ending_minor`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('pl:' || NEW.`id`, 't:markets')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_markets_pricing_old` AFTER UPDATE ON `markets`
WHEN (OLD.`price_mode` IS NOT NEW.`price_mode` OR OLD.`fx_rate` IS NOT NEW.`fx_rate` OR OLD.`price_adjustment_bps` IS NOT NEW.`price_adjustment_bps` OR OLD.`price_rounding_minor` IS NOT NEW.`price_rounding_minor` OR OLD.`price_ending_minor` IS NOT NEW.`price_ending_minor`)
  AND (OLD.`id` IS NOT NEW.`id`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('pl:' || OLD.`id`, 't:markets')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_price_lists_ins` AFTER INSERT ON `price_lists`
WHEN EXISTS (SELECT 1 WHERE NEW.kind <> 'segment' AND NEW.status = 'active')
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('pl:' || NEW.`market_id`, 't:price_lists')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_price_lists_del` AFTER DELETE ON `price_lists`
WHEN EXISTS (SELECT 1 WHERE OLD.kind <> 'segment' AND OLD.status = 'active')
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('pl:' || OLD.`market_id`, 't:price_lists')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_price_lists_upd` AFTER UPDATE ON `price_lists`
WHEN (OLD.`id` IS NOT NEW.`id` OR OLD.`kind` IS NOT NEW.`kind` OR OLD.`market_id` IS NOT NEW.`market_id` OR OLD.`segment_id` IS NOT NEW.`segment_id` OR OLD.`status` IS NOT NEW.`status` OR OLD.`starts_at` IS NOT NEW.`starts_at` OR OLD.`ends_at` IS NOT NEW.`ends_at` OR OLD.`priority` IS NOT NEW.`priority`)
  AND EXISTS (SELECT 1 WHERE NEW.kind <> 'segment' AND NEW.status = 'active')
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('pl:' || NEW.`market_id`, 't:price_lists')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_price_lists_upd_old` AFTER UPDATE ON `price_lists`
WHEN (OLD.`market_id` IS NOT NEW.`market_id` OR OLD.`kind` IS NOT NEW.`kind` OR OLD.`status` IS NOT NEW.`status`)
  AND EXISTS (SELECT 1 WHERE OLD.kind <> 'segment' AND OLD.status = 'active')
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('pl:' || OLD.`market_id`, 't:price_lists')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_price_list_prices_ins` AFTER INSERT ON `price_list_prices`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('t:price_list_prices')) AS key_list UNION SELECT 'pl:' || key_ref_0.ref FROM (SELECT price_list.market_id || ':' || price_sku.product_id AS ref FROM price_lists AS price_list, product_variants AS price_sku WHERE price_list.id = NEW.price_list_id AND price_sku.id = NEW.variant_id AND price_list.kind <> 'segment' AND price_list.status = 'active') AS key_ref_0) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_price_list_prices_del` AFTER DELETE ON `price_list_prices`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('t:price_list_prices')) AS key_list UNION SELECT 'pl:' || key_ref_0.ref FROM (SELECT price_list.market_id || ':' || price_sku.product_id AS ref FROM price_lists AS price_list, product_variants AS price_sku WHERE price_list.id = OLD.price_list_id AND price_sku.id = OLD.variant_id AND price_list.kind <> 'segment' AND price_list.status = 'active') AS key_ref_0) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_price_list_prices_upd` AFTER UPDATE ON `price_list_prices`
WHEN (OLD.`price_list_id` IS NOT NEW.`price_list_id` OR OLD.`variant_id` IS NOT NEW.`variant_id` OR OLD.`currency_code` IS NOT NEW.`currency_code` OR OLD.`amount_minor` IS NOT NEW.`amount_minor` OR OLD.`compare_at_minor` IS NOT NEW.`compare_at_minor` OR OLD.`min_quantity` IS NOT NEW.`min_quantity`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('t:price_list_prices')) AS key_list UNION SELECT 'pl:' || key_ref_0.ref FROM (SELECT price_list.market_id || ':' || price_sku.product_id AS ref FROM price_lists AS price_list, product_variants AS price_sku WHERE price_list.id = NEW.price_list_id AND price_sku.id = NEW.variant_id AND price_list.kind <> 'segment' AND price_list.status = 'active') AS key_ref_0) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_price_list_prices_upd_old` AFTER UPDATE ON `price_list_prices`
WHEN (OLD.`price_list_id` IS NOT NEW.`price_list_id` OR OLD.`variant_id` IS NOT NEW.`variant_id`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('t:price_list_prices')) AS key_list UNION SELECT 'pl:' || key_ref_0.ref FROM (SELECT price_list.market_id || ':' || price_sku.product_id AS ref FROM price_lists AS price_list, product_variants AS price_sku WHERE price_list.id = OLD.price_list_id AND price_sku.id = OLD.variant_id AND price_list.kind <> 'segment' AND price_list.status = 'active') AS key_ref_0) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (120, '0120_price_lists', '79cc8a68ea53ea7d0bf32662d98755c46384e1d1e1ea8018d405c325967c3ae4');
