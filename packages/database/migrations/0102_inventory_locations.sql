-- Inventory locations (commerce hook H1, docs/platform/COMMERCE-HOOKS.md).
-- Locations hold physical stock; inventory_levels is the per-SKU, per-location
-- on-hand, kept by triggers from ledger-v2 movements only. Reservations stay
-- location-agnostic. No backward compatibility: every existing SKU's stock is
-- booked at the new default location, and so is every past stock movement.
CREATE TABLE `inventory_locations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`code` text NOT NULL,
	`kind` text DEFAULT 'warehouse' NOT NULL,
	`address_line1` text,
	`address_line2` text,
	`city` text,
	`postal_code` text,
	`country_code` text DEFAULT 'BD' NOT NULL,
	`phone` text,
	`is_default` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	CONSTRAINT "inventory_locations_name_length" CHECK(length(trim("inventory_locations"."name")) BETWEEN 1 AND 80),
	CONSTRAINT "inventory_locations_code_length" CHECK(length(trim("inventory_locations"."code")) BETWEEN 1 AND 24),
	CONSTRAINT "inventory_locations_kind_check" CHECK("inventory_locations"."kind" IN ('warehouse', 'store', 'other')),
	CONSTRAINT "inventory_locations_status_check" CHECK("inventory_locations"."status" IN ('active', 'archived')),
	CONSTRAINT "inventory_locations_default_active" CHECK("inventory_locations"."is_default" = 0 OR "inventory_locations"."status" = 'active'),
	CONSTRAINT "inventory_locations_version_positive" CHECK("inventory_locations"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_locations_code_unique` ON `inventory_locations` (lower(trim("code")));
