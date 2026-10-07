-- The place directory (docs/PLACES.md): delivery_locations, a Bangladesh-only
-- City/Thana/Area tree, becomes places, one tree of numbered levels for any
-- country. Every row keeps its id, so zones, tax regions, customer and order
-- addresses (city/zone/area ids) and courier mappings still point at it.
--
-- - country_code is BD for every row; level comes from type (city 1, thana
--   2, area 3). Bangladesh names its levels City, Thana and Area
--   (@scalius/shared/places).
-- - source, source_key, source_version and source_active belong to dataset
--   imports (delivery/places-import.ts); rows carried over have none.
-- - A parent is one level up in the same country (a trigger refuses another
--   parent). Active names stay unique among a country's top places and among
--   a place's children of one level, as before.
-- - delivery_zone_locations is rebuilt to reference places (SQLite keeps a
--   foreign key's table name); its rows, triggers and index are unchanged.
-- - Checkout is fenced when a place's name, parent, level, country, status
--   or deletion changes (import bookkeeping alone fences nothing); the cache
--   dependency triggers are generated from packages/shared/src/cache-deps.ts.
CREATE TABLE `places` (
	`id` text PRIMARY KEY NOT NULL,
	`country_code` text NOT NULL,
	`level` integer NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`external_ids` text NOT NULL,
	`metadata` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`source` text,
	`source_key` text,
	`source_version` text,
	`source_active` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`parent_id`) REFERENCES `places`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "places_country_shape" CHECK(length("places"."country_code") = 2 AND "places"."country_code" NOT GLOB '*[^A-Z]*'),
	CONSTRAINT "places_level_range" CHECK("places"."level" BETWEEN 1 AND 4)
);
--> statement-breakpoint
-- Every place carries over with its id: Bangladesh, its level from its type.
INSERT INTO `places` (`id`, `country_code`, `level`, `parent_id`, `name`, `external_ids`, `metadata`, `is_active`, `sort_order`, `created_at`, `updated_at`, `deleted_at`)
SELECT `id`, 'BD', CASE `type` WHEN 'city' THEN 1 WHEN 'zone' THEN 2 ELSE 3 END, `parent_id`, `name`, `external_ids`, `metadata`, `is_active`, `sort_order`, `created_at`, `updated_at`, `deleted_at`
FROM `delivery_locations`;
--> statement-breakpoint
-- Zone places reference places: the table is rebuilt with the same rows.
CREATE TABLE `__new_delivery_zone_locations` (
	`location_id` text PRIMARY KEY NOT NULL,
	`zone_id` text NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `places`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`zone_id`) REFERENCES `delivery_zones`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_delivery_zone_locations` (`location_id`, `zone_id`)
SELECT `location_id`, `zone_id` FROM `delivery_zone_locations`;
--> statement-breakpoint
DROP TABLE `delivery_zone_locations`;
--> statement-breakpoint
ALTER TABLE `__new_delivery_zone_locations` RENAME TO `delivery_zone_locations`;
--> statement-breakpoint
CREATE INDEX `delivery_zone_locations_zone_id_idx` ON `delivery_zone_locations` (`zone_id`);
--> statement-breakpoint
CREATE TRIGGER `delivery_zone_locations_checkout_authority_insert`
AFTER INSERT ON `delivery_zone_locations`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `delivery_zone_locations_checkout_authority_update`
AFTER UPDATE ON `delivery_zone_locations`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `delivery_zone_locations_checkout_authority_delete`
AFTER DELETE ON `delivery_zone_locations`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_delivery_zone_locations_ins` AFTER INSERT ON `delivery_zone_locations`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('ship', 't:delivery_zone_locations')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_delivery_zone_locations_del` AFTER DELETE ON `delivery_zone_locations`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('ship', 't:delivery_zone_locations')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_delivery_zone_locations_upd` AFTER UPDATE ON `delivery_zone_locations`
WHEN (OLD.`location_id` IS NOT NEW.`location_id` OR OLD.`zone_id` IS NOT NEW.`zone_id`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('ship', 't:delivery_zone_locations')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
-- The old table goes with its indexes and triggers; nothing references it now.
DROP TABLE `delivery_locations`;
--> statement-breakpoint
CREATE INDEX `places_parent_id_idx` ON `places` (`parent_id`);
--> statement-breakpoint
CREATE INDEX `places_country_level_idx` ON `places` (`country_code`,`level`);
--> statement-breakpoint
CREATE UNIQUE INDEX `places_country_source_key_uidx` ON `places` (`country_code`,`source_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `places_active_root_name_uidx` ON `places` (`country_code`,lower(trim("name"))) WHERE "places"."deleted_at" IS NULL AND "places"."is_active" = 1 AND "places"."parent_id" IS NULL AND "places"."level" = 1;
--> statement-breakpoint
CREATE UNIQUE INDEX `places_active_child_name_uidx` ON `places` (`parent_id`,`level`,lower(trim("name"))) WHERE "places"."deleted_at" IS NULL AND "places"."is_active" = 1 AND "places"."parent_id" IS NOT NULL;
--> statement-breakpoint
-- A top place has no parent; any other place's parent is one level up in the
-- same country. Clearing a parent (a hard-deleted parent's ON DELETE SET
-- NULL) is allowed.
CREATE TRIGGER `places_parent_guard_insert`
BEFORE INSERT ON `places`
WHEN (NEW.`level` = 1 AND NEW.`parent_id` IS NOT NULL) OR (NEW.`level` > 1 AND NOT EXISTS (SELECT 1 FROM `places` AS `parent_place` WHERE `parent_place`.`id` = NEW.`parent_id` AND `parent_place`.`country_code` = NEW.`country_code` AND `parent_place`.`level` = NEW.`level` - 1))
BEGIN
  SELECT RAISE(ABORT, 'PLACE_PARENT_INVALID');
END;
--> statement-breakpoint
CREATE TRIGGER `places_parent_guard_update`
BEFORE UPDATE OF `parent_id`, `level`, `country_code` ON `places`
WHEN NEW.`parent_id` IS NOT NULL AND (NEW.`parent_id` IS NOT OLD.`parent_id` OR NEW.`level` IS NOT OLD.`level` OR NEW.`country_code` IS NOT OLD.`country_code`) AND ((NEW.`level` = 1 AND NEW.`parent_id` IS NOT NULL) OR (NEW.`level` > 1 AND NOT EXISTS (SELECT 1 FROM `places` AS `parent_place` WHERE `parent_place`.`id` = NEW.`parent_id` AND `parent_place`.`country_code` = NEW.`country_code` AND `parent_place`.`level` = NEW.`level` - 1)))
BEGIN
  SELECT RAISE(ABORT, 'PLACE_PARENT_INVALID');
END;
--> statement-breakpoint
-- A checkout priced with a place reviews again when the place changes for
-- buyers (import bookkeeping and courier ids alone fence nothing).
CREATE TRIGGER `places_checkout_authority_insert`
AFTER INSERT ON `places`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `places_checkout_authority_update`
AFTER UPDATE ON `places`
WHEN NEW.`name` IS NOT OLD.`name` OR NEW.`parent_id` IS NOT OLD.`parent_id` OR NEW.`level` IS NOT OLD.`level` OR NEW.`country_code` IS NOT OLD.`country_code` OR NEW.`is_active` IS NOT OLD.`is_active` OR NEW.`deleted_at` IS NOT OLD.`deleted_at`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `places_checkout_authority_delete`
AFTER DELETE ON `places`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_places_ins` AFTER INSERT ON `places`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('loc', 't:places')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_places_del` AFTER DELETE ON `places`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('loc', 't:places')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_places_upd` AFTER UPDATE ON `places`
WHEN (OLD.`id` IS NOT NEW.`id` OR OLD.`country_code` IS NOT NEW.`country_code` OR OLD.`level` IS NOT NEW.`level` OR OLD.`parent_id` IS NOT NEW.`parent_id` OR OLD.`name` IS NOT NEW.`name` OR OLD.`external_ids` IS NOT NEW.`external_ids` OR OLD.`metadata` IS NOT NEW.`metadata` OR OLD.`is_active` IS NOT NEW.`is_active` OR OLD.`sort_order` IS NOT NEW.`sort_order` OR OLD.`created_at` IS NOT NEW.`created_at` OR OLD.`deleted_at` IS NOT NEW.`deleted_at`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('loc', 't:places')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (118, '0118_places', 'dc815805ef4e280f62f3ea15e0dd81b7e001cf246bdc34244cfd8a9f2f8286d1');
