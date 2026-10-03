-- Markets step 2 (docs/MARKETS-DESIGN.md D4): markets, the countries each
-- market sells to (one market per country) and the URL presences buyers reach
-- it through. Exactly one backup market catches every buyer no other market
-- matches: a partial unique index allows one, triggers refuse deleting it or
-- changing the flag, and only it holds the root presence. This migration
-- creates it from today's store: active, Bangladesh (BD), the root presence in
-- the store's checkout language, and the price increment the currency
-- document held (removed from that document: the backup market is now its one
-- source). orders.market_id records the market an order was placed in (every
-- order writer sets it); every existing order was placed in the backup
-- market. The cache dependency triggers of the three tables are generated
-- from packages/shared/src/cache-deps.ts.
CREATE TABLE `markets` (
	`id` text PRIMARY KEY NOT NULL,
	`handle` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`is_backup` integer DEFAULT false NOT NULL,
	`price_increment_minor` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	CONSTRAINT "markets_name_length" CHECK(length(trim("markets"."name")) BETWEEN 1 AND 60),
	CONSTRAINT "markets_handle_shape" CHECK(length("markets"."handle") BETWEEN 1 AND 60 AND "markets"."handle" = lower("markets"."handle") AND "markets"."handle" NOT GLOB '*[^a-z0-9-]*' AND substr("markets"."handle", 1, 1) <> '-' AND substr("markets"."handle", -1, 1) <> '-'),
	CONSTRAINT "markets_status_check" CHECK("markets"."status" IN ('draft', 'active')),
	CONSTRAINT "markets_backup_flag" CHECK("markets"."is_backup" IN (0, 1)),
	CONSTRAINT "markets_backup_active" CHECK("markets"."is_backup" = 0 OR "markets"."status" = 'active'),
	CONSTRAINT "markets_price_increment" CHECK(("markets"."is_backup" = 1 AND "markets"."price_increment_minor" IS NOT NULL AND "markets"."price_increment_minor" IN (1, 10, 100, 1000)) OR ("markets"."is_backup" = 0 AND "markets"."price_increment_minor" IS NULL)),
	CONSTRAINT "markets_revision_positive" CHECK("markets"."revision" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `markets_handle_unique` ON `markets` (lower(trim("handle")));
--> statement-breakpoint
CREATE UNIQUE INDEX `markets_backup_unique` ON `markets` (`is_backup`) WHERE "markets"."is_backup" = 1;
--> statement-breakpoint
CREATE TABLE `market_countries` (
	`country_code` text PRIMARY KEY NOT NULL,
	`market_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`market_id`) REFERENCES `markets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "market_countries_code_shape" CHECK(length("market_countries"."country_code") = 2 AND "market_countries"."country_code" NOT GLOB '*[^A-Z]*')
);
--> statement-breakpoint
CREATE INDEX `market_countries_market_idx` ON `market_countries` (`market_id`);
--> statement-breakpoint
CREATE TABLE `market_presences` (
	`id` text PRIMARY KEY NOT NULL,
	`market_id` text NOT NULL,
	`kind` text DEFAULT 'subfolder' NOT NULL,
	`value` text NOT NULL,
	`locale` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`market_id`) REFERENCES `markets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "market_presences_kind_check" CHECK("market_presences"."kind" IN ('subfolder', 'domain')),
	CONSTRAINT "market_presences_subfolder_shape" CHECK("market_presences"."kind" <> 'subfolder' OR "market_presences"."value" = '' OR (length("market_presences"."value") = 5 AND "market_presences"."value" GLOB '[a-z][a-z]-[a-z][a-z]' AND substr("market_presences"."value", 1, 2) = "market_presences"."locale")),
	CONSTRAINT "market_presences_locale_shape" CHECK(length("market_presences"."locale") = 2 AND "market_presences"."locale" NOT GLOB '*[^a-z]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `market_presences_value_unique` ON `market_presences` (`kind`,`value`);
--> statement-breakpoint
CREATE INDEX `market_presences_market_idx` ON `market_presences` (`market_id`);
--> statement-breakpoint
ALTER TABLE `orders` ADD `market_id` text REFERENCES markets(id) ON DELETE restrict;
--> statement-breakpoint
CREATE INDEX `orders_market_idx` ON `orders` (`market_id`,`created_at`);
--> statement-breakpoint
-- The backup market catches every buyer no other market matches: never deleted, never demoted.
CREATE TRIGGER `markets_backup_undeletable`
BEFORE DELETE ON `markets`
WHEN OLD.`is_backup` = 1
BEGIN
  SELECT RAISE(ABORT, 'MARKET_BACKUP_REQUIRED');
END;
--> statement-breakpoint
CREATE TRIGGER `markets_backup_flag_immutable`
BEFORE UPDATE OF `is_backup` ON `markets`
WHEN NEW.`is_backup` IS NOT OLD.`is_backup`
BEGIN
  SELECT RAISE(ABORT, 'MARKET_BACKUP_REQUIRED');
END;
--> statement-breakpoint
-- The root URL is the backup market's: no other market may hold the empty subfolder.
CREATE TRIGGER `market_presences_root_backup_only_insert`
BEFORE INSERT ON `market_presences`
WHEN NEW.`kind` = 'subfolder' AND NEW.`value` = '' AND NOT EXISTS (SELECT 1 FROM `markets` WHERE `id` = NEW.`market_id` AND `is_backup` = 1)
BEGIN
  SELECT RAISE(ABORT, 'MARKET_ROOT_PRESENCE_BACKUP_ONLY');
END;
--> statement-breakpoint
CREATE TRIGGER `market_presences_root_backup_only_update`
BEFORE UPDATE OF `kind`, `value`, `market_id` ON `market_presences`
WHEN NEW.`kind` = 'subfolder' AND NEW.`value` = '' AND NOT EXISTS (SELECT 1 FROM `markets` WHERE `id` = NEW.`market_id` AND `is_backup` = 1)
BEGIN
  SELECT RAISE(ABORT, 'MARKET_ROOT_PRESENCE_BACKUP_ONLY');
END;
--> statement-breakpoint
-- The backup market: today's store. Its price increment is the currency
-- document's saved choice when valid for the saved currency, else that
-- currency's default (whole taka for BDT); a missing document or an
-- unsupported code means BDT (priceIncrementOf in step 1).
INSERT INTO `markets` (`id`, `handle`, `name`, `status`, `is_backup`, `price_increment_minor`, `revision`)
SELECT 'mkt_backup', 'bangladesh', 'Bangladesh', 'active', 1, coalesce((
  SELECT CASE
    WHEN `code` NOT IN ('USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'CNY', 'HKD', 'SGD', 'SEK', 'NOK', 'DKK', 'MXN', 'BRL', 'BDT', 'INR', 'PKR', 'LKR', 'NPR', 'AFN', 'BTN', 'MVR', 'MYR', 'PHP', 'THB', 'IDR', 'VND', 'MMK', 'KHR', 'LAK', 'BND', 'KRW', 'TWD', 'MNT', 'KPW', 'MOP', 'AED', 'SAR', 'QAR', 'KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'IRR', 'YER', 'LBP', 'SYP', 'ILS', 'KZT', 'UZS', 'KGS', 'TJS', 'TMT', 'GEL', 'AMD', 'AZN', 'TRY', 'RUB', 'UAH', 'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'HRK', 'RSD', 'BAM', 'MKD', 'ALL', 'MDL', 'BYN', 'ISK', 'ARS', 'CLP', 'COP', 'PEN', 'UYU', 'PYG', 'BOB', 'VES', 'GYD', 'SRD', 'TTD', 'JMD', 'BBD', 'BSD', 'BZD', 'CRC', 'CUP', 'DOP', 'GTQ', 'HNL', 'HTG', 'NIO', 'PAB', 'AWG', 'ANG', 'KYD', 'BMD', 'XCD', 'FKP', 'NGN', 'GHS', 'XOF', 'GMD', 'GNF', 'SLL', 'LRD', 'CVE', 'MRU', 'KES', 'TZS', 'UGX', 'RWF', 'BIF', 'ETB', 'SOS', 'ERN', 'DJF', 'SDG', 'SSP', 'SCR', 'KMF', 'MGA', 'MUR', 'XAF', 'CDF', 'ZAR', 'BWP', 'LSL', 'SZL', 'NAD', 'MWK', 'ZMW', 'MZN', 'AOA', 'ZWL', 'EGP', 'DZD', 'MAD', 'TND', 'LYD', 'STN', 'FJD', 'PGK', 'WST', 'TOP', 'VUV', 'SBD', 'XPF', 'XDR', 'XAG', 'XAU') THEN 100
    WHEN `saved` = '1' THEN 1
    WHEN `saved` = '1000' AND `code` IN ('KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') THEN 1000
    WHEN `saved` = '100' AND `code` NOT IN ('JPY', 'VND', 'KRW', 'ISK', 'CLP', 'PYG', 'XOF', 'GNF', 'UGX', 'RWF', 'BIF', 'DJF', 'KMF', 'XAF', 'VUV', 'XPF', 'KWD', 'BHD', 'OMR', 'JOD', 'IQD', 'TND', 'LYD') THEN 100
    WHEN `code` = 'BDT' THEN 100
    ELSE 1
  END
  FROM (
    SELECT
      upper(trim(coalesce(CASE WHEN json_valid(`value`) THEN json_extract(`value`, '$.currencyCode') END, ''))) AS `code`,
      CASE WHEN json_valid(`value`) AND json_type(`value`, '$.priceIncrementMinor') = 'integer'
        THEN CAST(json_extract(`value`, '$.priceIncrementMinor') AS TEXT) END AS `saved`
    FROM `settings`
    WHERE `category` = 'currency' AND `key` = 'document'
  ) AS `currency_document`
), 100), 1;
--> statement-breakpoint
INSERT INTO `market_countries` (`country_code`, `market_id`) VALUES ('BD', 'mkt_backup');
--> statement-breakpoint
-- The root presence, in the store's checkout language (English when none is active).
INSERT INTO `market_presences` (`id`, `market_id`, `kind`, `value`, `locale`)
SELECT 'mkp_backup_root', 'mkt_backup', 'subfolder', '', coalesce((
  SELECT lower(substr(`code`, 1, 2)) FROM `checkout_languages`
  WHERE `is_active` = 1 AND `deleted_at` IS NULL AND length(`code`) >= 2 AND lower(substr(`code`, 1, 2)) NOT GLOB '*[^a-z]*'
  ORDER BY `is_default` DESC, `id` LIMIT 1
), 'en');
--> statement-breakpoint
-- The backup market is the increment's one source now.
UPDATE `settings` SET `value` = json_remove(`value`, '$.priceIncrementMinor')
WHERE `category` = 'currency' AND `key` = 'document' AND json_valid(`value`) AND json_type(`value`, '$.priceIncrementMinor') IS NOT NULL;
--> statement-breakpoint
-- Every existing order was placed in the backup market.
UPDATE `orders` SET `market_id` = 'mkt_backup' WHERE `market_id` IS NULL;
--> statement-breakpoint
-- A checkout priced before the backup's price increment, a market's status or a
-- country's market changed reviews again instead of committing.
CREATE TRIGGER `markets_checkout_authority_update`
AFTER UPDATE ON `markets`
WHEN NEW.`price_increment_minor` IS NOT OLD.`price_increment_minor` OR NEW.`status` IS NOT OLD.`status`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `market_countries_checkout_authority_insert`
AFTER INSERT ON `market_countries`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `market_countries_checkout_authority_update`
AFTER UPDATE ON `market_countries`
WHEN NEW.`market_id` IS NOT OLD.`market_id` OR NEW.`country_code` IS NOT OLD.`country_code`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `market_countries_checkout_authority_delete`
AFTER DELETE ON `market_countries`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_markets_ins` AFTER INSERT ON `markets`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('mk:' || NEW.`id`, 'mk:*', 't:markets')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_markets_del` AFTER DELETE ON `markets`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('mk:' || OLD.`id`, 'mk:*', 't:markets')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_markets_upd` AFTER UPDATE ON `markets`
WHEN (OLD.`id` IS NOT NEW.`id` OR OLD.`handle` IS NOT NEW.`handle` OR OLD.`name` IS NOT NEW.`name` OR OLD.`status` IS NOT NEW.`status` OR OLD.`is_backup` IS NOT NEW.`is_backup` OR OLD.`price_increment_minor` IS NOT NEW.`price_increment_minor`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('mk:' || NEW.`id`, 'mk:*', 't:markets')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_markets_upd_old` AFTER UPDATE ON `markets`
WHEN (OLD.`id` IS NOT NEW.`id`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('mk:' || OLD.`id`, 'mk:*', 't:markets')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_markets_backup_price` AFTER UPDATE ON `markets`
WHEN (OLD.`price_increment_minor` IS NOT NEW.`price_increment_minor`)
  AND NEW.`is_backup` = 1
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('mk:backup', 't:markets')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_markets_backup_price_old` AFTER UPDATE ON `markets`
WHEN (OLD.`price_increment_minor` IS NOT NEW.`price_increment_minor`)
  AND (OLD.`is_backup` IS NOT NEW.`is_backup`)
  AND OLD.`is_backup` = 1
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('mk:backup', 't:markets')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_market_countries_ins` AFTER INSERT ON `market_countries`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('mk:' || NEW.`market_id`, 'mk:*', 't:market_countries')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_market_countries_del` AFTER DELETE ON `market_countries`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('mk:' || OLD.`market_id`, 'mk:*', 't:market_countries')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_market_countries_upd` AFTER UPDATE ON `market_countries`
WHEN (OLD.`country_code` IS NOT NEW.`country_code` OR OLD.`market_id` IS NOT NEW.`market_id`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('mk:' || NEW.`market_id`, 'mk:*', 't:market_countries')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_market_countries_upd_old` AFTER UPDATE ON `market_countries`
WHEN (OLD.`market_id` IS NOT NEW.`market_id`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('mk:' || OLD.`market_id`, 'mk:*', 't:market_countries')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_market_presences_ins` AFTER INSERT ON `market_presences`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('mk:' || NEW.`market_id`, 'mk:*', 't:market_presences')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_market_presences_del` AFTER DELETE ON `market_presences`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('mk:' || OLD.`market_id`, 'mk:*', 't:market_presences')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_market_presences_upd` AFTER UPDATE ON `market_presences`
WHEN (OLD.`id` IS NOT NEW.`id` OR OLD.`market_id` IS NOT NEW.`market_id` OR OLD.`kind` IS NOT NEW.`kind` OR OLD.`value` IS NOT NEW.`value` OR OLD.`locale` IS NOT NEW.`locale`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('mk:' || NEW.`market_id`, 'mk:*', 't:market_presences')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_market_presences_upd_old` AFTER UPDATE ON `market_presences`
WHEN (OLD.`market_id` IS NOT NEW.`market_id`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('mk:' || OLD.`market_id`, 'mk:*', 't:market_presences')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (112, '0112_markets', 'b558d17ad0707700f956c46aa7c892760df786f7dddd34b781ef7b56ae2b13e8');
