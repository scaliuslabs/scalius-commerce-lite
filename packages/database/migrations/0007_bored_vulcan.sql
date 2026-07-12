-- Normalized product options and direct SKU media cutover.
--
-- The catalog in this installation is demo data. The cutover intentionally
-- resets sellable SKU and inventory-demo rows instead of preserving the legacy
-- two-column option and positional image-mapping representations. Historical
-- order item snapshots remain, but their retired demo variant references are
-- cleared before the SKU table is rebuilt.

PRAGMA foreign_keys=OFF;
--> statement-breakpoint

DELETE FROM `inventory_movements`;
--> statement-breakpoint
DELETE FROM `product_low_stock_alerts`;
--> statement-breakpoint
UPDATE `order_items` SET `variant_id` = NULL WHERE `variant_id` IS NOT NULL;
--> statement-breakpoint

DROP TRIGGER IF EXISTS `product_variants_fts_after_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_variants_fts_after_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_variants_fts_before_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_variants_fts_before_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_variants_identity_insert_guard`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_variants_identity_update_guard`;
--> statement-breakpoint
DROP TABLE `product_variant_image_mappings`;
--> statement-breakpoint

CREATE TABLE `product_option_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`position` integer NOT NULL,
	`standard_mapping` text DEFAULT 'none' NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_option_definitions_name_check" CHECK(`name` = trim(`name`) AND `name` <> ''),
	CONSTRAINT "product_option_definitions_normalized_name_check" CHECK(`normalized_name` = lower(trim(`name`))),
	CONSTRAINT "product_option_definitions_position_check" CHECK(`position` >= 0 AND `position` < 5)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_option_definitions_name_uidx` ON `product_option_definitions` (`product_id`,`normalized_name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_option_definitions_position_uidx` ON `product_option_definitions` (`product_id`,`position`);
--> statement-breakpoint
CREATE INDEX `product_option_definitions_product_idx` ON `product_option_definitions` (`product_id`,`position`);
--> statement-breakpoint

CREATE TABLE `product_option_values` (
	`id` text PRIMARY KEY NOT NULL,
	`option_definition_id` text NOT NULL,
	`value` text NOT NULL,
	`normalized_value` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`option_definition_id`) REFERENCES `product_option_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_option_values_value_check" CHECK(`value` = trim(`value`) AND `value` <> ''),
	CONSTRAINT "product_option_values_normalized_value_check" CHECK(`normalized_value` = lower(trim(`value`))),
	CONSTRAINT "product_option_values_position_check" CHECK(`position` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_option_values_value_uidx` ON `product_option_values` (`option_definition_id`,`normalized_value`);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_option_values_position_uidx` ON `product_option_values` (`option_definition_id`,`position`);
--> statement-breakpoint
CREATE INDEX `product_option_values_definition_idx` ON `product_option_values` (`option_definition_id`,`position`);
--> statement-breakpoint

CREATE TABLE `__new_product_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`option_combination_key` text,
	`image_id` text,
	`weight` real,
	`sku` text NOT NULL,
	`price` real NOT NULL,
	`stock` integer DEFAULT 0 NOT NULL,
	`reserved_stock` integer DEFAULT 0 NOT NULL,
	`preorder_stock` integer DEFAULT 0 NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`track_inventory` integer DEFAULT true NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`stock_version` integer DEFAULT 1 NOT NULL,
	`low_stock_threshold` integer,
	`allow_preorder` integer DEFAULT false NOT NULL,
	`preorder_date` text,
	`preorder_message` text,
	`allow_backorder` integer DEFAULT false NOT NULL,
	`backorder_limit` integer DEFAULT 0 NOT NULL,
	`tax_class_id` text,
	`tax_classification_version` integer DEFAULT 1 NOT NULL,
	`discount_percentage` real DEFAULT 0,
	`discount_type` text DEFAULT 'percentage',
	`discount_amount` real DEFAULT 0,
	`barcode` text,
	`barcode_type` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`image_id`) REFERENCES `product_images`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`tax_class_id`) REFERENCES `tax_classes`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "product_variants_option_topology_check" CHECK((
		(`is_default` = true AND `option_combination_key` IS NULL)
		OR
		(`is_default` = false AND trim(coalesce(`option_combination_key`, '')) <> '')
	))
);
--> statement-breakpoint

-- Every retained product receives one clean protected default SKU. Optioned
-- demo products are created after deployment through the new aggregate API.
INSERT INTO `__new_product_variants` (
	`id`, `product_id`, `option_combination_key`, `image_id`, `weight`, `sku`,
	`price`, `stock`, `reserved_stock`, `preorder_stock`, `is_default`,
	`track_inventory`, `version`, `stock_version`, `tax_class_id`,
	`tax_classification_version`, `discount_percentage`, `discount_type`,
	`discount_amount`, `created_at`, `updated_at`
)
SELECT
	'var_demo_' || `id`, `id`, NULL, NULL, NULL, 'DEMO-' || `id`,
	`price`, 0, 0, 0, true, true, 1, 1, `tax_class_id`,
	`tax_classification_version`, `discount_percentage`, `discount_type`,
	`discount_amount`, unixepoch(), unixepoch()
FROM `products`;
--> statement-breakpoint

DROP TABLE `product_variants`;
--> statement-breakpoint
ALTER TABLE `__new_product_variants` RENAME TO `product_variants`;
--> statement-breakpoint

CREATE TABLE `product_variant_option_values` (
	`variant_id` text NOT NULL,
	`option_definition_id` text NOT NULL,
	`option_value_id` text NOT NULL,
	PRIMARY KEY(`variant_id`, `option_definition_id`),
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`option_definition_id`) REFERENCES `product_option_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`option_value_id`) REFERENCES `product_option_values`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_variant_option_values_value_uidx` ON `product_variant_option_values` (`variant_id`,`option_value_id`);
--> statement-breakpoint
CREATE INDEX `product_variant_option_values_definition_idx` ON `product_variant_option_values` (`option_definition_id`,`option_value_id`);
--> statement-breakpoint
CREATE INDEX `product_variant_option_values_value_idx` ON `product_variant_option_values` (`option_value_id`,`variant_id`);
--> statement-breakpoint

CREATE INDEX `product_variants_product_id_idx` ON `product_variants` (`product_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_variants_sku_identity_uidx` ON `product_variants` (lower(trim(`sku`)));
--> statement-breakpoint
CREATE UNIQUE INDEX `product_variants_barcode_identity_uidx` ON `product_variants` (lower(trim(`barcode`))) WHERE `barcode` IS NOT NULL AND trim(`barcode`) <> '';
--> statement-breakpoint
CREATE UNIQUE INDEX `product_variants_active_option_identity_uidx` ON `product_variants` (`product_id`,`option_combination_key`) WHERE `deleted_at` IS NULL AND `is_default` = false;
--> statement-breakpoint
CREATE UNIQUE INDEX `product_variants_one_default_per_product_idx` ON `product_variants` (`product_id`) WHERE `is_default` = true AND `deleted_at` IS NULL;
--> statement-breakpoint
CREATE INDEX `product_variants_default_idx` ON `product_variants` (`product_id`,`is_default`,`deleted_at`);
--> statement-breakpoint
CREATE INDEX `product_variants_image_idx` ON `product_variants` (`image_id`);
--> statement-breakpoint
CREATE INDEX `product_variants_track_inventory_idx` ON `product_variants` (`track_inventory`,`deleted_at`);
--> statement-breakpoint

CREATE TRIGGER `product_variants_identity_insert_guard`
BEFORE INSERT ON `product_variants`
WHEN trim(coalesce(NEW.`sku`, '')) = ''
	OR NEW.`sku` <> trim(NEW.`sku`)
	OR (NEW.`is_default` = 1 AND NEW.`option_combination_key` IS NOT NULL)
	OR (NEW.`is_default` = 0 AND trim(coalesce(NEW.`option_combination_key`, '')) = '')
	OR ((NEW.`barcode` IS NULL) <> (NEW.`barcode_type` IS NULL))
	OR (NEW.`image_id` IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM `product_images`
		WHERE `id` = NEW.`image_id` AND `product_id` = NEW.`product_id`
	))
BEGIN
	SELECT RAISE(ABORT, 'INVALID_PRODUCT_VARIANT_IDENTITY');
END;
--> statement-breakpoint
CREATE TRIGGER `product_variants_identity_update_guard`
BEFORE UPDATE OF `sku`, `option_combination_key`, `is_default`, `barcode`, `barcode_type`, `image_id`, `product_id` ON `product_variants`
WHEN trim(coalesce(NEW.`sku`, '')) = ''
	OR NEW.`sku` <> trim(NEW.`sku`)
	OR (NEW.`is_default` = 1 AND NEW.`option_combination_key` IS NOT NULL)
	OR (NEW.`is_default` = 0 AND trim(coalesce(NEW.`option_combination_key`, '')) = '')
	OR ((NEW.`barcode` IS NULL) <> (NEW.`barcode_type` IS NULL))
	OR (NEW.`image_id` IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM `product_images`
		WHERE `id` = NEW.`image_id` AND `product_id` = NEW.`product_id`
	))
BEGIN
	SELECT RAISE(ABORT, 'INVALID_PRODUCT_VARIANT_IDENTITY');
END;
--> statement-breakpoint

CREATE TRIGGER `product_variant_option_values_insert_guard`
BEFORE INSERT ON `product_variant_option_values`
WHEN NOT EXISTS (
	SELECT 1
	FROM `product_variants` AS `pv`
	JOIN `product_option_definitions` AS `pod` ON `pod`.`id` = NEW.`option_definition_id`
	JOIN `product_option_values` AS `pov` ON `pov`.`id` = NEW.`option_value_id`
	WHERE `pv`.`id` = NEW.`variant_id`
		AND `pv`.`is_default` = false
		AND `pv`.`product_id` = `pod`.`product_id`
		AND `pov`.`option_definition_id` = `pod`.`id`
)
BEGIN
	SELECT RAISE(ABORT, 'INVALID_PRODUCT_VARIANT_OPTION_ASSIGNMENT');
END;
--> statement-breakpoint
CREATE TRIGGER `product_variant_option_values_update_guard`
BEFORE UPDATE ON `product_variant_option_values`
WHEN NOT EXISTS (
	SELECT 1
	FROM `product_variants` AS `pv`
	JOIN `product_option_definitions` AS `pod` ON `pod`.`id` = NEW.`option_definition_id`
	JOIN `product_option_values` AS `pov` ON `pov`.`id` = NEW.`option_value_id`
	WHERE `pv`.`id` = NEW.`variant_id`
		AND `pv`.`is_default` = false
		AND `pv`.`product_id` = `pod`.`product_id`
		AND `pov`.`option_definition_id` = `pod`.`id`
)
BEGIN
	SELECT RAISE(ABORT, 'INVALID_PRODUCT_VARIANT_OPTION_ASSIGNMENT');
END;
--> statement-breakpoint

CREATE TRIGGER `product_variants_fts_after_insert` AFTER INSERT ON `product_variants` BEGIN
	INSERT INTO `product_variants_fts`(rowid, sku) VALUES (new.rowid, new.sku);
END;
--> statement-breakpoint
CREATE TRIGGER `product_variants_fts_after_update` AFTER UPDATE ON `product_variants` BEGIN
	INSERT INTO `product_variants_fts`(rowid, sku) VALUES (new.rowid, new.sku);
END;
--> statement-breakpoint
CREATE TRIGGER `product_variants_fts_before_delete` BEFORE DELETE ON `product_variants` BEGIN
	INSERT INTO `product_variants_fts`(`product_variants_fts`, rowid, sku) VALUES('delete', old.rowid, old.sku);
END;
--> statement-breakpoint
CREATE TRIGGER `product_variants_fts_before_update` BEFORE UPDATE ON `product_variants` BEGIN
	INSERT INTO `product_variants_fts`(`product_variants_fts`, rowid, sku) VALUES('delete', old.rowid, old.sku);
END;
--> statement-breakpoint
INSERT INTO `product_variants_fts`(`product_variants_fts`) VALUES('rebuild');
--> statement-breakpoint

DROP TRIGGER IF EXISTS `products_variant_image_axis_insert_guard`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `products_variant_image_axis_update_guard`;
--> statement-breakpoint
ALTER TABLE `products` DROP COLUMN `variant_option_1_label`;
--> statement-breakpoint
ALTER TABLE `products` DROP COLUMN `variant_option_2_label`;
--> statement-breakpoint
ALTER TABLE `products` DROP COLUMN `variant_option_1_schema`;
--> statement-breakpoint
ALTER TABLE `products` DROP COLUMN `variant_option_2_schema`;
--> statement-breakpoint
ALTER TABLE `products` DROP COLUMN `variant_images_enabled`;
--> statement-breakpoint
ALTER TABLE `products` DROP COLUMN `variant_image_axis`;
--> statement-breakpoint

UPDATE `products`
SET `aggregate_revision` = `aggregate_revision` + 1;
--> statement-breakpoint

PRAGMA foreign_keys=ON;
