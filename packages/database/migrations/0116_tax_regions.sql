-- Markets step 3c (docs/MARKETS-DESIGN.md "Step 3c implemented"): tax
-- regions, the tax provider and prices_include_tax per market.
--
-- tax_regions: where the merchant collects tax. A country region is the
-- registration; a sub-region (an admin area, a postal prefix or a Bangladesh
-- City/Thana/Area place) needs its country's region. An address with no
-- region of its country pays no tax (Stripe Tax's rule). The most specific
-- region with rates of a line's class applies; a combinable rate also brings
-- the broader regions' rates (tax/region-match.ts). A country region may
-- name a tax provider (an app); otherwise the store-wide one decides
-- (tax_settings.provider_id, the built-in system provider by default).
--
-- Today's rates become Bangladesh regions: a store-wide rate is a rate of
-- the region BD, a City/Thana/Area rate a rate of that place's region,
-- combinable, so the same rates stack for the same addresses as before.
-- tax_rates is rebuilt without its jurisdiction columns; soft-deleted rates
-- (referenced by nothing; orders keep their own copy) are not carried over.
--
-- prices_include_tax moves from tax_settings to every market (all of them
-- carry today's value); checkout and the order's tax snapshot read the
-- order's market. Order tax snapshots keep the jurisdiction (country and
-- region) and the provider. Region and rate writes, and a market's flag,
-- fence priced checkouts; the cache dependency triggers are generated from
-- packages/shared/src/cache-deps.ts.
CREATE TABLE `tax_regions` (
	`id` text PRIMARY KEY NOT NULL,
	`country_code` text NOT NULL,
	`admin_area` text DEFAULT '' NOT NULL,
	`postal_prefix` text DEFAULT '' NOT NULL,
	`place_type` text,
	`place_id` text,
	`provider_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	CONSTRAINT "tax_regions_country_shape" CHECK(length("tax_regions"."country_code") = 2 AND "tax_regions"."country_code" NOT GLOB '*[^A-Z]*'),
	CONSTRAINT "tax_regions_admin_area_shape" CHECK(length("tax_regions"."admin_area") <= 120 AND "tax_regions"."admin_area" = trim("tax_regions"."admin_area")),
	CONSTRAINT "tax_regions_postal_prefix_shape" CHECK(length("tax_regions"."postal_prefix") <= 10 AND "tax_regions"."postal_prefix" NOT GLOB '*[^A-Z0-9]*'),
	CONSTRAINT "tax_regions_one_kind" CHECK(("tax_regions"."admin_area" = '' OR "tax_regions"."postal_prefix" = '') AND ("tax_regions"."place_id" IS NULL OR ("tax_regions"."admin_area" = '' AND "tax_regions"."postal_prefix" = '' AND "tax_regions"."country_code" = 'BD'))),
	CONSTRAINT "tax_regions_place_shape" CHECK(("tax_regions"."place_type" IS NULL AND "tax_regions"."place_id" IS NULL) OR ("tax_regions"."place_type" IN ('city', 'zone', 'area') AND "tax_regions"."place_id" IS NOT NULL AND length("tax_regions"."place_id") BETWEEN 1 AND 180)),
	CONSTRAINT "tax_regions_provider_country_only" CHECK("tax_regions"."provider_id" IS NULL OR ("tax_regions"."admin_area" = '' AND "tax_regions"."postal_prefix" = '' AND "tax_regions"."place_id" IS NULL AND ("tax_regions"."provider_id" = 'system' OR (length("tax_regions"."provider_id") BETWEEN 3 AND 120 AND "tax_regions"."provider_id" LIKE '_%:_%')))),
	CONSTRAINT "tax_regions_version_positive" CHECK("tax_regions"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tax_regions_scope_unique` ON `tax_regions` (`country_code`,`admin_area`,`postal_prefix`,coalesce(`place_id`, ''));
--> statement-breakpoint
-- A sub-region needs its country's region; a region's scope never changes
-- (another scope is another region); a country region with sub-regions
-- cannot be deleted before them.
CREATE TRIGGER `tax_regions_country_required`
BEFORE INSERT ON `tax_regions`
WHEN (NEW.`admin_area` <> '' OR NEW.`postal_prefix` <> '' OR NEW.`place_id` IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM `tax_regions` AS `country_region` WHERE `country_region`.`country_code` = NEW.`country_code` AND `country_region`.`admin_area` = '' AND `country_region`.`postal_prefix` = '' AND `country_region`.`place_id` IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'TAX_REGION_COUNTRY_REQUIRED');
END;
--> statement-breakpoint
CREATE TRIGGER `tax_regions_scope_immutable`
BEFORE UPDATE OF `country_code`, `admin_area`, `postal_prefix`, `place_type`, `place_id` ON `tax_regions`
WHEN NEW.`country_code` IS NOT OLD.`country_code` OR NEW.`admin_area` IS NOT OLD.`admin_area` OR NEW.`postal_prefix` IS NOT OLD.`postal_prefix` OR NEW.`place_type` IS NOT OLD.`place_type` OR NEW.`place_id` IS NOT OLD.`place_id`
BEGIN
  SELECT RAISE(ABORT, 'TAX_REGION_SCOPE_IMMUTABLE');
END;
--> statement-breakpoint
CREATE TRIGGER `tax_regions_country_delete_guard`
BEFORE DELETE ON `tax_regions`
WHEN OLD.`admin_area` = '' AND OLD.`postal_prefix` = '' AND OLD.`place_id` IS NULL AND EXISTS (SELECT 1 FROM `tax_regions` AS `sub_region` WHERE `sub_region`.`country_code` = OLD.`country_code` AND (`sub_region`.`admin_area` <> '' OR `sub_region`.`postal_prefix` <> '' OR `sub_region`.`place_id` IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'TAX_REGION_HAS_SUBREGIONS');
END;
--> statement-breakpoint
-- Today's rates are Bangladesh rates: the region BD, and one region per
-- City/Thana/Area a live rate names.
INSERT INTO `tax_regions` (`id`, `country_code`)
SELECT 'txreg_bd', 'BD' WHERE EXISTS (SELECT 1 FROM `tax_rates` WHERE `deleted_at` IS NULL);
--> statement-breakpoint
INSERT INTO `tax_regions` (`id`, `country_code`, `place_type`, `place_id`)
SELECT 'txreg_bd_' || `jurisdiction_id`, 'BD', min(`jurisdiction_type`), `jurisdiction_id`
FROM `tax_rates`
WHERE `deleted_at` IS NULL AND `jurisdiction_type` IN ('city', 'zone', 'area')
GROUP BY `jurisdiction_id`;
--> statement-breakpoint
CREATE TABLE `__new_tax_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`tax_class_id` text NOT NULL,
	`tax_region_id` text NOT NULL,
	`name` text NOT NULL,
	`rate_bps` integer NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`is_compound` integer DEFAULT false NOT NULL,
	`combinable` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`tax_class_id`) REFERENCES `tax_classes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`tax_region_id`) REFERENCES `tax_regions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "tax_rates_rate_bps_range" CHECK("rate_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "tax_rates_name_length" CHECK(length("name") BETWEEN 1 AND 120),
	CONSTRAINT "tax_rates_priority_range" CHECK("priority" BETWEEN 0 AND 1000),
	CONSTRAINT "tax_rates_version_positive" CHECK("version" >= 1)
);
--> statement-breakpoint
-- A store-wide rate stays alone in the region BD; a place's rate combines
-- with the broader regions' rates, as every matching rate stacked before.
INSERT INTO `__new_tax_rates` (`id`, `tax_class_id`, `tax_region_id`, `name`, `rate_bps`, `priority`, `is_compound`, `combinable`, `is_active`, `version`, `created_at`, `updated_at`)
SELECT `id`, `tax_class_id`, 'txreg_bd', `name`, `rate_bps`, `priority`, `is_compound`, 0, `is_active`, `version`, `created_at`, `updated_at`
FROM `tax_rates` WHERE `deleted_at` IS NULL AND `jurisdiction_type` = 'all';
--> statement-breakpoint
INSERT INTO `__new_tax_rates` (`id`, `tax_class_id`, `tax_region_id`, `name`, `rate_bps`, `priority`, `is_compound`, `combinable`, `is_active`, `version`, `created_at`, `updated_at`)
SELECT `id`, `tax_class_id`, 'txreg_bd_' || `jurisdiction_id`, `name`, `rate_bps`, `priority`, `is_compound`, 1, `is_active`, `version`, `created_at`, `updated_at`
FROM `tax_rates` WHERE `deleted_at` IS NULL AND `jurisdiction_type` IN ('city', 'zone', 'area');
--> statement-breakpoint
DROP TABLE `tax_rates`;
--> statement-breakpoint
ALTER TABLE `__new_tax_rates` RENAME TO `tax_rates`;
--> statement-breakpoint
CREATE INDEX `tax_rates_class_active_priority_idx` ON `tax_rates` (`tax_class_id`,`is_active`,`priority`);
--> statement-breakpoint
CREATE INDEX `tax_rates_region_idx` ON `tax_rates` (`tax_region_id`);
--> statement-breakpoint
-- The rebuilt table's triggers: the checkout fence (as 0048) and the
-- generated cache dependency triggers.
CREATE TRIGGER `tax_rates_checkout_authority_insert`
AFTER INSERT ON `tax_rates`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `tax_rates_checkout_authority_update`
AFTER UPDATE ON `tax_rates`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `tax_rates_checkout_authority_delete`
AFTER DELETE ON `tax_rates`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_tax_rates_ins` AFTER INSERT ON `tax_rates`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('tax', 't:tax_rates')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_tax_rates_del` AFTER DELETE ON `tax_rates`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('tax', 't:tax_rates')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_tax_rates_upd` AFTER UPDATE ON `tax_rates`
WHEN (OLD.`id` IS NOT NEW.`id` OR OLD.`tax_class_id` IS NOT NEW.`tax_class_id` OR OLD.`tax_region_id` IS NOT NEW.`tax_region_id` OR OLD.`name` IS NOT NEW.`name` OR OLD.`rate_bps` IS NOT NEW.`rate_bps` OR OLD.`priority` IS NOT NEW.`priority` OR OLD.`is_compound` IS NOT NEW.`is_compound` OR OLD.`combinable` IS NOT NEW.`combinable` OR OLD.`is_active` IS NOT NEW.`is_active` OR OLD.`created_at` IS NOT NEW.`created_at`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('tax', 't:tax_rates')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
-- A region decides which rates and which provider apply: every change fences
-- priced checkouts.
CREATE TRIGGER `tax_regions_checkout_authority_insert`
AFTER INSERT ON `tax_regions`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `tax_regions_checkout_authority_update`
AFTER UPDATE ON `tax_regions`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `tax_regions_checkout_authority_delete`
AFTER DELETE ON `tax_regions`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_tax_regions_ins` AFTER INSERT ON `tax_regions`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('tax', 't:tax_regions')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_tax_regions_del` AFTER DELETE ON `tax_regions`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('tax', 't:tax_regions')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_tax_regions_upd` AFTER UPDATE ON `tax_regions`
WHEN (OLD.`id` IS NOT NEW.`id` OR OLD.`country_code` IS NOT NEW.`country_code` OR OLD.`admin_area` IS NOT NEW.`admin_area` OR OLD.`postal_prefix` IS NOT NEW.`postal_prefix` OR OLD.`place_type` IS NOT NEW.`place_type` OR OLD.`place_id` IS NOT NEW.`place_id` OR OLD.`provider_id` IS NOT NEW.`provider_id`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('tax', 't:tax_regions')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
-- Every market carries today's store-wide flag; it then leaves tax_settings.
ALTER TABLE `markets` ADD `prices_include_tax` integer DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE `markets` SET `prices_include_tax` = coalesce((SELECT `prices_include_tax` FROM `tax_settings` WHERE `id` = 'default'), 0);
--> statement-breakpoint
DROP TRIGGER IF EXISTS `markets_checkout_authority_update`;
--> statement-breakpoint
-- A checkout priced before the backup's price increment, a market's status,
-- its tax inclusion or a country's market changed reviews again.
CREATE TRIGGER `markets_checkout_authority_update`
AFTER UPDATE ON `markets`
WHEN NEW.`price_increment_minor` IS NOT OLD.`price_increment_minor` OR NEW.`status` IS NOT OLD.`status` OR NEW.`prices_include_tax` IS NOT OLD.`prices_include_tax`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `cdep_tax_settings_upd`;
--> statement-breakpoint
ALTER TABLE `tax_settings` DROP COLUMN `prices_include_tax`;
--> statement-breakpoint
ALTER TABLE `tax_settings` ADD `provider_id` text DEFAULT 'system' NOT NULL CONSTRAINT `tax_settings_provider_shape` CHECK (`provider_id` = 'system' OR (length(`provider_id`) BETWEEN 3 AND 120 AND `provider_id` LIKE '_%:_%'));
--> statement-breakpoint
CREATE TRIGGER `cdep_tax_settings_upd` AFTER UPDATE ON `tax_settings`
WHEN (OLD.`id` IS NOT NEW.`id` OR OLD.`enabled` IS NOT NEW.`enabled` OR OLD.`tax_shipping` IS NOT NEW.`tax_shipping` OR OLD.`default_tax_class_id` IS NOT NEW.`default_tax_class_id` OR OLD.`shipping_tax_class_id` IS NOT NEW.`shipping_tax_class_id` OR OLD.`display_label` IS NOT NEW.`display_label` OR OLD.`provider_id` IS NOT NEW.`provider_id` OR OLD.`created_at` IS NOT NEW.`created_at`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('tax', 't:tax_settings')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
-- Order tax snapshots keep the jurisdiction and the provider; lines placed
-- before this migration have no recorded jurisdiction.
ALTER TABLE `order_item_tax_snapshots` ADD `country_code` text;
--> statement-breakpoint
ALTER TABLE `order_item_tax_snapshots` ADD `tax_region_id` text;
--> statement-breakpoint
ALTER TABLE `order_item_tax_snapshots` ADD `provider_id` text DEFAULT 'system' NOT NULL;
--> statement-breakpoint
ALTER TABLE `order_tax_snapshots` ADD `provider_id` text DEFAULT 'system' NOT NULL;
--> statement-breakpoint
ALTER TABLE `order_tax_snapshots` ADD `provider_calculation_id` text;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (116, '0116_tax_regions', '53d7b81d453e5b766329f75c5ad260282fb3b1e2aabd2295904112ea0e887410');