--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_locations_default_unique` ON `inventory_locations` (`is_default`) WHERE "inventory_locations"."is_default" = 1;
--> statement-breakpoint
CREATE INDEX `inventory_locations_status_position_idx` ON `inventory_locations` (`status`,`position`);
--> statement-breakpoint
CREATE TABLE `inventory_levels` (
	`variant_id` text NOT NULL,
	`location_id` text NOT NULL,
	`on_hand` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	PRIMARY KEY(`variant_id`, `location_id`),
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`location_id`) REFERENCES `inventory_locations`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "inventory_levels_on_hand_nonnegative" CHECK("inventory_levels"."on_hand" >= 0)
);
--> statement-breakpoint
CREATE INDEX `inventory_levels_location_idx` ON `inventory_levels` (`location_id`,`on_hand`);
--> statement-breakpoint
ALTER TABLE `inventory_movements` ADD `location_id` text REFERENCES inventory_locations(id) ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE `orders` ADD `fulfillment_location_id` text REFERENCES inventory_locations(id) ON DELETE restrict;
--> statement-breakpoint
CREATE INDEX `orders_fulfillment_location_idx` ON `orders` (`fulfillment_location_id`,`inventory_action`) WHERE "orders"."fulfillment_location_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `order_fulfillments` ADD `location_id` text REFERENCES inventory_locations(id) ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE `order_return_receipt_lines` ADD `restock_location_id` text REFERENCES inventory_locations(id) ON DELETE restrict;
--> statement-breakpoint
-- >>> H1 inventory locations: triggers and backfill
-- The default location. Settings → Locations can rename it, add others and
-- move the default; exactly one active location is always the default.
INSERT INTO `inventory_locations` (`id`, `name`, `code`, `kind`, `is_default`, `status`, `position`, `version`)
VALUES ('loc_default', 'Main location', 'MAIN', 'warehouse', 1, 'active', 0, 1);
--> statement-breakpoint
-- Every SKU's on-hand is at the default location, trashed SKUs included so a
-- restored SKU keeps sum(levels) = stock.
INSERT INTO `inventory_levels` (`variant_id`, `location_id`, `on_hand`, `updated_at`)
SELECT `id`, 'loc_default', `stock`, unixepoch() FROM `product_variants` WHERE `stock` > 0;
--> statement-breakpoint
-- Past physical movements happened at the only location there was; deducts
-- carry it so a later restore returns units there.
UPDATE `inventory_movements` SET `location_id` = 'loc_default'
WHERE (`ledger_version` = 2 AND `stock_delta` <> 0) OR `type` IN ('deducted', 'preorder_deducted', 'restored');
--> statement-breakpoint
UPDATE `order_return_receipt_lines` SET `restock_location_id` = 'loc_default' WHERE `restock_quantity` > 0;
--> statement-breakpoint
-- Fulfilments stay immutable except active -> voided; the guard now also
-- covers location_id. Past ship/pickup fulfilments left from the default.
DROP TRIGGER `order_fulfillments_update_guard`;
--> statement-breakpoint
UPDATE `order_fulfillments` SET `location_id` = 'loc_default' WHERE `kind` IN ('ship', 'pickup');
--> statement-breakpoint
CREATE TRIGGER `order_fulfillments_update_guard`
BEFORE UPDATE ON `order_fulfillments`
WHEN NOT (
  OLD.`status` = 'active'
  AND NEW.`status` = 'voided'
  AND NEW.`id` IS OLD.`id`
  AND NEW.`order_id` IS OLD.`order_id`
  AND NEW.`kind` IS OLD.`kind`
  AND NEW.`shipment_id` IS OLD.`shipment_id`
  AND NEW.`request_key` IS OLD.`request_key`
  AND NEW.`actor_type` IS OLD.`actor_type`
  AND NEW.`actor_id` IS OLD.`actor_id`
  AND NEW.`cash_collected_minor` IS OLD.`cash_collected_minor`
  AND NEW.`created_at` IS OLD.`created_at`
  AND NEW.`location_id` IS OLD.`location_id`
)
BEGIN
  SELECT RAISE(ABORT, 'fulfilments are immutable except active to voided');
END;
--> statement-breakpoint
-- A ledger-v2 movement that changes physical stock names an active location.
CREATE TRIGGER `inventory_movements_location_required`
BEFORE INSERT ON `inventory_movements`
WHEN NEW.`ledger_version` = 2 AND NEW.`stock_delta` <> 0 AND (
  NEW.`location_id` IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM `inventory_locations` AS l
    WHERE l.`id` = NEW.`location_id` AND l.`status` = 'active'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'INVENTORY_LOCATION_REQUIRED');
END;
--> statement-breakpoint
-- A removal needs the units at that location; the whole batch aborts
-- otherwise (the on_hand CHECK is the backstop for concurrent writers).
CREATE TRIGGER `inventory_movements_level_shortfall`
BEFORE INSERT ON `inventory_movements`
WHEN NEW.`ledger_version` = 2 AND NEW.`location_id` IS NOT NULL AND NEW.`stock_delta` < 0 AND NOT EXISTS (
  SELECT 1 FROM `inventory_levels` AS lv
  WHERE lv.`variant_id` = NEW.`variant_id`
    AND lv.`location_id` = NEW.`location_id`
    AND lv.`on_hand` + NEW.`stock_delta` >= 0
)
BEGIN
  SELECT RAISE(ABORT, 'INVENTORY_LEVEL_SHORTFALL');
END;
--> statement-breakpoint
-- Units in: create or raise the level. (The inserted row is positive, so the
-- on_hand CHECK holds before the conflict resolves.)
CREATE TRIGGER `inventory_movements_level_receive`
AFTER INSERT ON `inventory_movements`
WHEN NEW.`ledger_version` = 2 AND NEW.`location_id` IS NOT NULL AND NEW.`stock_delta` > 0
BEGIN
  INSERT INTO `inventory_levels` (`variant_id`, `location_id`, `on_hand`, `updated_at`)
  VALUES (NEW.`variant_id`, NEW.`location_id`, NEW.`stock_delta`, unixepoch())
  ON CONFLICT (`variant_id`, `location_id`) DO UPDATE SET
    `on_hand` = `inventory_levels`.`on_hand` + excluded.`on_hand`,
    `updated_at` = excluded.`updated_at`;
END;
--> statement-breakpoint
-- Units out: lower the level the shortfall guard proved exists.
CREATE TRIGGER `inventory_movements_level_remove`
AFTER INSERT ON `inventory_movements`
WHEN NEW.`ledger_version` = 2 AND NEW.`location_id` IS NOT NULL AND NEW.`stock_delta` < 0
BEGIN
  UPDATE `inventory_levels`
  SET `on_hand` = `on_hand` + NEW.`stock_delta`, `updated_at` = unixepoch()
  WHERE `variant_id` = NEW.`variant_id` AND `location_id` = NEW.`location_id`;
END;
--> statement-breakpoint
-- A compensating delete of an unapplied movement takes its units back out.
CREATE TRIGGER `inventory_movements_level_revert`
AFTER DELETE ON `inventory_movements`
WHEN OLD.`ledger_version` = 2 AND OLD.`location_id` IS NOT NULL AND OLD.`stock_delta` <> 0
BEGIN
  UPDATE `inventory_levels`
  SET `on_hand` = `on_hand` - OLD.`stock_delta`, `updated_at` = unixepoch()
  WHERE `variant_id` = OLD.`variant_id` AND `location_id` = OLD.`location_id`;
END;
--> statement-breakpoint
-- Where and how much a v2 movement moved is what the levels were built
-- from: it never changes after insert.
CREATE TRIGGER `inventory_movements_level_immutable`
BEFORE UPDATE ON `inventory_movements`
WHEN OLD.`ledger_version` = 2 AND (
  NEW.`location_id` IS NOT OLD.`location_id`
  OR NEW.`stock_delta` IS NOT OLD.`stock_delta`
  OR NEW.`variant_id` IS NOT OLD.`variant_id`
  OR NEW.`ledger_version` IS NOT OLD.`ledger_version`
)
BEGIN
  SELECT RAISE(ABORT, 'inventory movement location and stock delta are immutable');
END;
--> statement-breakpoint
-- A SKU inserted with stock (seeds, imports) holds it at the default
-- location, so sum(levels) = stock from its first row. The product editor
-- inserts SKUs at 0 and books stock through ledger movements.
CREATE TRIGGER `product_variants_level_seed`
AFTER INSERT ON `product_variants`
WHEN NEW.`stock` > 0
BEGIN
  INSERT INTO `inventory_levels` (`variant_id`, `location_id`, `on_hand`, `updated_at`)
  SELECT NEW.`id`, l.`id`, NEW.`stock`, unixepoch()
  FROM `inventory_locations` AS l
  WHERE l.`is_default` = 1 AND l.`status` = 'active';
END;
-- <<< H1
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (102, '0102_inventory_locations', '1f73c0787bbccbb214b024e342655975a60ee81f75321d8d21bdd33eca52e22f');
