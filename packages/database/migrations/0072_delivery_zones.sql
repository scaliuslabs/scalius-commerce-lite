-- Delivery zones: a zone groups cities, zones and areas; its rates (the
-- shipping_methods rows with its zone_id) apply to buyer addresses that
-- resolve to it. Rates without a zone are the "Everywhere else" rates, so
-- existing flat charges keep working unchanged. Rate names are unique per zone.
CREATE TABLE `delivery_zones` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `delivery_zone_locations` (
	`location_id` text PRIMARY KEY NOT NULL,
	`zone_id` text NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `delivery_locations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`zone_id`) REFERENCES `delivery_zones`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `delivery_zone_locations_zone_id_idx` ON `delivery_zone_locations` (`zone_id`);
--> statement-breakpoint
ALTER TABLE `shipping_methods` ADD `zone_id` text REFERENCES delivery_zones(id) ON DELETE set null;
--> statement-breakpoint
ALTER TABLE `shipping_methods` ADD `free_over_minor` integer;
--> statement-breakpoint
ALTER TABLE `shipping_methods` ADD `pickup_address` text;
--> statement-breakpoint
ALTER TABLE `shipping_methods` ADD `pickup_hours` text;
--> statement-breakpoint
-- Local pickup is store-wide (no zone) and always has an address buyers can find.
ALTER TABLE `shipping_methods` ADD `kind` text DEFAULT 'delivery' NOT NULL CONSTRAINT `shipping_methods_kind_check` CHECK (`kind` = 'delivery' OR (`kind` = 'pickup' AND `zone_id` IS NULL AND length(trim(coalesce(`pickup_address`, ''))) > 0));
--> statement-breakpoint
DROP INDEX `shipping_methods_name_unique`;
--> statement-breakpoint
CREATE INDEX `shipping_methods_zone_id_idx` ON `shipping_methods` (`zone_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `shipping_methods_zone_name_uidx` ON `shipping_methods` (coalesce("zone_id", ''),lower(trim("name"))) WHERE "shipping_methods"."deleted_at" IS NULL;
--> statement-breakpoint
-- Zone membership decides which rates a buyer gets, so every change advances
-- the checkout authority revision (shipping_methods already does).
CREATE TRIGGER `delivery_zones_checkout_authority_insert`
AFTER INSERT ON `delivery_zones`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `delivery_zones_checkout_authority_update`
AFTER UPDATE ON `delivery_zones`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
--> statement-breakpoint
CREATE TRIGGER `delivery_zones_checkout_authority_delete`
AFTER DELETE ON `delivery_zones`
BEGIN
  UPDATE `checkout_authority` SET `revision` = `revision` + 1, `updated_at` = unixepoch() WHERE `id` = 'default';
END;
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
ALTER TABLE `checkout_languages` ADD `revision` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (72, '0072_delivery_zones', 'd30f2fc33db16f5c02a5b8be890d9cad078975edf126d6fc6b14c2c33d77cafd');
