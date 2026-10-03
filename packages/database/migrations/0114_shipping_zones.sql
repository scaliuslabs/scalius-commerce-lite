-- Markets step 3b (docs/MARKETS-DESIGN.md "Step 3b implemented"): shipping
-- zones by region, Shopify's model. A zone serves countries, admin areas and
-- postal-code prefixes (delivery_zone_regions, one zone per region) and
-- Bangladesh delivery locations (delivery_zone_locations, as before). An
-- address belongs to its most specific matching zone: Bangladesh location >
-- postal prefix > admin area > country; an address no zone matches gets no
-- delivery rate. The rates without a zone ("Everywhere else", which served
-- only Bangladesh) become the zone "Bangladesh" (dz_bd, the whole country):
-- the same rates, ids, fees and thresholds for the same addresses. Local
-- pickup stays store-wide (no zone); its revision document is renamed
-- delivery_pickup, and a trigger refuses a live delivery rate without a
-- zone. Agent storefront contexts keep the destination's country, admin
-- area and postal code. Region changes advance the checkout authority fence
-- and the ship cache dependency (generated from
-- packages/shared/src/cache-deps.ts).
CREATE TABLE `delivery_zone_regions` (
	`country_code` text NOT NULL,
	`admin_area` text DEFAULT '' NOT NULL,
	`postal_prefix` text DEFAULT '' NOT NULL,
	`zone_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	PRIMARY KEY(`country_code`, `admin_area`, `postal_prefix`),
	FOREIGN KEY (`zone_id`) REFERENCES `delivery_zones`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "delivery_zone_regions_country_shape" CHECK(length("delivery_zone_regions"."country_code") = 2 AND "delivery_zone_regions"."country_code" NOT GLOB '*[^A-Z]*'),
	CONSTRAINT "delivery_zone_regions_one_kind" CHECK("delivery_zone_regions"."admin_area" = '' OR "delivery_zone_regions"."postal_prefix" = ''),
	CONSTRAINT "delivery_zone_regions_admin_area_shape" CHECK(length("delivery_zone_regions"."admin_area") <= 120 AND "delivery_zone_regions"."admin_area" = trim("delivery_zone_regions"."admin_area")),
	CONSTRAINT "delivery_zone_regions_postal_prefix_shape" CHECK(length("delivery_zone_regions"."postal_prefix") <= 10 AND "delivery_zone_regions"."postal_prefix" NOT GLOB '*[^A-Z0-9]*')
);
--> statement-breakpoint
CREATE INDEX `delivery_zone_regions_zone_idx` ON `delivery_zone_regions` (`zone_id`);
--> statement-breakpoint
-- "Everywhere else" served Bangladesh addresses outside every zone: it
-- becomes the zone of the whole of Bangladesh, after the existing zones.
INSERT INTO `delivery_zones` (`id`, `name`, `sort_order`)
SELECT 'dz_bd', 'Bangladesh', coalesce((SELECT max(`sort_order`) FROM `delivery_zones`), -1) + 1
WHERE EXISTS (SELECT 1 FROM `shipping_methods` WHERE `zone_id` IS NULL AND `kind` = 'delivery' AND `deleted_at` IS NULL);
--> statement-breakpoint
INSERT INTO `delivery_zone_regions` (`country_code`, `admin_area`, `postal_prefix`, `zone_id`)
SELECT 'BD', '', '', 'dz_bd' WHERE EXISTS (SELECT 1 FROM `delivery_zones` WHERE `id` = 'dz_bd');
--> statement-breakpoint
UPDATE `shipping_methods` SET `zone_id` = 'dz_bd'
WHERE `zone_id` IS NULL AND `kind` = 'delivery' AND `deleted_at` IS NULL;
--> statement-breakpoint
-- The revision of the store-wide rates now guards local pickup alone.
UPDATE `settings` SET `category` = 'delivery_pickup'
WHERE `category` = 'delivery_everywhere_else' AND `key` = 'document';
--> statement-breakpoint
-- A live delivery rate belongs to a zone: only local pickup is store-wide.
CREATE TRIGGER `shipping_methods_delivery_zone_required_insert`
BEFORE INSERT ON `shipping_methods`
WHEN NEW.`kind` = 'delivery' AND NEW.`zone_id` IS NULL AND NEW.`deleted_at` IS NULL
BEGIN
  SELECT RAISE(ABORT, 'SHIPPING_RATE_ZONE_REQUIRED');
END;
--> statement-breakpoint
CREATE TRIGGER `shipping_methods_delivery_zone_required_update`
BEFORE UPDATE OF `kind`, `zone_id`, `deleted_at` ON `shipping_methods`
WHEN NEW.`kind` = 'delivery' AND NEW.`zone_id` IS NULL AND NEW.`deleted_at` IS NULL
BEGIN
  SELECT RAISE(ABORT, 'SHIPPING_RATE_ZONE_REQUIRED');
END;
--> statement-breakpoint
-- A zone's regions decide which rates a buyer gets: every change advances
-- the checkout authority revision (as zone locations do).
CREATE TRIGGER `delivery_zone_regions_checkout_authority_insert`
AFTER INSERT ON `delivery_zone_regions`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `delivery_zone_regions_checkout_authority_update`
AFTER UPDATE ON `delivery_zone_regions`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `delivery_zone_regions_checkout_authority_delete`
AFTER DELETE ON `delivery_zone_regions`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_delivery_zone_regions_ins` AFTER INSERT ON `delivery_zone_regions`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('ship', 't:delivery_zone_regions')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_delivery_zone_regions_del` AFTER DELETE ON `delivery_zone_regions`
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('ship', 't:delivery_zone_regions')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
CREATE TRIGGER `cdep_delivery_zone_regions_upd` AFTER UPDATE ON `delivery_zone_regions`
WHEN (OLD.`country_code` IS NOT NEW.`country_code` OR OLD.`admin_area` IS NOT NEW.`admin_area` OR OLD.`postal_prefix` IS NOT NEW.`postal_prefix` OR OLD.`zone_id` IS NOT NEW.`zone_id`)
BEGIN
  INSERT INTO `cache_dep` (`dep`, `seq`)
  SELECT key_rows.dep, COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 FROM (SELECT key_list.value AS dep FROM json_each(json_array('ship', 't:delivery_zone_regions')) AS key_list) AS key_rows
  WHERE key_rows.dep IS NOT NULL AND COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 0
  UNION ALL SELECT 'store', COALESCE((SELECT `seq` FROM `cache_clock` WHERE `id` = 1), 0) + 1 WHERE COALESCE((SELECT `coarse` FROM `cache_clock` WHERE `id` = 1), 0) = 1
  ON CONFLICT (`dep`) DO UPDATE SET `seq` = excluded.`seq`;
END;
--> statement-breakpoint
-- An agent's storefront context prices one destination: its country (null
-- is Bangladesh) and another country's admin area and postal code beside
-- Bangladesh's City/Thana/Area ids.
ALTER TABLE `agent_storefront_contexts` ADD `country_code` text CONSTRAINT `agent_storefront_contexts_country_shape` CHECK (`country_code` IS NULL OR (length(`country_code`) = 2 AND `country_code` NOT GLOB '*[^A-Z]*'));
--> statement-breakpoint
ALTER TABLE `agent_storefront_contexts` ADD `admin_area` text;
--> statement-breakpoint
ALTER TABLE `agent_storefront_contexts` ADD `postal_code` text;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (114, '0114_shipping_zones', '26615b7089869e68377d7a7b14f7a6d644c01597c0311c81a10d362ee682da22');
